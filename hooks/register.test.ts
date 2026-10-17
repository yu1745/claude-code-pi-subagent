import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// The test runtime has timers; the module's own types do not declare them.
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

// The engine and the host beneath the plugin: a fake pi, a fake git, pi's settings,
// and an Agent tool that spawns the way the engine does.

const HOME = '/home/t'
const SETTINGS = JSON.stringify({
  defaultProvider: 'acme',
  defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash',
  enabledModels: ['acme/deepseek-ai/DeepSeek-V4.1-Flash', 'codebuddy/deepseek-v4.1-flash (x0.11)', 'zai-coding-cn/glm-5.3'],
})
const MODELS = `provider     model                              context  max-out  thinking  images
acme         deepseek-ai/DeepSeek-V4.1-Flash    1.0M     384K     yes       yes
codebuddy    deepseek-v4.1-flash (x0.11)        1M       128K     yes       yes
zai-coding-cn glm-5.3                           1M       131.1K   yes       no
openrouter   openai/gpt-6-sol                   1.1M     128K     yes       yes
`

// `beats`: PI_BEAT lines the wrapper prints while a tool runs; `earlyBeats`: before pi has started one;
// `lostEnd`: the tool's end event never comes, its turn ends, and `lateBeats` follow.
type PiScript = { answer?: string; fail?: string; gate?: Promise<void>; beats?: number; earlyBeats?: number; lostEnd?: boolean; lateBeats?: number }

// The repo the fake git answers for: the session's checkout and the engine's worktree of agent a1.
type Git = { sessionHead: string; worktreeHead: string; dirty: boolean; resetFails: boolean; worktrees: boolean }

type World = {
  // What `$.session.root()` answers; a test may change it once the Agent call is made.
  root: string
  spawns: { argv: readonly string[]; cwd?: string }[]
  runs: (readonly string[])[]
  gitRuns: { argv: readonly string[]; cwd?: string }[]
  git: Git
  writes: Map<string, string>
  submitted: string[]
  claudeSteps: number
  spawned: string[]
  agentCalls: (Record<string, unknown> & { done?: () => void })[]
  pi: PiScript
}

// pi's settings file as the fake host answers it; a test may change it mid-session.
let settings = SETTINGS

const ok = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On, stored?: Record<string, unknown>): World {
  const w: World = {
    root: '/repo',
    spawns: [],
    runs: [],
    gitRuns: [],
    git: { sessionHead: 'aaa1111', worktreeHead: 'bbb2222', dirty: false, resetFails: false, worktrees: true },
    writes: new Map(),
    submitted: [],
    claudeSteps: 0,
    spawned: [],
    agentCalls: [],
    pi: {},
  }
  const sessionFiles = new Set<string>()
  let agents = 0
  mock.env(on, { HOME })
  mock.store(on, stored)

  on('session.root', () => ({ value: w.root }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === `${HOME}/.pi/agent/settings.json` }))
  settings = SETTINGS
  on('fs.read', ($, e) => ({ value: e.path === `${HOME}/.pi/agent/settings.json` ? settings : '' }))
  on('fs.write', ($, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [...sessionFiles].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }))
  on('process.run', ($, e) => {
    w.runs.push(e.argv)
    const [cmd, ...rest] = e.argv
    if (cmd === 'pwd') return ok('/repo\n')
    if (cmd === 'pi' && rest[0] === '--list-models') return ok(MODELS)
    if (cmd === 'pi' && rest[0] === '--version') return ok('1.2.0\n')
    if (cmd === 'git') {
      const cwd = e.init?.cwd
      w.gitRuns.push({ argv: rest, cwd })
      const inWorktree = cwd !== undefined && cwd !== '/repo'
      if (rest[0] === 'worktree') {
        const linked = w.git.worktrees
          ? w.spawned.map(id => `\nworktree /repo/.claude/worktrees/agent-${id}\nHEAD ${w.git.worktreeHead}\nbranch refs/heads/worktree-agent-${id}\n`).join('')
          : ''
        return ok(`worktree /repo\nHEAD ${w.git.sessionHead}\nbranch refs/heads/work\n${linked}`)
      }
      if (rest[0] === 'rev-parse') return ok(`${inWorktree ? w.git.worktreeHead : w.git.sessionHead}\n`)
      if (rest[0] === 'status') return ok(w.git.dirty ? ' M file.c\n' : '')
      if (rest[0] === 'reset') {
        if (w.git.resetFails) return ok('', 1)
        w.git.worktreeHead = rest[2] ?? w.git.worktreeHead
        return ok()
      }
      if (rest[0] === 'log') return ok(`${w.git.worktreeHead} the session's commit\n`)
    }
    return ok()
  })
  on('process.spawn', async function* ($, e) {
    w.spawns.push({ argv: e.argv, cwd: e.cwd })
    const id = e.argv[e.argv.indexOf('--session-id') + 1]
    if (e.argv.includes('--session-id') && id) sessionFiles.add(`2026-01-01_${id}.jsonl`)
    yield { stream: 'stderr' as const, text: 'PI_PID 4242\n' }
    for (let i = 0; i < (w.pi.earlyBeats ?? 0); i++) yield { stream: 'stderr' as const, text: 'PI_BEAT\n' }
    if (w.pi.fail) {
      yield { stream: 'stderr' as const, text: `${w.pi.fail}\n` }
      return { value: { code: 1, signal: null } }
    }
    const line = (ev: object) => ({ stream: 'stdout' as const, text: JSON.stringify(ev) + '\n' })
    yield line({ type: 'session', cwd: e.cwd })
    yield line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } })
    yield line({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.txt' } })
    for (let i = 0; i < (w.pi.beats ?? 0); i++) yield { stream: 'stderr' as const, text: 'PI_BEAT\n' }
    if (w.pi.lostEnd) {
      yield line({ type: 'turn_end', message: {}, toolResults: [] })
      for (let i = 0; i < (w.pi.lateBeats ?? 0); i++) yield { stream: 'stderr' as const, text: 'PI_BEAT\n' }
    } else {
      yield line({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'hello' }] }, isError: false })
    }
    if (w.pi.gate) await w.pi.gate
    yield line({
      type: 'message_end',
      message: { role: 'assistant', provider: 'p', model: 'm', stopReason: 'stop', content: [{ type: 'text', text: w.pi.answer ?? 'pi says hi' }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } },
    })
    yield line({ type: 'agent_settled', aborted: false })
    return { value: { code: 0, signal: null } }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('agent.spawn', ($, e) => {
    const agentId = `a${++agents}`
    w.spawned.push(agentId)
    return { model: 'claude-x', agentId }
  })
  // The engine's Agent tool: held open while the test body spawns the agent for it.
  on('tool.call', { tool: 'Agent' }, async ($, e) => {
    let done = () => {}
    const spawnedHere = new Promise<void>(r => (done = r))
    w.agentCalls.push({ ...e, done })
    await spawnedHere
    return { result: { status: 'async_launched' } } as never
  })
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: { success: true, message: 'engine delivered' } }) as never)
  on('turn.step', async function* ($, e) {
    w.claudeSteps += 1
    yield { kind: 'text' as const, index: 0, text: 'CLAUDE' }
    return { turnId: e.turnId, index: e.index, answer: 'CLAUDE', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return w
}

let calls = 0
const agentCall = (input: Record<string, unknown>) =>
  ({ tool: 'Agent', tool_use_id: `tu${++calls}`, description: 'd', prompt: 'do the task', ...input }) as never

// Calls the Agent tool and, while the engine's call is open, spawns the agent and
// hands it its prompt, as the engine does; a call the plugin refused spawns nothing.
async function launch($: any, w: World, input: Record<string, unknown>) {
  const seen = w.agentCalls.length
  const e = agentCall(input) as unknown as { tool_use_id: string; prompt: string; description: string }
  const call = $.tool.call(e)
  let refused = false
  call.then(
    () => (refused = true),
    () => (refused = true),
  )
  while (w.agentCalls.length === seen) {
    if (refused) return call
    await new Promise(r => setTimeout(r, 2))
  }
  const below = w.agentCalls[seen]!
  const spawned = await $.agent.spawn({
    tool_use_id: e.tool_use_id,
    prompt: e.prompt,
    description: e.description,
    subagentType: below.subagent_type ?? 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-x',
    background: true,
    fork: below.subagent_type === 'fork',
  })
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: e.prompt }] },
    door: 'prompt',
    origin: { kind: 'tool', tool: 'Agent' },
    uuid: `u-${e.tool_use_id}`,
    agentId: spawned.agentId,
  })
  below.done?.()
  return call
}

async function step($: any, agentId: string) {
  const stream = $.turn.step({ turnId: `T${++calls}`, index: 0, model: 'claude-x', messageCount: 1, ...(agentId ? { agentId } : {}) })
  const texts: string[] = []
  let beats = 0
  for (;;) {
    const r = await stream.next()
    if (r.done) return { texts, beats, result: r.value }
    if (r.value.kind === 'text') texts.push(r.value.text)
    if (r.value.kind === 'thinking') beats += 1
  }
}

const argvOf = (w: World, i = -1) => w.spawns.at(i)?.argv ?? []
const after = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]

test('describe lists the scoped models with the default marked', async ($, on) => {
  world(on)
  const d = await $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(d.description.startsWith('BASE')).toBe(true)
  expect(d.description).toContain('acme/deepseek-ai/DeepSeek-V4.1-Flash (default)')
  expect(d.description).toContain('codebuddy/deepseek-v4.1-flash (x0.11)')
  expect(d.description).not.toContain('openrouter')
})

test('a scoped model: pi answers the step, read-only tools for Explore, usage in the answer', async ($, on) => {
  const w = world(on)
  const session = mock.session(on)
  await launch($, w, ({ subagent_type: 'Explore@codebuddy/deepseek-v4.1-flash' }))
  expect(w.agentCalls[0]?.subagent_type).toBe('Explore')
  const { texts, result } = await step($, 'a1')
  const argv = argvOf(w)
  expect(after(argv, '--model')).toBe('codebuddy/deepseek-v4.1-flash (x0.11)')
  expect(after(argv, '--tools')).toBe('read,grep,find,ls')
  expect(after(argv, '--session-id')).toBe('a1')
  expect(w.spawns[0]?.cwd).toBe('/repo')
  expect(w.claudeSteps).toBe(0)
  expect(texts.join('')).toBe(result.answer)
  expect(result.answer).toContain('pi says hi')
  expect(result.answer).toContain('125 tokens: 100 in, 20 out, 5 cache read')
  expect(result.usage?.input_tokens).toBe(100)
  expect([...w.writes.values()].some(t => t.includes('"message":"do the task"'))).toBe(true)
  expect(session.appended().some(r => r.agentId === 'a1' && r.message.type === 'system')).toBe(true)
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 } }

test('the band above the prompt shows the open subagent\'s pi activity, not dimmed', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'Explore@codebuddy/deepseek-v4.1-flash' })
  await step($, 'a1')
  const ui = await $.ui.mount({ plugin: 'pi-subagent', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'a1' } } })
  const drawn = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(drawn).toContain('completed')
  expect(drawn).toContain('read {"path":"a.txt"}')
  expect(drawn).toContain('pi says hi')
  expect(drawn).not.toContain('do the task')
  expect((await ui.findAll({ type: 'Text' })).some(t => t.props.dimColor)).toBe(false)
})

test('the band leaves the main conversation and unknown agents to the engine', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'Explore' })
  await step($, 'a1')
  for (const view of [{}, { agentId: 'zz' }]) {
    const ui = await $.ui.mount({ plugin: 'pi-subagent', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view } }).catch(() => undefined)
    expect(await ui?.find({ text: 'pi' })).toBeUndefined()
  }
})

test('no model named: the default model; effort becomes thinking', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose', effort: 'high' }))
  await step($, 'a1')
  expect(after(argvOf(w), '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(after(argvOf(w), '--thinking')).toBe('high')
  expect(argvOf(w)).not.toContain('--tools')
})

test('@default is pi\'s default model, with or without a thinking level', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'general-purpose@default' })
  await launch($, w, { subagent_type: 'Explore@DEFAULT:high' })
  await launch($, w, { subagent_type: 'general-purpose@default', effort: 'low' })
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  expect(w.agentCalls.map(c => c.subagent_type)).toEqual(['general-purpose', 'Explore', 'general-purpose'])
  const [one, two, three] = w.spawns.map(s => s.argv)
  expect(after(one!, '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(one).not.toContain('--thinking')
  expect(after(two!, '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(after(two!, '--thinking')).toBe('high')
  expect(after(three!, '--thinking')).toBe('low')
  expect(w.claudeSteps).toBe(0)
})

test('@default follows pi\'s default model as it is now, not as the session began', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'general-purpose@default' })
  settings = JSON.stringify({ ...JSON.parse(SETTINGS), defaultProvider: 'zai-coding-cn', defaultModel: 'glm-5.3' })
  await launch($, w, { subagent_type: 'general-purpose@default' })
  await step($, 'a1')
  await step($, 'a2')
  expect(after(w.spawns[0]!.argv, '--model')).toBe('acme/deepseek-ai/DeepSeek-V4.1-Flash')
  expect(after(w.spawns[1]!.argv, '--model')).toBe('zai-coding-cn/glm-5.3')
})

test('@default with a bad thinking level is refused before anything spawns', async ($, on) => {
  const w = world(on)
  const r = await launch($, w, { subagent_type: 'general-purpose@default:loud' })
  expect((r as { deny?: string }).deny).toContain('not a thinking level')
  expect(w.spawned.length).toBe(0)
})

test('the Agent description tells the main agent to use @default unless the user names a model', async ($, on) => {
  world(on)
  const d = await $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(d.description).toContain('`@default`')
  expect(d.description).toContain('unless the user names a model')
  expect(d.description).toContain('It is acme/deepseek-ai/DeepSeek-V4.1-Flash now.')
})

test('no scoped models: a `:` in a model id is not a thinking level, and @default leaves the model to pi', async ($, on) => {
  const w = world(on)
  settings = JSON.stringify({ defaultProvider: 'acme', defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash' })
  await launch($, w, { subagent_type: 'general-purpose@openrouter/x:free', effort: 'high' })
  await launch($, w, { subagent_type: 'general-purpose@openrouter/x:low', effort: 'high' })
  await launch($, w, { subagent_type: 'general-purpose@default:max', effort: 'low' })
  await step($, 'a1')
  await step($, 'a2')
  await step($, 'a3')
  const [one, two, three] = w.spawns.map(s => s.argv)
  expect(after(one!, '--model')).toBe('openrouter/x:free')
  expect(after(one!, '--thinking')).toBe('high')
  expect(after(two!, '--model')).toBe('openrouter/x:low')
  expect(two).not.toContain('--thinking')
  expect(three).not.toContain('--model')
  expect(after(three!, '--thinking')).toBe('max')
})

test('a :thinking suffix wins over effort', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose@glm-5.3:low', effort: 'high' }))
  await step($, 'a1')
  expect(after(argvOf(w), '--model')).toBe('zai-coding-cn/glm-5.3:low')
  expect(argvOf(w)).not.toContain('--thinking')
})

test('a model outside the scope is refused before anything spawns', async ($, on) => {
  const w = world(on)
  const r = await launch($, w, ({ subagent_type: 'general-purpose@openrouter/openai/gpt-6-sol' }))
  expect((r as { deny?: string }).deny).toContain('not one of the scoped models')
  expect(w.spawned.length).toBe(0)
})

test('model or @claude: Claude runs the agent, pi never starts', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose', model: 'haiku' }))
  await launch($, w, ({ subagent_type: 'Explore@claude' }))
  expect(w.agentCalls[1]?.subagent_type).toBe('Explore')
  await step($, 'a1')
  await step($, 'a2')
  expect(w.claudeSteps).toBe(2)
  expect(w.spawns.length).toBe(0)
})

test('fork and remote pass through to Claude', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'fork' }))
  await launch($, w, ({ subagent_type: 'general-purpose', isolation: 'remote' }))
  await step($, 'a1')
  expect(w.claudeSteps).toBe(1)
  expect(w.spawns.length).toBe(0)
})

const worktreeAgent = { subagent_type: 'general-purpose', isolation: 'worktree' }
const promptOf = (w: World) => [...w.writes.entries()].find(([f]) => f.endsWith('a1.cmd.jsonl'))?.[1] ?? ''

test('a worktree agent runs pi in its own worktree, pointed at the session HEAD', async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  const { result } = await step($, 'a1')
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  const reset = w.gitRuns.find(r => r.argv[0] === 'reset')
  expect(reset?.argv).toEqual(['reset', '--hard', 'aaa1111'])
  expect(reset?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  const prompt = promptOf(w)
  expect(prompt).toContain('isolated git worktree: /repo/.claude/worktrees/agent-a1 (branch worktree-agent-a1)')
  expect(prompt).toContain('aaa1111 the session')
  expect(prompt).toContain('do not cd into or edit anything under /repo')
  expect(prompt).toContain('do the task')
  expect(result.answer).toContain('[worktree · /repo/.claude/worktrees/agent-a1 · branch worktree-agent-a1]')
})

test('a worktree already at the session HEAD is not reset', async ($, on) => {
  const w = world(on)
  w.git.worktreeHead = w.git.sessionHead
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.gitRuns.some(r => r.argv[0] === 'reset')).toBe(false)
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
})

test('a worktree with changes in it is left alone and pi is told it is behind', async ($, on) => {
  const w = world(on)
  w.git.dirty = true
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.gitRuns.some(r => r.argv[0] === 'reset')).toBe(false)
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(promptOf(w)).toContain("caller's checkout is at aaa1111, which this worktree could not be pointed at")
})

test('a worktree that cannot be reset still runs, and pi is told', async ($, on) => {
  const w = world(on)
  w.git.resetFails = true
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  expect(w.spawns.length).toBe(1)
  expect(promptOf(w)).toContain('could not be pointed at')
})

test('a worktree that is not found is an error: pi never runs in the main checkout', async ($, on) => {
  const w = world(on)
  w.git.worktrees = false
  await launch($, w, worktreeAgent)
  const { result } = await step($, 'a1')
  expect(w.spawns.length).toBe(0)
  expect(result.answer).toContain('pi failed: pi was not started: its isolated worktree was not found')
  expect(result.answer).toContain('agent-a1')
  expect(result.answer).toContain('never in another checkout')
  expect(result.answer).not.toContain('SendMessage to this agent retries')
  expect(result.answer).not.toContain('[worktree')
  expect(w.claudeSteps).toBe(0)
})

test('a resume whose worktree is gone fails without the old worktree or a retry hint', async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  w.git.worktrees = false
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go on' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  const { result } = await step($, 'a1')
  expect(w.spawns.length).toBe(1)
  expect(result.answer).toContain('start a new agent instead of resuming')
  expect(result.answer).not.toContain('SendMessage to this agent retries')
  expect(result.answer).not.toContain('[worktree')
})

test("the caller's checkout is read at the Agent call, whatever the agent's own hook is told", async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  // As if inside the agent's hook the session's root were the agent's own worktree.
  w.root = '/repo/.claude/worktrees/agent-a1'
  await step($, 'a1')
  expect(w.gitRuns.find(r => r.argv[0] === 'reset')?.argv).toEqual(['reset', '--hard', 'aaa1111'])
  expect(promptOf(w)).toContain('do not cd into or edit anything under /repo. ')
})

test('after a reload a worktree agent resumes in its worktree with its message, not reset again', async ($, on) => {
  const kept = { id: 'a1', type: 'general-purpose', description: 'd', readOnly: false, isolated: true, repo: '/repo', based: 'aaa1111' }
  const w = world(on, { 'agent:a1': kept })
  w.spawned.push('a1')
  w.git.sessionHead = 'ccc3333'
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go on' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  const { result } = await step($, 'a1')
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(w.gitRuns.some(r => r.argv[0] === 'reset')).toBe(false)
  expect(promptOf(w)).toContain('go on')
  expect(promptOf(w)).not.toContain('isolated git worktree')
  expect(result.answer).toContain('[worktree · /repo/.claude/worktrees/agent-a1')
  expect(w.claudeSteps).toBe(0)
})

test('only the first run points the worktree at the session and briefs pi', async ($, on) => {
  const w = world(on)
  await launch($, w, worktreeAgent)
  await step($, 'a1')
  w.git.sessionHead = 'ccc3333'
  w.writes.clear()
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go on' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  await step($, 'a1')
  expect(w.gitRuns.filter(r => r.argv[0] === 'reset').length).toBe(1)
  expect(w.spawns[1]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
  expect(promptOf(w)).toContain('go on')
  expect(promptOf(w)).not.toContain('isolated git worktree')
})

test('an agent without isolation never touches git', async ($, on) => {
  const w = world(on)
  await launch($, w, { subagent_type: 'general-purpose' })
  const { result } = await step($, 'a1')
  expect(w.gitRuns.length).toBe(0)
  expect(result.answer).not.toContain('[worktree')
})

test('the Agent description says where a worktree starts', async ($, on) => {
  world(on)
  const d = await $.tool.describe({ tool: 'Agent', description: 'BASE', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(d.description).toContain("session's current HEAD")
  expect(d.description).toContain('origin/main')
})

test('a long silent tool is kept alive by beats', async ($, on) => {
  const w = world(on)
  w.pi.beats = 3
  await launch($, w, { subagent_type: 'general-purpose' })
  // One for pi's first output, then one per beat while its tool runs.
  expect((await step($, 'a1')).beats).toBe(4)
})

test('beats before pi has started a tool do not keep a silent model alive', async ($, on) => {
  const w = world(on)
  w.pi.earlyBeats = 3
  await launch($, w, { subagent_type: 'general-purpose' })
  expect((await step($, 'a1')).beats).toBe(1)
})

test('a tool whose end never came stops beating once its turn has ended', async ($, on) => {
  const w = world(on)
  w.pi.beats = 1
  w.pi.lostEnd = true
  w.pi.lateBeats = 3
  await launch($, w, { subagent_type: 'general-purpose' })
  expect((await step($, 'a1')).beats).toBe(2)
})

test('a step the engine closes mid-run stops the agent and kills pi with its commands', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.pi.gate = new Promise<void>(r => (release = r))
  await launch($, w, { subagent_type: 'general-purpose', name: 'closed' })
  const stream = $.turn.step({ turnId: 'Tc', index: 0, model: 'claude-x', messageCount: 1, agentId: 'a1' })
  const first = await stream.next()
  expect(!first.done && first.value.kind).toBe('thinking')
  const closing = stream.return(undefined as never)
  release()
  await closing.catch(() => undefined)
  expect(w.runs.some(a => a[0] === 'bash' && a[2]?.includes('pgrep') && a.includes('4242'))).toBe(true)
  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'xc' } as never)
  expect(JSON.stringify(list)).toContain('a1 (closed) · general-purpose · stopped')
})

test('beats never reach the failure report', async ($, on) => {
  const w = world(on)
  w.pi.fail = 'Error: Model "x" not found.'
  w.pi.earlyBeats = 2
  await launch($, w, { subagent_type: 'general-purpose' })
  const { result } = await step($, 'a1')
  expect(result.answer).not.toContain('PI_BEAT')
})

test('pi failing is reported as the answer, never retried on Claude', async ($, on) => {
  const w = world(on)
  w.pi.fail = 'Error: Model "x" not found.'
  await launch($, w, ({ subagent_type: 'general-purpose' }))
  const { result } = await step($, 'a1')
  expect(result.answer).toContain('pi failed')
  expect(result.answer).toContain('Model "x" not found')
  expect(w.claudeSteps).toBe(0)
})

test('a resumed agent continues its pi session with the new message', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose' }))
  await step($, 'a1')
  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'and the codeword?' }] },
    door: 'delivery',
    origin: { kind: 'tool', tool: 'SendMessage' },
    uuid: 'r1',
    agentId: 'a1',
  } as never)
  await step($, 'a1')
  expect(after(argvOf(w), '--session')).toBe(`${HOME}/.pi/claude-subagents/2026-01-01_a1.jsonl`)
  expect(w.writes.get(`${HOME}/.pi/claude-subagents/a1.cmd.jsonl`)).toContain('and the codeword?')
})

test('SendMessage steers a working agent; otherwise the engine delivers', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.pi.gate = new Promise<void>(r => (release = r))
  await launch($, w, ({ subagent_type: 'general-purpose', name: 'worker' }))
  const running = step($, 'a1')
  while (!w.spawns.length) await new Promise(r => setTimeout(r, 5))
  const steered = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's1', to: 'a1', message: 'change course' } as never)
  expect(JSON.stringify(steered)).toContain('Steering message queued')
  expect(w.runs.some(a => a[0] === 'bash' && a.some(x => x.includes('"type":"steer"') && x.includes('change course')))).toBe(true)
  release()
  await running
  const later = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's2', to: 'a1', message: 'hi' } as never)
  expect(JSON.stringify(later)).toContain('engine delivered')
  const unknown = await $.tool.call({ tool: 'SendMessage', tool_use_id: 's3', to: 'nobody', message: 'hi' } as never)
  expect(JSON.stringify(unknown)).toContain('engine delivered')
})

test('activity lists and pages; watch notices wake an idle session and join a busy turn', async ($, on) => {
  const w = world(on)
  const clock = mock.clock(on)
  const session = mock.session(on)
  let release = () => {}
  w.pi.gate = new Promise<void>(r => (release = r))
  await launch($, w, ({ subagent_type: 'general-purpose', name: 'watched' }))
  const running = step($, 'a1')
  while (!w.spawns.length) await new Promise(r => setTimeout(r, 5))
  await new Promise(r => setTimeout(r, 20))

  const list = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x1' } as never)
  expect(JSON.stringify(list)).toContain('a1 (watched)')
  const page = await $.tool.call({ tool: 'mcp__pi-subagent__subagent_activity', tool_use_id: 'x2', agent_id: 'watched' } as never)
  expect(JSON.stringify(page)).toContain('read {')
  const bad = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x3', action: 'start', agent_id: 'nobody' } as never)
  expect(JSON.stringify(bad)).toContain('deny')

  const started = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x4', action: 'start', agent_id: 'watched', interval_seconds: 5 } as never)
  expect(JSON.stringify(started)).toContain('every 30s')
  await clock.advance(30_000)
  await clock.settle()
  expect(w.submitted.some(t => t.includes('<pi-subagent-watch>'))).toBe(true)

  // A main model request marks the loop busy, as after a reload mid-turn.
  await step($, undefined as never)
  const before = w.submitted.length
  await clock.advance(30_000)
  await clock.settle()
  expect(w.submitted.length).toBe(before)
  expect(session.appended().some(r => !r.agentId && JSON.stringify(r.message.content).includes('<pi-subagent-watch>'))).toBe(true)

  const status = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x5', action: 'status', agent_id: 'watched' } as never)
  expect(JSON.stringify(status)).toContain('Watching a1 every 30s')
  release()
  await running
  const done = await $.tool.call({ tool: 'mcp__pi-subagent__watch_subagent', tool_use_id: 'x6', action: 'status', agent_id: 'watched' } as never)
  expect(JSON.stringify(done)).toContain('is not watched (completed)')
})
