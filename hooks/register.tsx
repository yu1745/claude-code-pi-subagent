import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Live } from '../types'
import {
  type Activity,
  type RunStats,
  KILL_TREE,
  SUPERVISION_NOTE,
  THINKING_LEVELS,
  WATCH_DEFAULT_S,
  WATCH_MAX_S,
  WATCH_MIN_S,
  activityPage,
  clampInterval,
  clip,
  detailPage,
  DEFAULT_NOTE,
  dialogId,
  digest,
  findAgentWorktree,
  hasThinkingSuffix,
  missingWorktreeAdvice,
  type ModelInfo,
  parseDefault,
  parseModelList,
  parseWorktrees,
  resolveScoped,
  scopeModels,
  scopedNote,
  isReadOnlyType,
  newStats,
  piArgv,
  piStderr,
  pushActivity,
  resolveAgent,
  rpc,
  splitBeats,
  splitType,
  totalTokens,
  worktreeFooter,
  worktreePreface,

  piVersionNote,
  watchSection,
} from './core'

// The subagent itself is the engine's own (tasks list, transcript, notification,
// worktree, TaskStop, resume): only its model requests are answered by pi.
const AGENT_HEAD = `

Subagents here think with pi on third-party models by default: the engine runs the agent as usual (tasks list, worktree, notification, resume), and its model is pi. A fork, a remote agent, or a call that sets the \`model\` parameter (sonnet, opus, haiku, fable) or appends \`@claude\` to subagent_type runs on Claude instead.

An agent with \`isolation: "worktree"\` that pi runs gets its own git worktree. Before pi starts, the mod points it at the session's current HEAD commit (uncommitted changes in the main checkout are not in it), tells pi the worktree's path and to stay inside it, and ends the answer with the worktree's path and branch. A Claude-run agent's worktree is Claude Code's own, created from origin/main.`

const AGENT_TAIL = `
- \`effort\` sets pi's thinking level when the model carries no \`:<thinking>\`.
- SendMessage to an agent while it works steers it (pi reads it after its current tool calls); after it finished, SendMessage resumes it as usual. TaskStop stops it.
- Supervision (opt-in; third-party models can drift or stall): mcp__pi-subagent__subagent_activity reads its recent activity without consuming anything; mcp__pi-subagent__watch_subagent sends you periodic activity evidence while it works. Do not poll by default.`

const ANY_MODEL_NOTE =
  `- Model: append \`@<provider>/<model>\` to subagent_type (\`general-purpose@codebuddy/glm-5.3\`), optionally \`:<thinking>\`; omitted, pi's default. \`pi --list-models <search>\` in Bash lists models.\n- ${DEFAULT_NOTE}`

// The models subagents may use: pi's scoped models (`enabledModels`, the project's
// over the user's), with pi's own facts on each; none scoped, any model goes.
type Scope = { models: ModelInfo[]; fallback?: string }
let scope: Promise<Scope> | undefined

// pi's settings, the project's over the user's.
async function readPiSettings($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  type PiSettings = { enabledModels?: string[]; defaultProvider?: string; defaultModel?: string }
  const readJson = async (path: string): Promise<PiSettings> =>
    (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as PiSettings) : {}
  const user = await readJson(`${home}/.pi/agent/settings.json`).catch((): PiSettings => ({}))
  const project = await readJson('.pi/settings.json').catch((): PiSettings => ({}))
  return {
    enabled: project.enabledModels?.length ? project.enabledModels : (user.enabledModels ?? []),
    provider: project.defaultProvider ?? user.defaultProvider,
    name: project.defaultModel ?? user.defaultModel,
  }
}

// pi's default model among the scoped ones; the first scoped one when pi names none of them.
function defaultOf(models: readonly ModelInfo[], provider?: string, name?: string) {
  const preferred = provider && name ? resolveScoped(`${provider}/${name}`, models) : undefined
  return preferred && 'model' in preferred ? preferred.model : models[0]?.id
}

async function readScope($: EngineInterface): Promise<Scope> {
  const { enabled, provider, name } = await readPiSettings($)
  if (!enabled.length) return { models: [] }
  const listed = await $.process.run(['pi', '--list-models'], { timeoutMs: 120_000 }).then(r => parseModelList(r.stdout), () => [])
  const models = scopeModels(enabled, listed)
  return { models, fallback: defaultOf(models, provider, name) }
}

const ACTIVITY_TOOL = 'mcp__pi-subagent__subagent_activity'
const WATCH_TOOL = 'mcp__pi-subagent__watch_subagent'
const WATCH_TAG = '<pi-subagent-watch>'
const LIVE = { plugin: 'pi-subagent', key: 'live' } as const
const LIVE_LINES = 40
const LIVE_MARK: Record<string, { mark: string; color: string }> = {
  tool: { mark: '⏺', color: 'suggestion' },
  result: { mark: '⎿', color: 'subtle' },
  text: { mark: '◆', color: 'claude' },
  error: { mark: '✗', color: 'error' },
  retry: { mark: '↻', color: 'warning' },
  note: { mark: '·', color: 'subtle' },
}

type Watch = { intervalS: number; brief?: string; criteria?: string; cursor: number; timer: { cancel: () => void } }

// How a subagent's pi is configured, kept in $.store so a resume after a reload still uses pi.
type Kept = {
  id: string
  name?: string
  type: string
  description: string
  model?: string
  thinking?: string
  readOnly: boolean
  isolated: boolean
  // The caller's checkout, read where the Agent call was made: what an isolated
  // agent's worktree is pointed at and pi is told to keep out of.
  repo?: string
  // The commit its worktree was pointed at: set once pi has started in it.
  based?: string
}

type Agent = Kept & {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped'
  bornAt: number
  runStartedAt: number
  pid?: string
  cmdFile?: string
  lastTool?: string
  worktree?: { path: string; branch?: string }
  // This run could not start pi (no worktree): retrying in the same session does not help.
  notStarted?: boolean
  // This run yielded a beat, so its answer's text is block 1, not 0.
  beaten?: boolean
  events: Activity[]
  seq: number
  stats: RunStats
  // User rows the engine appended to the agent's conversation since its last step.
  inbox: string[]
  watch?: Watch
  // A band write in flight, and whether another is owed after it.
  publishing?: boolean
  republish?: boolean
}

// What an Agent call asked for, until its spawn names the agent.
type Asked = Omit<Kept, 'id' | 'description'>

const asked = new Map<string, Asked>()
const agents = new Map<string, Agent>()
const sections = new Map<string, { text: string; cursor: number }>()
let delivering = false
// Whether the main loop is mid-turn: a watch notice then joins the running turn
// instead of starting one. Every main model request says so again, so a reload
// mid-turn learns it at the next request.
let mainBusy = false

async function subagentDir($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? '/tmp'}/.pi/claude-subagents`
}

async function appendLine($: EngineInterface, file: string, text: string) {
  const ran = await $.process.run(['bash', '-c', 'printf "%s\\n" "$1" >> "$2"', 'pi-subagent', text, file])
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || 'append failed')
}

function showStatus($: EngineInterface) {
  const running = [...agents.values()].filter(a => a.status === 'running')
  $.ui.status(
    running.length
      ? `pi: ${running
          .map(a => `${a.name ?? a.type}${a.lastTool ? ` ${a.lastTool}` : ''}${a.watch ? ' (watched)' : ''}`)
          .join(' · ')}`
      : undefined,
  )
}

async function keep($: EngineInterface, a: Agent) {
  const kept: Kept = {
    id: a.id,
    name: a.name,
    type: a.type,
    description: a.description,
    model: a.model,
    thinking: a.thinking,
    readOnly: a.readOnly,
    isolated: a.isolated,
    repo: a.repo,
    based: a.based,
  }
  await $.store.set(`agent:${a.id}`, kept)
}

async function findKept($: EngineInterface, id: string): Promise<Agent | undefined> {
  const live = agents.get(id)
  if (live) return live
  const kept = (await $.store.get(`agent:${id}`)) as Kept | undefined
  if (!kept) return undefined
  const now = Date.now()
  const a: Agent = { ...kept, status: 'idle', bornAt: now, runStartedAt: now, events: [], seq: 1, stats: newStats(), inbox: [] }
  agents.set(id, a)
  return a
}

// The checkout the caller is working in now: the git toplevel of its live working
// directory, which follows a `cd` into another repo; `$.session.root()` stays the
// directory the session started in and is only the fallback.
async function callerRepo($: EngineInterface): Promise<string> {
  try {
    const wd = (await $.process.run(['pwd'])).stdout.trim()
    if (wd) {
      const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: wd })
      if (top.exitCode === 0 && top.stdout.trim()) return top.stdout.trim()
    }
  } catch {}
  return await $.session.root()
}

// Where pi starts: the agent's directory, or for an isolated agent its own worktree.
// On its first run the worktree is pointed at the session's HEAD (the engine makes it
// from origin/main), when nothing in it could be lost. A worktree that cannot be found
// is an error: pi never falls back to another checkout.
async function enterWorktree($: EngineInterface, a: Agent): Promise<{ cwd: string; preface?: string } | { error: string }> {
  // Found again on every run: a worktree of an earlier run may be gone by now.
  a.worktree = undefined
  if (!a.isolated) return { cwd: (await $.process.run(['pwd'])).stdout.trim() }
  // The checkout the Agent call was made from. Which root `$.session.root()` answers
  // inside the agent's own hook is not documented, so it is only the fallback for
  // an agent kept before the call recorded it.
  const session = a.repo ?? (await $.session.root())
  const git = async (cwd: string, ...args: string[]) => {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 120_000 })
    return { ok: r.exitCode === 0, out: r.stdout.trim() }
  }
  const listed = await git(session, 'worktree', 'list', '--porcelain')
  if (!listed.ok) return { error: `its isolated worktree could not be listed (git worktree list failed in ${session})` }
  const trees = parseWorktrees(listed.out)
  const found = findAgentWorktree(trees, a.id)
  if ('error' in found) return { error: `${found.error} ${missingWorktreeAdvice(Boolean(a.based))}` }
  const { path, branch } = found.worktree
  a.worktree = { path, branch }
  if (a.based) return { cwd: path }

  const sessionHead = (await git(session, 'rev-parse', 'HEAD')).out
  let head = (await git(path, 'rev-parse', 'HEAD')).out
  if (!head) return { error: `its isolated worktree ${path} is not a git checkout` }
  let behind: string | undefined
  if (sessionHead && sessionHead !== head) {
    const status = await git(path, 'status', '--porcelain')
    const clean = status.ok && status.out === ''
    if (clean && (await git(path, 'reset', '--hard', sessionHead)).ok) head = sessionHead
    else behind = sessionHead
  }
  const subject = (await git(path, 'log', '-1', '--format=%h %s')).out
  a.based = head
  await keep($, a)
  return { cwd: path, preface: worktreePreface({ path, branch, repo: session, head: subject || head, sessionHead: behind }) }
}

// Watch notices go to the main agent as one prompt once it is idle; each
// agent's latest section replaces its earlier undelivered one.
async function flush($: EngineInterface) {
  if (delivering || !sections.size) return
  const secs = [...sections.entries()]
  sections.clear()
  delivering = true
  let delivered = false
  try {
    const text = [WATCH_TAG, SUPERVISION_NOTE, ...secs.map(([, s]) => s.text), '</pi-subagent-watch>'].join('\n\n')
    if (mainBusy) {
      // The model reads it from the running turn's next request on.
      const kept = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (kept.deny !== undefined) throw new Error(kept.deny)
    } else {
      const sent = await $.prompt.submit({ text })
      if (sent.drop !== undefined) throw new Error(sent.drop)
    }
    delivered = true
    for (const [id, s] of secs) {
      const w = agents.get(id)?.watch
      if (w) w.cursor = Math.max(w.cursor, s.cursor)
    }
  } catch (err) {
    $.ui.log(`pi-subagent: a watch notice was not delivered (${(err as Error).message}); retrying`, { to: 'debug' })
    for (const [id, s] of secs) if (!sections.has(id)) sections.set(id, s)
  } finally {
    delivering = false
  }
  if (!delivered) $.clock.after(10_000, () => void flush($))
  else if (sections.size) void flush($)
}

function stopWatch(a: Agent) {
  a.watch?.timer.cancel()
  a.watch = undefined
  sections.delete(a.id)
}

function tick($: EngineInterface, a: Agent) {
  if (!a.watch) return
  if (a.status !== 'running') return stopWatch(a)
  sections.set(
    a.id,
    watchSection(
      { id: a.id, label: `${a.name ? `${a.name}, ` : ''}${a.type}: ${a.description}`, status: a.status, brief: a.watch.brief, criteria: a.watch.criteria },
      a.events,
      a.watch.cursor,
      a.runStartedAt,
      Date.now(),
    ),
  )
  void flush($)
}

function liveOf(a: Agent): Live {
  return {
    label: `${a.name ? `${a.name} · ` : ''}${a.type}: ${a.description}`,
    status: a.status,
    model: a.stats.model ?? a.model,
    steps: a.stats.steps,
    lines: a.events
      .filter(x => x.kind !== 'user')
      .slice(-LIVE_LINES)
      .map(x => ({ seq: x.seq, kind: x.kind, text: x.summary })),
  }
}

// Writes the agent's latest activity for the band; one write at a time, the
// last one taking whatever arrived while the one before was in flight.
function publish($: EngineInterface, a: Agent) {
  if (a.publishing) {
    a.republish = true
    return
  }
  a.publishing = true
  a.republish = false
  void update($, { ...LIVE, id: a.id }, () => liveOf(a))
    .catch(() => undefined)
    .finally(() => {
      a.publishing = false
      if (a.republish) publish($, a)
    })
}

// Shows pi's work in the subagent's own transcript, as notices the model never
// reads (ctrl+o draws them, dim), and in the band while that transcript is open.
function mirror($: EngineInterface, a: Agent, items: Omit<Activity, 'seq' | 'at'>[]) {
  if (items.some(item => item.kind !== 'user')) publish($, a)
  for (const item of items) {
    if (item.kind === 'user') continue
    const mark = item.kind === 'tool' ? '⏺' : item.kind === 'error' ? '✗' : item.kind === 'retry' ? '↻' : item.kind === 'text' ? '◆' : '⎿'
    void $.session
      .append({ agentId: a.id, message: { type: 'system', content: [{ type: 'text', text: `${mark} pi ${item.summary}` }] } })
      .catch(() => undefined)
  }
}

// A piece of "thinking" with nothing in it: the engine shows it and does not record it,
// and it counts as progress of the agent's model request, whose stream watchdog stops an
// agent after 600 s of nothing. pi runs a long command in silence, so pi's output alone
// is not enough to keep it alive.
const BEAT = { kind: 'thinking' as const, index: 0, text: '' }
const BEAT_MIN_MS = 5_000

// Runs one pi turn for the agent: a fresh pi session on its first, the same one after.
// It yields BEAT while pi shows signs of life, so a long run is not taken for a stall.
async function* runPi($: EngineInterface, a: Agent, message: string, signal: AbortSignal): AsyncGenerator<typeof BEAT, number> {
  a.status = 'running'
  a.pid = undefined
  a.lastTool = undefined
  a.stats = newStats()
  a.runStartedAt = Date.now()
  a.beaten = false
  a.notStarted = false
  showStatus($)
  publish($, a)

  const fail = (error: string) => {
    a.stats.error = error
    const items = [{ kind: 'error' as const, summary: clip(error, 240), detail: error }]
    a.seq = pushActivity(a.events, a.seq, Date.now(), items)
    mirror($, a, items)
  }
  let beats = 0
  // Left at a yield (the engine closed the stream), the run never reaches its end:
  // the agent is then stopped, not left "running" with its watch ticking.
  let closed = true
  try {
    const entered = await enterWorktree($, a)
    if ('error' in entered) {
      a.notStarted = true
      fail(`pi was not started: ${entered.error}`)
    } else {
      beats = yield* runChild($, a, entered.preface ? `${entered.preface}\n\n${message}` : message, entered.cwd, signal)
    }
    closed = false
  } catch (err) {
    closed = false
    if (!a.stats.error) fail(`pi could not be run: ${(err as Error).message}`)
  } finally {
    const stopped = closed || signal.aborted || a.stats.aborted
    if (!stopped && !a.stats.error && !a.stats.answer) a.stats.error = 'pi ended without an answer'
    a.status = stopped ? 'stopped' : a.stats.error ? 'failed' : 'completed'
    a.lastTool = undefined
    a.pid = undefined
    stopWatch(a)
    showStatus($)
    publish($, a)
  }
  return beats
}

// Runs pi in `cwd` until it settles; returns how many beats it yielded.
async function* runChild($: EngineInterface, a: Agent, message: string, cwd: string, signal: AbortSignal): AsyncGenerator<typeof BEAT, number> {
  const dir = await subagentDir($)
  const sessionFile = (await $.fs.list(dir).catch(() => [])).find(f => f.name.endsWith(`_${a.id}.jsonl`))
  const session = sessionFile ? ['--session', `${dir}/${sessionFile.name}`] : ['--session-dir', dir, '--session-id', a.id]
  a.cmdFile = `${dir}/${a.id}.cmd.jsonl`
  if (sessionFile) a.seq = pushActivity(a.events, a.seq, a.runStartedAt, [{ kind: 'note', summary: 'resumed its pi session', detail: '' }])
  await $.fs.write(a.cmdFile, rpc.prompt(message) + '\n')

  const child = $.process.spawn({
    argv: piArgv({ cmdFile: a.cmdFile, session, readOnly: a.readOnly, model: a.model, thinking: a.thinking }),
    cwd,
  })
  const kill = () => {
    if (a.pid) void $.process.run(['bash', '-c', KILL_TREE, 'pi-subagent', a.pid])
  }
  signal.addEventListener('abort', kill, { once: true })
  let pending = ''
  let stderr = ''
  // Tools pi has started and not finished: while one runs, pi's silence is the command's.
  let open = 0
  // pi's own output can be a burst of lines; the wrapper's beats are already 20 s apart.
  let yielded = 0
  let lastBeat = 0
  // Once stopped, nothing is yielded: the engine may have stopped reading, and the run
  // must still reach its end.
  const due = () => {
    const now = Date.now()
    if (signal.aborted || now - lastBeat < BEAT_MIN_MS) return false
    lastBeat = now
    return true
  }
  // Whether the loop ran to pi's end (or its settling); otherwise pi's tree is killed.
  let drained = false
  try {
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        const { beats, rest } = splitBeats(text)
        stderr = (stderr + rest).slice(-8000)
        a.pid ??= /PI_PID (\d+)/.exec(stderr)?.[1]
        if (signal.aborted) kill()
        if (beats && open > 0 && !signal.aborted) {
          yielded += 1
          a.beaten = true
          yield BEAT
        }
        continue
      }
      if (due()) {
        yielded += 1
        a.beaten = true
        yield BEAT
      }
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (!line.startsWith('{')) continue
        let ev: { type: string; [key: string]: unknown }
        try {
          ev = JSON.parse(line)
        } catch {
          continue
        }
        if (ev.type === 'message_update' || ev.type === 'tool_execution_update') continue
        const dialog = dialogId(ev)
        if (dialog) {
          void appendLine($, a.cmdFile, rpc.cancelDialog(dialog)).catch(() => undefined)
          continue
        }
        const items = digest(ev, a.stats)
        a.seq = pushActivity(a.events, a.seq, Date.now(), items)
        mirror($, a, items)
        if (ev.type === 'tool_execution_start') {
          open += 1
          a.lastTool = clip(String(ev.toolName), 24)
          showStatus($)
        } else if (ev.type === 'tool_execution_end') open = Math.max(0, open - 1)
        // A turn ends once its tools have: one whose end never came (a nested call that
        // threw) must not keep beating for a model that has gone silent since.
        else if ((ev.type === 'turn_end' || ev.type === 'agent_end') && !ev.parentToolCallId) open = 0
      }
      if (a.stats.settled) break
    }
    drained = true
  } catch (err) {
    a.stats.error ??= `pi could not run: ${(err as Error).message}`
  } finally {
    signal.removeEventListener('abort', kill)
    // Leaving the loop early ends only pi itself; the commands it runs go with the tree.
    if (!drained) kill()
  }
  let code: number | null = null
  if (!a.stats.settled) code = await child.result.then(r => r.code, () => null)
  const stopped = signal.aborted || a.stats.aborted
  if (!stopped && !a.stats.settled && !a.stats.error) {
    a.stats.error = `pi exited (code ${code}) before finishing: ${clip(piStderr(stderr), 600) || 'no output'}`
    const items = [{ kind: 'error' as const, summary: clip(a.stats.error, 240), detail: a.stats.error }]
    a.seq = pushActivity(a.events, a.seq, Date.now(), items)
    mirror($, a, items)
  }
  return yielded
}

function answerOf(a: Agent) {
  const foot = a.worktree ? `\n${worktreeFooter(a.worktree)}` : ''
  const head = `[pi · ${a.stats.model ?? a.model ?? "pi's default model"} · ${a.stats.steps} tool uses]`
  if (a.status === 'failed') {
    const retry = a.notStarted ? '' : '\n\nSendMessage to this agent retries in the same pi session.'
    return `${head}\npi failed: ${a.stats.error}${a.stats.answer ? `\n\nLast answer before it failed:\n${a.stats.answer}` : ''}${retry}${foot}`
  }
  if (a.status === 'stopped') return `${head}\npi was stopped.${a.stats.answer ? `\n\nLast answer:\n${a.stats.answer}` : ''}${foot}`
  const u = a.stats.usage
  return `${a.stats.answer}\n\n[pi · ${a.stats.model ?? 'model unknown'} · ${a.stats.steps} tool uses · ${totalTokens(u)} tokens: ${u.input} in, ${u.output} out, ${u.cacheRead} cache read]${foot}`
}

function piUsage(a: Agent) {
  if (!a.stats.model) return null
  return {
    input_tokens: a.stats.usage.input,
    output_tokens: a.stats.usage.output,
    cache_creation_input_tokens: a.stats.usage.cacheWrite,
    cache_read_input_tokens: a.stats.usage.cacheRead,
    model: a.stats.model,
  }
}

const textOf = (content: readonly { type: string; text?: string }[]) =>
  content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    scope = readScope($)
    void $.process.run(['pi', '--version'], { timeoutMs: 30_000 }).then(
      r => {
        const note = piVersionNote(r.exitCode === 0 ? r.stdout : undefined)
        if (note) $.ui.toast(note)
      },
      () => $.ui.toast(piVersionNote(undefined) ?? ''),
    )
    await $.tool.register({
      name: 'subagent_activity',
      isDeferred: false,
      description:
        "Read a pi-backed subagent's recent public activity (its text, tool calls and results, model errors and retries) without consuming its result. " +
        'No agent_id: lists the pi-backed subagents of this session. With no cursor: a recent snapshot; pass the returned cursor for what came after. ' +
        'activity_id (an event number from a page) returns that one event in full, paged by offset/limit. Use only for supervision, not polling.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent id, name, or a unique id prefix of 8+ characters. Omit to list agents.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Events per page (default 8).' },
          cursor: { type: 'string', description: 'The cursor a previous page returned.' },
          activity_id: { type: 'string', description: 'One event number to read in full.' },
          offset: { type: 'integer', minimum: 0, description: 'Character offset into the event (activity_id only).' },
        },
      },
    })
    await $.tool.register({
      name: 'watch_subagent',
      isDeferred: false,
      description:
        'Start, stop or inspect periodic supervision of a working pi-backed subagent: every interval_seconds you get a bounded notice of what it did since the last one (deferred while you are busy; several agents coalesce into one notice). ' +
        'The watch ends when the agent finishes its turn. Use it for long or risky delegated work on less reliable models. ' +
        SUPERVISION_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'] },
          agent_id: { type: 'string', description: 'Agent id, name, or a unique id prefix of 8+ characters.' },
          interval_seconds: {
            type: 'integer',
            minimum: WATCH_MIN_S,
            maximum: WATCH_MAX_S,
            description: `Seconds between notices (default ${WATCH_DEFAULT_S}).`,
          },
          review_brief: { type: 'string', description: 'What to look for, repeated in each notice.' },
          criteria: { type: 'string', description: 'When to correct the agent, repeated in each notice.' },
        },
        required: ['action', 'agent_id'],
      },
    })
    return started
  })

  on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
    const described = await next(e)
    scope ??= readScope($)
    const { models, fallback } = await scope
    const note = models.length ? scopedNote(models, fallback ?? '') : ANY_MODEL_NOTE
    return { ...described, description: `${described.description}${AGENT_HEAD}\n${note}${AGENT_TAIL}` }
  })

  // The engine spawns the agent; the call only leaves behind what pi needs.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool !== 'Agent') return next(e)
    const { type, model: requested } = splitType(e.subagent_type)
    // Claude's own: a fork, a remote agent, a Claude model asked by name.
    if (type === 'fork' || e.isolation === 'remote' || e.model || requested?.toLowerCase() === 'claude') {
      return next({ ...e, subagent_type: type })
    }
    scope ??= readScope($)
    const { models, fallback } = await scope
    // `@default`, like no `@` at all, is pi's default model as it is now, not as the session began.
    const asDefault = parseDefault(requested)
    if (asDefault && 'error' in asDefault) return { deny: asDefault.error }
    let model = asDefault ? undefined : requested
    if (models.length) {
      const now = await readPiSettings($).then(s => defaultOf(models, s.provider, s.name), () => undefined)
      const named = model ? resolveScoped(model, models) : undefined
      const resolved = named ?? ((now ?? fallback) ? { model: (now ?? fallback)! } : undefined)
      if (resolved && 'error' in resolved) return { deny: resolved.error }
      model = resolved?.model
    }
    // A level written after the model name wins over `effort`; a default model carries none of its own.
    const effort = asDefault?.level ?? e.effort
    const thinking = (!asDefault && hasThinkingSuffix(model)) || !effort || !THINKING_LEVELS.includes(effort) ? undefined : effort
    asked.set(e.tool_use_id, {
      name: e.name,
      type,
      model,
      thinking,
      readOnly: isReadOnlyType(type),
      isolated: e.isolation === 'worktree',
      // Read here, in the caller's own hook, where the session's root is the caller's.
      repo: e.isolation === 'worktree' ? await callerRepo($) : undefined,
    })
    try {
      return await next({ ...e, subagent_type: type })
    } finally {
      asked.delete(e.tool_use_id)
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const ask = asked.get(e.tool_use_id)
    const spawned = await next(e)
    if (ask && !e.fork && spawned.agentId) {
      const now = Date.now()
      const a: Agent = {
        ...ask,
        id: spawned.agentId,
        description: e.description,
        status: 'idle',
        bornAt: now,
        runStartedAt: now,
        events: [],
        seq: 1,
        stats: newStats(),
        inbox: [],
      }
      agents.set(a.id, a)
      await keep($, a)
    }
    return spawned
  })

  // What the engine hands the agent to read (its prompt, a resume's message) is pi's next input.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    const toAgent = e.agentId && !stored.deny && e.message.type === 'user' && e.message.role === 'user' && e.door !== 'tool-result' && e.door !== 'note'
    // A resume after a reload appends its message before the agent's step loads it from the store.
    const a = toAgent ? await findKept($, e.agentId!) : undefined
    if (a) {
      const text = textOf(e.message.content as { type: string; text?: string }[])
      if (text) a.inbox.push(text)
    }
    return stored
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) mainBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      mainBusy = false
      if (sections.size) void flush($)
    }
    return done
  })

  // The agent's model request: pi answers it, and no request is sent.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      mainBusy = true
      if (sections.size) void flush($)
    }
    const a = e.agentId ? await findKept($, e.agentId) : undefined
    if (!a) return yield* next(e)
    // pi echoes the message as its own user row, which the activity records.
    const message = a.inbox.splice(0).join('\n\n') || 'Continue.'
    const beats = yield* runPi($, a, message, next.signal)
    const answer = answerOf(a) || '(pi gave no text)'
    // The answer is the block after the beats' (one block holds one kind of piece).
    yield { kind: 'text', index: beats ? BEAT.index + 1 : 0, text: answer }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: piUsage(a) }
  }).catch(async function* ($, e, next) {
    // A pi-backed agent never falls back to a Claude request.
    if (!e.agentId || !agents.has(e.agentId)) return yield* next(e)
    const answer = `pi-subagent failed: ${String(next.error?.message ?? 'unknown error')}`
    // The failed hook's beats stay in the response, in block 0.
    yield { kind: 'text', index: agents.get(e.agentId)?.beaten ? BEAT.index + 1 : 0, text: answer }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  // A message to an agent while pi works steers pi; otherwise the engine delivers or resumes.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.tool !== 'SendMessage' || typeof e.to !== 'string' || typeof e.message !== 'string') return next(e)
    const found = resolveAgent(agents.values(), e.to)
    const a = found.agent
    if (!a || a.status !== 'running' || !a.cmdFile) return next(e)
    await appendLine($, a.cmdFile, rpc.steer(e.message))
    return { result: { success: true, message: `Steering message queued for ${a.name ?? a.id}: pi reads it after its current tool calls, before its next model call.` } }
  }).catch(($, e, next) => (next.called ? { deny: `${$.plugin.name}: steering the pi subagent failed.` } : next(e)))

  on('tool.call', { tool: ACTIVITY_TOOL }, async ($, e) => {
    const input = e as unknown as { agent_id?: string; limit?: number; cursor?: string; activity_id?: string; offset?: number }
    if (!input.agent_id) {
      const rows = [...agents.values()].map(
        a =>
          `${a.id}${a.name ? ` (${a.name})` : ''} · ${a.type} · ${a.status} · ${a.stats.model ?? a.model ?? "pi's default"} · ${a.stats.steps} tool uses${a.watch ? ` · watched every ${a.watch.intervalS}s` : ''} · ${a.description}`,
      )
      return { result: rows.length ? rows.join('\n') : 'No pi-backed subagents in this session.' }
    }
    const found = resolveAgent(agents.values(), input.agent_id)
    const a = found.agent
    if (!a) return { deny: found.error ?? 'No such pi-backed subagent.' }
    if (input.activity_id !== undefined) {
      return { result: detailPage(a.events.find(x => String(x.seq) === String(input.activity_id)), input.offset, input.limit) }
    }
    const head = `${a.id} · ${a.status} · ${a.stats.model ?? a.model ?? "pi's default"} · ${a.stats.steps} tool uses this run`
    return { result: `${head}\n${activityPage(a.events, a.bornAt, { limit: input.limit, cursor: input.cursor }).text}` }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: reading the activity failed.` }))

  on('tool.call', { tool: WATCH_TOOL }, async ($, e) => {
    const input = e as unknown as { action?: string; agent_id?: string; interval_seconds?: number; review_brief?: string; criteria?: string }
    const found = resolveAgent(agents.values(), input.agent_id ?? '')
    const a = found.agent
    if (!a) return { deny: found.error ?? 'No such pi-backed subagent.' }
    if (input.action === 'status') {
      return { result: a.watch ? `Watching ${a.id} every ${a.watch.intervalS}s; delivered up to event ${a.watch.cursor}.` : `${a.id} is not watched (${a.status}).` }
    }
    if (input.action === 'stop') {
      const had = Boolean(a.watch)
      stopWatch(a)
      showStatus($)
      return { result: had ? `Stopped watching ${a.id}.` : `${a.id} was not watched.` }
    }
    if (input.action !== 'start') return { deny: 'action must be start, stop or status.' }
    if (a.status !== 'running') return { deny: `${a.id} is not working (${a.status}); there is nothing to watch.` }
    const intervalS = clampInterval(input.interval_seconds)
    const updated = Boolean(a.watch)
    a.watch?.timer.cancel()
    a.watch = {
      intervalS,
      brief: input.review_brief ?? a.watch?.brief,
      criteria: input.criteria ?? a.watch?.criteria,
      cursor: a.watch?.cursor ?? 0,
      timer: $.clock.every(intervalS * 1000, () => tick($, a)),
    }
    showStatus($)
    return { result: `${updated ? 'Updated' : 'Started'} watch on ${a.id} every ${intervalS}s; it ends when the agent finishes its turn.` }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: the watch request failed.` }))

  // While a pi-backed subagent's transcript is open (↓, from the tasks list), the
  // band above the prompt shows its latest steps live, in the transcript's colors.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = e.props.view.agentId
    if (!id || e.props.hasSurvey) return next(e)
    const live = (await $.state.get({ ...LIVE, id })).value
    if (!live) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(1, Math.min(LIVE_LINES, e.props.maxRows - 1))
    const color = live.status === 'running' ? 'suggestion' : live.status === 'completed' ? 'success' : live.status === 'idle' ? 'subtle' : 'error'
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>pi</Text> · {live.model ?? "pi's default model"} · <Text color={color}>{live.status}</Text> · {live.steps} tool uses ·{' '}
          {live.label}
        </Text>
        {live.lines.slice(-room).map(line => {
          const m = LIVE_MARK[line.kind] ?? { mark: '·', color: 'subtle' }
          return (
            <Text key={String(line.seq)} wrap="truncate-end">
              <Text color={m.color}>{m.mark}</Text> {line.text}
            </Text>
          )
        })}
      </Box>
    )
  })

  // A watch notice is drawn as one dim line; ctrl+o shows it whole.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (e.props.isExpanded || e.props.origin.kind !== 'plugin' || !e.props.text.includes(WATCH_TAG)) return next(e)
    const agentsIn = [...e.props.text.matchAll(/^## (\S+) \(([^,)]+)/gm)].map(m => m[2] ?? m[1])
    const events = (e.props.text.match(/^\[\d+ /gm) ?? []).length
    const { Text } = $.ui.resolve(e)
    return (
      <Text dimColor>
        ⟳ pi watch · {agentsIn.join(', ') || 'subagents'} · {events} new events (ctrl+o to expand)
      </Text>
    )
  })
}
