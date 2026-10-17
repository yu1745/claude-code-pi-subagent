// One line of a subagent's live activity, as the band above the prompt draws it.
export type LiveLine = { seq: number; kind: string; text: string }

// What the band shows for one pi-backed subagent while its transcript is open.
export type Live = { label: string; status: string; model?: string; steps: number; lines: LiveLine[] }

declare module 'claude-code' {
  interface PluginState {
    'pi-subagent': { live: StateFamily<Live> }
  }
}
