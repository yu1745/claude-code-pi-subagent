import { test, expect } from 'claude-code/testing'
import {
  type Activity,
  READ_ONLY_NOTE,
  SECTION_CHARS,
  activityPage,
  clampInterval,
  clip,
  detailPage,
  dialogId,
  digest,
  findAgentWorktree,
  hasThinkingSuffix,
  isReadOnlyType,
  missingWorktreeAdvice,
  newStats,
  piArgv,
  parseDefault,
  parseModelList,
  resolveScoped,
  scopeModels,
  scopedNote,
  parseWorktrees,
  piStderr,
  piVersionNote,
  pushActivity,
  resolveAgent,
  rpc,
  splitBeats,
  splitType,
  watchSection,
  worktreeFooter,
  worktreePreface,
} from './core'

test('splitType: type, model and thinking suffix', () => {
  expect(splitType('Explore@codebuddy/glm-5.3:high')).toEqual({ type: 'Explore', model: 'codebuddy/glm-5.3:high' })
  expect(splitType('@codebuddy/glm-5.3')).toEqual({ type: 'general-purpose', model: 'codebuddy/glm-5.3' })
  expect(splitType('Plan@')).toEqual({ type: 'Plan', model: undefined })
  expect(splitType('Plan')).toEqual({ type: 'Plan' })
  expect(splitType('')).toEqual({ type: 'general-purpose' })
  expect(splitType(undefined)).toEqual({ type: 'general-purpose' })
})

test('read-only types are case-insensitive', () => {
  expect(isReadOnlyType('Explore')).toBe(true)
  expect(isReadOnlyType('PLAN')).toBe(true)
  expect(isReadOnlyType('claude-code-guide')).toBe(true)
  expect(isReadOnlyType('general-purpose')).toBe(false)
})

test('piArgv: wrapper, session, model, thinking, read-only', () => {
  const plain = piArgv({ cmdFile: '/c', session: ['--session-dir', '/d', '--session-id', 'x'], readOnly: false })
  expect(plain.slice(0, 2)).toEqual(['bash', '-c'])
  expect(plain.slice(3)).toEqual(['pi-subagent', '/c', 'pi', '--mode', 'rpc', '--session-dir', '/d', '--session-id', 'x'])
  const full = piArgv({ cmdFile: '/c', session: ['--session', '/s.jsonl'], readOnly: true, model: 'p/m', thinking: 'high' })
  expect(full.slice(5)).toEqual([
    'pi', '--mode', 'rpc', '--session', '/s.jsonl', '--model', 'p/m', '--thinking', 'high',
    '--tools', 'read,grep,find,ls', '--append-system-prompt', READ_ONLY_NOTE,
  ])
})

test('rpc commands are one JSON line each', () => {
  expect(JSON.parse(rpc.prompt('a\nb'))).toEqual({ type: 'prompt', message: 'a\nb' })
  expect(rpc.prompt('a\nb').includes('\n')).toBe(false)
  expect(JSON.parse(rpc.steer('s'))).toEqual({ type: 'steer', message: 's' })
  expect(JSON.parse(rpc.abort())).toEqual({ type: 'abort' })
  expect(JSON.parse(rpc.cancelDialog('u1'))).toEqual({ type: 'extension_ui_response', id: 'u1', cancelled: true })
})

test('dialogId: only blocking dialogs', () => {
  for (const method of ['select', 'confirm', 'input', 'editor']) {
    expect(dialogId({ type: 'extension_ui_request', id: 'q', method })).toBe('q')
  }
  for (const method of ['setStatus', 'setTitle', 'setWidget', 'notify']) {
    expect(dialogId({ type: 'extension_ui_request', id: 'q', method })).toBeUndefined()
  }
  expect(dialogId({ type: 'response', id: 'q', method: 'confirm' })).toBeUndefined()
})

test('piStderr drops the wrapper pid and beat lines and the new-session warning', () => {
  const raw = "PI_PID 42\nWarning: No project session found with id 'x'; creating a new session with that id.\nError: Model \"m\" not found."
  expect(piStderr(raw)).toBe('Error: Model "m" not found.')
})

test('clip flattens whitespace and cuts', () => {
  expect(clip('a\n\n b  c', 10)).toBe('a b c')
  expect(clip('abcdefghij', 5)).toBe('abcd…')
})

test('digest: user, assistant text, usage and model', () => {
  const s = newStats()
  expect(digest({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }, s)).toEqual([
    { kind: 'user', summary: 'do it', detail: 'do it' },
  ])
  const out = digest(
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        provider: 'acme',
        model: 'ds',
        content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hello' }],
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 },
        stopReason: 'stop',
      },
    },
    s,
  )
  expect(out.map(o => o.kind)).toEqual(['text'])
  expect(s.answer).toBe('hello')
  expect(s.model).toBe('acme/ds')
  expect(s.usage).toEqual({ input: 10, output: 2, cacheRead: 3, cacheWrite: 1 })
  digest({ type: 'message_end', message: { role: 'assistant', model: 'only', content: 'plain', usage: { input: 1 } } }, s)
  expect(s.model).toBe('only')
  expect(s.answer).toBe('plain')
  expect(s.usage.input).toBe(11)
  expect(digest({ type: 'message_end', message: { role: 'system', content: 'x' } }, s)).toEqual([])
  expect(digest({ type: 'message_end', message: { role: 'user', content: [] } }, s)).toEqual([])
})

test('digest: model error, then recovery clears it', () => {
  const s = newStats()
  const out = digest({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529' } }, s)
  expect(out).toEqual([{ kind: 'error', summary: '529', detail: '529' }])
  expect(s.error).toBe('529')
  digest({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error' } }, s)
  expect(s.error).toBe('model error')
  digest({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'toolUse' } }, s)
  expect(s.error).toBeUndefined()
})

test('digest: tools, nested tools, results, errors', () => {
  const s = newStats()
  const [start] = digest({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'ls' } }, s)
  expect(start!.kind).toBe('tool')
  expect(start!.summary).toBe('bash {"command":"ls"}')
  const [nested] = digest({ type: 'tool_execution_start', toolName: 'bash', args: {}, parentToolCallId: 'p' }, s)
  expect(nested!.summary.startsWith('↳ bash')).toBe(true)
  expect(s.steps).toBe(2)
  const [ok] = digest({ type: 'tool_execution_end', toolName: 'bash', result: { content: [{ type: 'text', text: 'out' }] }, isError: false }, s)
  expect(ok).toEqual({ kind: 'result', summary: 'bash: out', detail: 'out' })
  const [bad] = digest({ type: 'tool_execution_end', toolName: 'edit', result: {}, isError: true }, s)
  expect(bad!.kind).toBe('error')
  expect(bad!.summary).toBe('edit failed: (no output)')
})

test('digest: retries, compaction, settle, refused command, others', () => {
  const s = newStats()
  expect(digest({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '529 overloaded' }, s)[0]!.kind).toBe('retry')
  expect(digest({ type: 'auto_retry_end', success: true }, s)).toEqual([])
  expect(digest({ type: 'auto_retry_end', success: false }, s)[0]!.kind).toBe('error')
  expect(digest({ type: 'compaction_start', reason: 'threshold' }, s)[0]!.kind).toBe('note')
  expect(digest({ type: 'response', command: 'prompt', success: true }, s)).toEqual([])
  expect(digest({ type: 'response', command: 'prompt', success: false, error: 'bad model' }, s)[0]!.kind).toBe('error')
  expect(s.error).toBe('pi refused prompt: bad model')
  expect(digest({ type: 'agent_start' }, s)).toEqual([])
  digest({ type: 'agent_settled', aborted: true }, s)
  expect(s.settled).toBe(true)
  expect(s.aborted).toBe(true)
})

const mk = (n: number, from = 1, at = 0): Activity[] => {
  const events: Activity[] = []
  let seq = from
  for (let i = 0; i < n; i++) seq = pushActivity(events, seq, at + i * 1000, [{ kind: 'tool', summary: `t${seq}`, detail: `d${seq}` }])
  return events
}

test('pushActivity numbers events and keeps the last 400', () => {
  const events = mk(405)
  expect(events.length).toBe(400)
  expect(events[0]!.seq).toBe(6)
  expect(events.at(-1)?.seq).toBe(405)
})

test('activityPage: snapshot, cursor, limit bounds, gap, invalid', () => {
  const events = mk(12)
  const snap = activityPage(events, 0, {})
  expect(snap.text).toContain('(4 earlier retained events omitted')
  expect(snap.text).toContain('[12 +11s tool] t12')
  expect(snap.cursor).toBe('12')
  const after = activityPage(events, 0, { cursor: '3', limit: 2 })
  expect(after.text).toContain('[4 ')
  expect(after.text).toContain('[5 ')
  expect(after.text).not.toContain('[6 ')
  expect(after.text).toContain('cursor: 5 (more after it)')
  expect(activityPage(events, 0, { cursor: '12' }).text).toContain('(no new activity)')
  expect(activityPage(events, 0, { limit: 0 }).text.split('\n').filter(l => l.startsWith('[')).length).toBe(1)
  expect(activityPage(events, 0, { limit: 99 }).text.split('\n').filter(l => l.startsWith('[')).length).toBe(12)
  expect(activityPage(mk(5, 50), 0, { cursor: '10' }).text).toContain('(gap: events 11..49')
  expect(activityPage(events, 0, { cursor: 'x' }).text).toBe('Invalid cursor "x".')
  expect(activityPage([], 0, {}).text).toContain('(no new activity)')
})

test('activityPage stays under its page size', () => {
  const events: Activity[] = []
  pushActivity(events, 1, 0, Array.from({ length: 20 }, () => ({ kind: 'text' as const, summary: 'x'.repeat(600), detail: '' })))
  const page = activityPage(events, 0, { limit: 20 })
  expect(page.text.length).toBeLessThan(9200)
  expect(page.text).toContain('(page full)')
  expect(page.text).toContain('(more after it)')
})

test('detailPage: paging and missing', () => {
  const a = mk(1)[0]!
  a.detail = 'abcdefghij'
  expect(detailPage(a, 0, 4)).toContain('abcd\nnext_offset: 4\nhas_more: true')
  expect(detailPage(a, 8, 4)).toContain('ij\nnext_offset: 10\nhas_more: false')
  expect(detailPage(undefined)).toContain('Activity unavailable')
  a.detail = ''
  expect(detailPage(a)).toContain(a.summary)
})

test('watchSection: fresh, silent, bounded with catch-up cursor, brief and criteria', () => {
  const events = mk(3, 1, 0)
  const w = { id: 'pi-1', label: 'explore: x', status: 'running', brief: 'auth', criteria: 'no edits' }
  const fresh = watchSection(w, events, 1, 0, 10_000)
  expect(fresh.cursor).toBe(3)
  expect(fresh.text).toContain('review brief: auth')
  expect(fresh.text).toContain('criteria: no edits')
  expect(fresh.text).toContain('[2 ')
  expect(fresh.text).toContain('last activity 8s ago')
  const silent = watchSection({ id: 'pi-1', label: 'l', status: 'running' }, events, 3, 0, 10_000)
  expect(silent.cursor).toBe(3)
  expect(silent.text).toContain('no new public activity')
  const big: Activity[] = []
  pushActivity(big, 1, 0, Array.from({ length: 50 }, (_, i) => ({ kind: 'text' as const, summary: `${i} ${'y'.repeat(150)}`, detail: '' })))
  const bounded = watchSection({ id: 'pi-1', label: 'l', status: 'running' }, big, 0, 0, 1000)
  expect(bounded.text.length).toBeLessThanOrEqual(SECTION_CHARS)
  expect(bounded.text).toContain('catch-up cursor <0>')
  expect(bounded.cursor).toBe(50)
  expect(bounded.text).toContain('[50 ')
})

test('clampInterval', () => {
  expect(clampInterval(undefined)).toBe(240)
  expect(clampInterval(5)).toBe(30)
  expect(clampInterval(99999)).toBe(3600)
  expect(clampInterval(90.7)).toBe(90)
})

test('resolveAgent: id, name, prefix, ambiguous, short, missing', () => {
  const list = [
    { id: 'pi-abcdef12-1', name: 'auth' },
    { id: 'pi-abcdef12-2' },
    { id: 'pi-zzzzzzzz-3' },
  ]
  expect(resolveAgent(list, 'pi-abcdef12-2').agent?.id).toBe('pi-abcdef12-2')
  expect(resolveAgent(list, 'auth').agent?.id).toBe('pi-abcdef12-1')
  expect(resolveAgent(list, 'pi-zzzzz').agent?.id).toBe('pi-zzzzzzzz-3')
  expect(resolveAgent(list, 'pi-abcdef').error).toContain('matches 2')
  expect(resolveAgent(list, 'pi-z').error).toContain('No pi subagent')
  expect(resolveAgent(list, 'pi-nothing-here').error).toContain('No pi subagent')
})

const LIST = `provider                 model                                               context  max-out  thinking  images
codebuddy                deepseek-v4.1-flash (x0.11)                         1M       128K     yes       yes
openrouter               deepseek/deepseek-v4.1-flash:batch                  1.0M     384K     yes       yes
acme                     deepseek-ai/DeepSeek-V4.1-Flash                     1.0M     384K     yes       yes
zai-coding-cn            glm-5.3                                             1M       131.1K   yes       no
zai-coding-cn            glm-5.3-flashx                                      1M       131.1K   yes       yes
`

test('parseModelList keeps spaces and colons in model ids', () => {
  const m = parseModelList(LIST)
  expect(m.length).toBe(5)
  expect(m[0]).toEqual({ id: 'codebuddy/deepseek-v4.1-flash (x0.11)', context: '1M', maxOut: '128K', thinking: true, images: true })
  expect(m[1]!.id).toBe('openrouter/deepseek/deepseek-v4.1-flash:batch')
  expect(m[3]!.images).toBe(false)
  expect(parseModelList('')).toEqual([])
})

test('scopeModels keeps order, expands globs, dedups, keeps unknown ids', () => {
  const listed = parseModelList(LIST)
  const ids = scopeModels(['zai-coding-cn/glm-5.3', 'zai-coding-cn/*', 'codebuddy/deepseek-v4.1-flash (x0.11)', 'gone/model'], listed).map(m => m.id)
  expect(ids).toEqual(['zai-coding-cn/glm-5.3', 'zai-coding-cn/glm-5.3-flashx', 'codebuddy/deepseek-v4.1-flash (x0.11)', 'gone/model'])
})

test('resolveScoped: exact, suffix-free, bare name, thinking, ambiguous, refused', () => {
  const scoped = scopeModels(['zai-coding-cn/glm-5.3', 'codebuddy/deepseek-v4.1-flash (x0.11)', 'acme/deepseek-ai/DeepSeek-V4.1-Flash', 'openrouter/deepseek/deepseek-v4.1-flash:batch'], parseModelList(LIST))
  expect(resolveScoped('zai-coding-cn/glm-5.3', scoped)).toEqual({ model: 'zai-coding-cn/glm-5.3' })
  expect(resolveScoped('codebuddy/deepseek-v4.1-flash', scoped)).toEqual({ model: 'codebuddy/deepseek-v4.1-flash (x0.11)' })
  expect(resolveScoped('codebuddy/DeepSeek-V4.1-Flash:high', scoped)).toEqual({ model: 'codebuddy/deepseek-v4.1-flash (x0.11):high' })
  expect(resolveScoped('glm-5.3', scoped)).toEqual({ model: 'zai-coding-cn/glm-5.3' })
  expect(resolveScoped('openrouter/deepseek/deepseek-v4.1-flash:batch', scoped)).toEqual({ model: 'openrouter/deepseek/deepseek-v4.1-flash:batch' })
  expect(resolveScoped('openrouter/deepseek/deepseek-v4.1-flash:batch:low', scoped)).toEqual({ model: 'openrouter/deepseek/deepseek-v4.1-flash:batch:low' })
  const refused = resolveScoped('openrouter/openai/gpt-6-sol', scoped)
  expect('error' in refused && refused.error).toContain('not one of the scoped models')
  const twin = scopeModels(['a/x', 'b/x'], [])
  const amb = resolveScoped('x', twin)
  expect('error' in amb && amb.error).toContain('matches several')
})

test('scopedNote marks the default and capabilities', () => {
  const note = scopedNote(parseModelList(LIST).slice(3), 'zai-coding-cn/glm-5.3')
  expect(note).toContain('- zai-coding-cn/glm-5.3 (default) · ctx 1M · out 131.1K · thinking\n')
  expect(note).toContain('glm-5.3-flashx · ctx 1M · out 131.1K · thinking · images')
  expect(note).toContain('any other model is refused')
  expect(scopedNote(scopeModels(['a/x'], []), '')).toContain('  - a/x\n')
})

test('piVersionNote: tested, other version, missing', () => {
  expect(piVersionNote('1.2.0\n')).toBeUndefined()
  expect(piVersionNote('pi 1.2.7')).toBeUndefined()
  expect(piVersionNote('1.3.0')).toContain('found 1.3.0')
  expect(piVersionNote('1.20.0')).toContain('found 1.20.0')
  expect(piVersionNote(undefined)).toContain('not on PATH')
})

test('splitBeats takes the wrapper beats out of a stderr chunk', () => {
  expect(splitBeats('PI_BEAT\nPI_BEAT\n')).toEqual({ beats: 2, rest: '' })
  expect(splitBeats('PI_PID 7\nPI_BEAT\nwarn\n')).toEqual({ beats: 1, rest: 'PI_PID 7\nwarn\n' })
  expect(splitBeats('not PI_BEAT\n')).toEqual({ beats: 0, rest: 'not PI_BEAT\n' })
  expect(piStderr('PI_PID 7\nPI_BEAT\nreal error')).toBe('real error')
})

test('the wrapper beats while pi lives and stays out of its stdout', () => {
  const wrapper = piArgv({ cmdFile: '/c', session: [], readOnly: false })[2] ?? ''
  expect(wrapper).toContain('echo PI_BEAT >&2')
  expect(wrapper).toContain('kill -0 $$')
  expect(wrapper).toContain('>/dev/null &')
  expect(wrapper).toContain('exec "$@"')
})

const PORCELAIN = `worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo/.claude/worktrees/agent-a3c15e4c0870736b3
HEAD bbb
branch refs/heads/worktree-agent-a3c15e4c0870736b3

worktree /tmp/taskc-verify
HEAD ccc
detached
`

test('parseWorktrees: path, head and branch, main tree first', () => {
  expect(parseWorktrees(PORCELAIN)).toEqual([
    { path: '/repo', head: 'aaa', branch: 'main' },
    { path: '/repo/.claude/worktrees/agent-a3c15e4c0870736b3', head: 'bbb', branch: 'worktree-agent-a3c15e4c0870736b3' },
    { path: '/tmp/taskc-verify', head: 'ccc' },
  ])
  expect(parseWorktrees('')).toEqual([])
})

test('findAgentWorktree: exact name or branch only, never the main tree, never a guess', () => {
  const list = parseWorktrees(PORCELAIN)
  expect(findAgentWorktree(list, 'a3c15e4c0870736b3')).toEqual({ worktree: list[1] })
  // The engine's older short spelling.
  const short = [{ path: '/repo' }, { path: '/repo/.claude/worktrees/agent-3c15e4c0' }]
  expect(findAgentWorktree(short, 'a3c15e4c0870736b3')).toEqual({ worktree: short[1] })
  // A hand-made worktree that merely mentions the id is not it.
  const lookalike = [{ path: '/repo' }, { path: '/tmp/a3c15e4c0870736b3-verify' }, { path: '/tmp/taskc-verify' }]
  expect(findAgentWorktree(lookalike, 'a3c15e4c0870736b3')).toHaveProperty('error')
  // The main tree is not a candidate even when its own name matches.
  expect(findAgentWorktree([{ path: '/work/agent-a1' }], 'a1')).toHaveProperty('error')
  const twice = [{ path: '/repo' }, { path: '/x/agent-a1' }, { path: '/y/agent-a1' }]
  const e = findAgentWorktree(twice, 'a1')
  expect('error' in e && e.error).toContain('2 worktrees match')
  const none = findAgentWorktree([{ path: '/repo' }], 'a1')
  expect('error' in none && none.error).toContain('no worktree named agent-a1')
})

test('worktreePreface and worktreeFooter', () => {
  const w = { path: '/r/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1', repo: '/r', head: 'abc1234 subject' }
  const ok = worktreePreface(w)
  expect(ok).toContain('/r/.claude/worktrees/agent-a1 (branch worktree-agent-a1)')
  expect(ok).toContain('It is at abc1234 subject.')
  expect(ok).toContain('uncommitted changes in the caller')
  expect(ok).toContain('do not cd into or edit anything under /r')
  expect(worktreePreface({ ...w, sessionHead: 'def5678' })).toContain("caller's checkout is at def5678, which this worktree could not be pointed at")
  expect(worktreeFooter(w)).toBe('[worktree · /r/.claude/worktrees/agent-a1 · branch worktree-agent-a1]')
  expect(worktreeFooter({ path: '/w' })).toBe('[worktree · /w]')
})

test('parseDefault: @default and @default:<thinking>, nothing else', () => {
  expect(parseDefault('default')).toEqual({})
  expect(parseDefault('Default:HIGH')).toEqual({ level: 'high' })
  expect(parseDefault('default:loud')).toHaveProperty('error')
  expect(parseDefault('default:high:x')).toHaveProperty('error')
  expect(parseDefault('codebuddy/default')).toBeUndefined()
  expect(parseDefault('defaults')).toBeUndefined()
  expect(parseDefault(undefined)).toBeUndefined()
})

test('hasThinkingSuffix: a trailing level only', () => {
  expect(hasThinkingSuffix('codebuddy/glm-5.3:high')).toBe(true)
  expect(hasThinkingSuffix('openrouter/deepseek/deepseek-v4.1-flash:batch')).toBe(false)
  expect(hasThinkingSuffix('openrouter/x:free:low')).toBe(true)
  expect(hasThinkingSuffix(':high')).toBe(false)
  expect(hasThinkingSuffix('glm-5.3')).toBe(false)
  expect(hasThinkingSuffix(undefined)).toBe(false)
})

test('missingWorktreeAdvice: a resume is told to start afresh, a first run that pi never strays', () => {
  expect(missingWorktreeAdvice(true)).toContain('start a new agent instead of resuming')
  expect(missingWorktreeAdvice(false)).toContain('never in another checkout')
})
