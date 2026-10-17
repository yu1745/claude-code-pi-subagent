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

type PiScript = { answer?: string; fail?: string; gate?: Promise<void> }

type World = {
  spawns: { argv: readonly string[]; cwd?: string }[]
  runs: (readonly string[])[]
  writes: Map<string, string>
  submitted: string[]
  claudeSteps: number
  spawned: string[]
  agentCalls: (Record<string, unknown> & { done?: () => void })[]
  pi: PiScript
}

const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On): World {
  const w: World = { spawns: [], runs: [], writes: new Map(), submitted: [], claudeSteps: 0, spawned: [], agentCalls: [], pi: {} }
  const sessionFiles = new Set<string>()
  let agents = 0
  mock.env(on, { HOME })
  mock.store(on)

  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === `${HOME}/.pi/agent/settings.json` }))
  on('fs.read', ($, e) => ({ value: e.path === `${HOME}/.pi/agent/settings.json` ? SETTINGS : '' }))
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
    if (cmd === 'git' && rest[0] === 'worktree') {
      return ok(w.spawned.map(id => `worktree /repo/.claude/worktrees/agent-${id}\nHEAD abc\n`).join('\n') + 'worktree /repo\n')
    }
    return ok()
  })
  on('process.spawn', async function* ($, e) {
    w.spawns.push({ argv: e.argv, cwd: e.cwd })
    const id = e.argv[e.argv.indexOf('--session-id') + 1]
    if (e.argv.includes('--session-id') && id) sessionFiles.add(`2026-01-01_${id}.jsonl`)
    yield { stream: 'stderr' as const, text: 'PI_PID 4242\n' }
    if (w.pi.fail) {
      yield { stream: 'stderr' as const, text: `${w.pi.fail}\n` }
      return { value: { code: 1, signal: null } }
    }
    const line = (ev: object) => ({ stream: 'stdout' as const, text: JSON.stringify(ev) + '\n' })
    yield line({ type: 'session', cwd: e.cwd })
    yield line({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } })
    yield line({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.txt' } })
    yield line({ type: 'tool_execution_end', toolName: 'read', result: { content: [{ type: 'text', text: 'hello' }] }, isError: false })
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
  const settled = await Promise.race([call.then(() => 'settled'), new Promise(r => setTimeout(() => r('open'), 50))])
  if (settled === 'settled' && w.agentCalls.length === seen) return call
  while (w.agentCalls.length === seen) await new Promise(r => setTimeout(r, 2))
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
  for (;;) {
    const r = await stream.next()
    if (r.done) return { texts, result: r.value }
    if (r.value.kind === 'text') texts.push(r.value.text)
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

test('a worktree agent runs pi in its own worktree', async ($, on) => {
  const w = world(on)
  await launch($, w, ({ subagent_type: 'general-purpose', isolation: 'worktree' }))
  await step($, 'a1')
  expect(w.spawns[0]?.cwd).toBe('/repo/.claude/worktrees/agent-a1')
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
