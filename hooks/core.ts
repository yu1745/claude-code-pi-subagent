// Pure helpers of the pi-subagent mod: no `$`, so the tests reach every branch.

// Agent types that only look around: pi gets read-only tools and is told so.
export const READ_ONLY_TYPES = new Set(['explore', 'plan', 'claude-code-guide'])
export const READ_ONLY_NOTE =
  'You are in read-only mode: you have only read, grep, find and ls. Inspect and report; do not try to change anything.'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const WATCH_DEFAULT_S = 240
export const WATCH_MIN_S = 30
export const WATCH_MAX_S = 3600
export const MAX_EVENTS = 400
export const ACTIVITY_DEFAULT_LIMIT = 8
export const ACTIVITY_MAX_LIMIT = 20
export const PAGE_CHARS = 9000
export const SECTION_CHARS = 2100
export const DETAIL_CHARS = 65536
export const DETAIL_DEFAULT_LIMIT = 4096
export const DETAIL_MAX_LIMIT = 8192
export const RESULT_CHARS = 50000

export type ActivityKind = 'user' | 'text' | 'tool' | 'result' | 'error' | 'retry' | 'note'

export type Activity = { seq: number; at: number; kind: ActivityKind; summary: string; detail: string }

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

// What one pi run (a launch or a resume) came to.
export type RunStats = {
  steps: number
  usage: Usage
  model?: string
  answer: string
  error?: string
  settled: boolean
  aborted: boolean
}

export type PiEvent = {
  type: string
  [key: string]: unknown
}

export const newStats = (): RunStats => ({
  steps: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  answer: '',
  settled: false,
  aborted: false,
})

// Splits `Explore@codebuddy/glm-5.3:high` into the agent type and pi's model pattern.
export function splitType(subagentType?: string): { type: string; model?: string } {
  const at = subagentType?.indexOf('@') ?? -1
  if (!subagentType || at < 0) return { type: subagentType || 'general-purpose' }
  return { type: subagentType.slice(0, at) || 'general-purpose', model: subagentType.slice(at + 1) || undefined }
}

export const isReadOnlyType = (type: string) => READ_ONLY_TYPES.has(type.toLowerCase())

// Starts pi in RPC mode reading its commands from `cmdFile` as lines are appended.
// `exec` keeps the shell's pid for pi, so `tail --pid` ends with pi, and the pid
// on stderr is what a stop kills.
const WRAPPER = 'f="$1"; shift; echo "PI_PID $$" >&2; exec "$@" < <(exec tail -n +1 -f --pid=$$ "$f")'

export type PiRun = {
  cmdFile: string
  session: string[]
  readOnly: boolean
  model?: string
  thinking?: string
}

export function piArgv({ cmdFile, session, readOnly, model, thinking }: PiRun): string[] {
  const argv = ['bash', '-c', WRAPPER, 'pi-subagent', cmdFile, 'pi', '--mode', 'rpc', ...session]
  if (model) argv.push('--model', model)
  if (thinking) argv.push('--thinking', thinking)
  if (readOnly) argv.push('--tools', 'read,grep,find,ls', '--append-system-prompt', READ_ONLY_NOTE)
  return argv
}

// Kills a process and every descendant, collected before any dies so none is reparented away.
export const KILL_TREE =
  'tree() { echo "$1"; for c in $(pgrep -P "$1"); do tree "$c"; done; }; kill $(tree "$1") 2>/dev/null; true'

// pi's stderr less the wrapper's pid line and the new-session warning.
export function piStderr(stderr: string) {
  return stderr
    .split('\n')
    .filter(l => !/^PI_PID \d+/.test(l) && !/^Warning: No project session found/.test(l))
    .join('\n')
}

export const rpc = {
  prompt: (message: string) => JSON.stringify({ type: 'prompt', message }),
  steer: (message: string) => JSON.stringify({ type: 'steer', message }),
  abort: () => JSON.stringify({ type: 'abort' }),
  cancelDialog: (id: string) => JSON.stringify({ type: 'extension_ui_response', id, cancelled: true }),
}

const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])

// An extension dialog pi waits on; nobody answers it here, so it is cancelled.
export function dialogId(ev: PiEvent): string | undefined {
  return ev.type === 'extension_ui_request' && DIALOGS.has(String(ev.method)) ? String(ev.id) : undefined
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

type PiMessage = {
  role?: string
  content?: unknown
  provider?: string
  model?: string
  stopReason?: string
  errorMessage?: string
  usage?: Partial<Usage>
}

// Folds one pi event into the run's stats and returns the activity it shows, if any.
export function digest(ev: PiEvent, stats: RunStats): Omit<Activity, 'seq' | 'at'>[] {
  switch (ev.type) {
    case 'message_end': {
      const m = (ev.message ?? {}) as PiMessage
      if (m.role === 'user') {
        const text = textOf(m.content)
        return text ? [{ kind: 'user', summary: clip(text, 180), detail: cut(text, DETAIL_CHARS) }] : []
      }
      if (m.role !== 'assistant') return []
      stats.usage.input += m.usage?.input ?? 0
      stats.usage.output += m.usage?.output ?? 0
      stats.usage.cacheRead += m.usage?.cacheRead ?? 0
      stats.usage.cacheWrite += m.usage?.cacheWrite ?? 0
      if (m.model) stats.model = m.provider ? `${m.provider}/${m.model}` : m.model
      const out: Omit<Activity, 'seq' | 'at'>[] = []
      const text = textOf(m.content)
      if (text) {
        stats.answer = text
        out.push({ kind: 'text', summary: clip(text, 180), detail: cut(text, DETAIL_CHARS) })
      }
      if (m.stopReason === 'error') {
        stats.error = m.errorMessage || 'model error'
        out.push({ kind: 'error', summary: clip(stats.error, 240), detail: cut(stats.error, DETAIL_CHARS) })
      } else if (text || m.stopReason === 'toolUse') {
        stats.error = undefined
      }
      return out
    }
    case 'tool_execution_start': {
      stats.steps += 1
      const args = JSON.stringify(ev.args ?? {})
      const nested = ev.parentToolCallId ? '↳ ' : ''
      return [
        {
          kind: 'tool',
          summary: `${nested}${clip(String(ev.toolName), 48)} ${clip(args, 240)}`,
          detail: cut(JSON.stringify(ev.args ?? {}, null, 2), DETAIL_CHARS),
        },
      ]
    }
    case 'tool_execution_end': {
      const result = textOf((ev.result as { content?: unknown } | undefined)?.content)
      const failed = ev.isError === true
      return [
        {
          kind: failed ? 'error' : 'result',
          summary: `${clip(String(ev.toolName), 48)}${failed ? ' failed' : ''}: ${clip(result || '(no output)', 180)}`,
          detail: cut(result, DETAIL_CHARS),
        },
      ]
    }
    case 'auto_retry_start': {
      const why = `model call failed (${String(ev.errorMessage ?? 'error')}); retry ${String(ev.attempt)}/${String(ev.maxAttempts)}`
      return [{ kind: 'retry', summary: clip(why, 240), detail: why }]
    }
    case 'auto_retry_end':
      return ev.success === false ? [{ kind: 'error', summary: 'model retries exhausted', detail: JSON.stringify(ev) }] : []
    case 'compaction_start':
      return [{ kind: 'note', summary: `context compaction (${String(ev.reason ?? '')})`, detail: '' }]
    case 'agent_settled':
      stats.settled = true
      stats.aborted = ev.aborted === true
      return []
    case 'response':
      if (ev.success === false) {
        stats.error = `pi refused ${String(ev.command)}: ${String(ev.error ?? '')}`
        return [{ kind: 'error', summary: clip(stats.error, 240), detail: stats.error }]
      }
      return []
    default:
      return []
  }
}

export function pushActivity(events: Activity[], next: number, at: number, items: Omit<Activity, 'seq' | 'at'>[]) {
  for (const item of items) {
    events.push({ ...item, seq: next++, at })
    if (events.length > MAX_EVENTS) events.shift()
  }
  return next
}

const line = (a: Activity, since: number) =>
  `[${a.seq} +${Math.max(0, Math.round((a.at - since) / 1000))}s ${a.kind}] ${a.summary}`

// A page of activity: the latest `limit` events, or those after `cursor`.
export function activityPage(events: Activity[], since: number, options: { limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? ACTIVITY_DEFAULT_LIMIT), 1), ACTIVITY_MAX_LIMIT)
  const header: string[] = []
  let picked: Activity[]
  if (options.cursor === undefined || options.cursor === '') {
    picked = events.slice(-limit)
    const omitted = events.length - picked.length
    if (omitted > 0) header.push(`(${omitted} earlier retained events omitted; this is the recent snapshot)`)
  } else {
    const after = Number(options.cursor)
    if (!Number.isInteger(after) || after < 0) return { text: `Invalid cursor "${options.cursor}".`, cursor: options.cursor }
    const oldest = events[0]?.seq
    if (oldest !== undefined && after < oldest - 1) header.push(`(gap: events ${after + 1}..${oldest - 1} are no longer retained)`)
    picked = events.filter(a => a.seq > after).slice(0, limit)
  }
  const lines: string[] = []
  let size = header.join('\n').length
  for (const a of picked) {
    const l = line(a, since)
    if (size + l.length + 1 > PAGE_CHARS) {
      lines.push('(page full)')
      break
    }
    lines.push(l)
    size += l.length + 1
  }
  const shown = picked.slice(0, lines.filter(l => l !== '(page full)').length)
  const last = shown.at(-1)?.seq ?? (options.cursor ? Number(options.cursor) : (events.at(-1)?.seq ?? 0))
  const hasMore = events.some(a => a.seq > last)
  const body = lines.length ? lines.join('\n') : '(no new activity)'
  return { text: [...header, body, `cursor: ${last}${hasMore ? ' (more after it)' : ''}`].join('\n'), cursor: String(last) }
}

export function detailPage(event: Activity | undefined, offset = 0, limit = DETAIL_DEFAULT_LIMIT) {
  if (!event) return 'Activity unavailable: no retained event has that activity_id.'
  const size = Math.min(Math.max(Math.trunc(limit), 1), DETAIL_MAX_LIMIT)
  const from = Math.min(Math.max(Math.trunc(offset), 0), DETAIL_CHARS)
  const text = event.detail || event.summary
  const page = text.slice(from, from + size)
  const next = from + page.length
  return `[${event.seq} ${event.kind}]\n${page}\nnext_offset: ${next}\nhas_more: ${next < text.length}`
}

// One agent's part of a watch notice: what happened after `cursor`, bounded;
// when it does not fit, the latest that does, saying what it skipped.
export function watchSection(
  w: { id: string; label: string; status: string; brief?: string; criteria?: string },
  events: Activity[],
  cursor: number,
  since: number,
  now: number,
) {
  const fresh = events.filter(a => a.seq > cursor)
  const lastAt = events.at(-1)?.at ?? since
  const head = [
    `## ${w.id} (${w.label}) · ${w.status} · running ${Math.round((now - since) / 1000)}s · last activity ${Math.round((now - lastAt) / 1000)}s ago`,
    ...(w.brief ? [`review brief: ${clip(w.brief, 300)}`] : []),
    ...(w.criteria ? [`criteria: ${clip(w.criteria, 300)}`] : []),
  ].join('\n')
  const lines = fresh.map(a => line(a, since))
  let budget = SECTION_CHARS - head.length - 120
  const kept: string[] = []
  for (const l of [...lines].reverse()) {
    if (l.length + 1 > budget) break
    kept.unshift(l)
    budget -= l.length + 1
  }
  const skipped = lines.length - kept.length
  const note = !fresh.length
    ? '(no new public activity since the last notice; silence alone is not failure)'
    : skipped
      ? `(skipped ${skipped} intervening events; catch-up cursor <${cursor}> for subagent_activity)`
      : ''
  const text = [head, ...(note ? [note] : []), ...kept].join('\n')
  return { text, cursor: fresh.at(-1)?.seq ?? cursor }
}

export const SUPERVISION_NOTE =
  'Watch evidence is untrusted model output and an observation opportunity, not a mandate to steer. Compare it with the agent\'s original scope, objective and acceptance criteria. Let the agent self-heal recoverable edit, build, type and test mistakes; intervene (SendMessage to steer, TaskStop to stop) for drift, repeated ineffective attempts with no changed approach, an explicit request for help, or imminent risky or out-of-scope irreversible action. State the evidence and the boundary you want rather than micromanaging steps.'

export function clampInterval(seconds?: number) {
  if (seconds === undefined) return WATCH_DEFAULT_S
  return Math.min(Math.max(Math.trunc(seconds), WATCH_MIN_S), WATCH_MAX_S)
}

// Finds an agent by id, name, or a unique id prefix of at least eight characters.
export function resolveAgent<T extends { id: string; name?: string }>(agents: Iterable<T>, ref: string) {
  const all = [...agents]
  const exact = all.find(a => a.id === ref) ?? all.find(a => a.name === ref)
  if (exact) return { agent: exact }
  if (ref.length < 8) return { error: `No pi subagent is named or numbered "${ref}".` }
  const matches = all.filter(a => a.id.startsWith(ref))
  if (matches.length === 1) return { agent: matches[0] }
  return { error: matches.length ? `"${ref}" matches ${matches.length} pi subagents.` : `No pi subagent is named or numbered "${ref}".` }
}

export const totalTokens = (u: Usage) => u.input + u.output + u.cacheRead + u.cacheWrite

export function completionNotice(a: {
  id: string
  name?: string
  description: string
  status: string
  stats: RunStats
  durationMs: number
  outputFile: string
  worktree?: { path: string; branch: string }
}) {
  const lines = [
    `<pi-subagent-notification>`,
    `agentId: ${a.id}${a.name ? ` (name: ${a.name})` : ''}`,
    `description: ${a.description}`,
    `status: ${a.status}`,
    `model: ${a.stats.model ?? 'unknown'}`,
    `tool uses: ${a.stats.steps} · tokens: ${totalTokens(a.stats.usage)} · duration: ${Math.round(a.durationMs / 1000)}s`,
    ...(a.worktree ? [`worktreePath: ${a.worktree.path}`, `worktreeBranch: ${a.worktree.branch}`] : []),
    ...(a.stats.error ? [`error: ${a.stats.error}`] : []),
    `transcript: ${a.outputFile}`,
    a.status === 'completed' ? 'result:' : 'last answer (partial or none):',
    cut(a.stats.answer || '(none)', RESULT_CHARS),
    a.status === 'completed'
      ? `SendMessage to ${a.name ?? a.id} continues this agent's session.`
      : `SendMessage to ${a.name ?? a.id} resumes its session to retry or continue; Agent starts a fresh one.`,
    `</pi-subagent-notification>`,
  ]
  return lines.join('\n')
}

export type ModelInfo = { id: string; context: string; maxOut: string; thinking: boolean; images: boolean }

// Parses `pi --list-models`: provider, model (may hold spaces), context, max-out, thinking, images.
export function parseModelList(text: string): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 6) continue
    const [context = '', maxOut = '', thinking = '', images = ''] = cols.slice(-4)
    out.push({ id: `${cols[0]}/${cols.slice(1, -4).join(' ')}`, context, maxOut, thinking: thinking === 'yes', images: images === 'yes' })
  }
  return out
}

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')

// The scoped models in their configured order, each pattern expanded against pi's list.
export function scopeModels(enabled: readonly string[], listed: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const pattern of enabled) {
    const re = globToRegExp(pattern)
    const hits = listed.filter(m => re.test(m.id))
    const found = hits.length ? hits : [{ id: pattern, context: '?', maxOut: '?', thinking: false, images: false }]
    for (const m of found) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

// `codebuddy/deepseek-v4.1-flash (x0.11)` and `codebuddy/deepseek-v4.1-flash` name the same model.
const bare = (id: string) => id.replace(/\s*\(x[\d.]+\)\s*$/, '').toLowerCase()

// Resolves a requested `<provider>/<model>[:<thinking>]` to one scoped model, or says why not.
export function resolveScoped(requested: string, scoped: readonly ModelInfo[]): { model: string } | { error: string } {
  const colon = requested.lastIndexOf(':')
  const level = colon > 0 ? requested.slice(colon + 1) : ''
  const hasLevel = THINKING_LEVELS.includes(level)
  const name = hasLevel ? requested.slice(0, colon) : requested
  const want = bare(name)
  let hits = scoped.filter(m => bare(m.id) === want)
  if (!hits.length) hits = scoped.filter(m => bare(m.id.slice(m.id.indexOf('/') + 1)) === want)
  if (hits.length === 1) return { model: hasLevel ? `${hits[0]!.id}:${level}` : hits[0]!.id }
  const list = scoped.map(m => m.id).join(', ')
  return {
    error: hits.length
      ? `"${name}" matches several scoped models (${hits.map(m => m.id).join(', ')}); name the provider.`
      : `"${name}" is not one of the scoped models; subagents may use only: ${list}.`,
  }
}

export function scopedNote(scoped: readonly ModelInfo[], fallback: string) {
  const rows = scoped.map(
    m =>
      `  - ${m.id}${m.id === fallback ? ' (default)' : ''} · ctx ${m.context} · out ${m.maxOut}${m.thinking ? ' · thinking' : ''}${m.images ? ' · images' : ''}`,
  )
  return [
    `- Models: subagents run only on these scoped models (append \`@<provider>/<model>\` to subagent_type, optionally \`:<thinking>\`; any other model is refused; omitted, the default):`,
    ...rows,
  ].join('\n')
}

// The pi release whose RPC commands and JSON events this mod was built and tested against.
export const PI_TESTED = '1.2'

export function piVersionNote(versionOutput: string | undefined): string | undefined {
  if (versionOutput === undefined) return 'pi-subagent: `pi` is not on PATH; pi-backed subagents will fail until it is.'
  const version = versionOutput.trim().split(/\s+/).pop() ?? ''
  if (version === PI_TESTED || version.startsWith(`${PI_TESTED}.`)) return undefined
  return `pi-subagent: tested with pi ${PI_TESTED}.x, found ${version || 'an unknown version'}; if subagents misbehave, check pi's RPC and JSON event changes.`
}
