import type { AgentItem, SessionItem } from '../types/app'

/**
 * 与桥接 agentsDerivedFromSessionsList 一致：session.key 中 agent:<槽位>:…，否则归入 _other。
 */
export function agentSlotFromSessionKey(key: string | undefined): string {
  if (!key) return '_other'
  const m = /^agent:([^:]+):/.exec(key.trim())
  return m ? m[1] : '_other'
}

export function sessionVisibleForAgentSlot(sessionKey: string | undefined, activeAgentId: string): boolean {
  if (!activeAgentId) return true
  return agentSlotFromSessionKey(sessionKey) === activeAgentId
}

/** Agent 设置弹窗初始值：优先该槽位下首个会话的模型/verbose/think，否则用 Agent 列表元数据 */
export function deriveAgentSettingsSnapshot(
  slot: string,
  agents: AgentItem[],
  sessions: SessionItem[],
): { label: string; model?: string; modelProvider?: string; verbose?: boolean; think?: string } {
  const ai = agents.find((a) => a.id === slot)
  const under = sessions.filter((s) => agentSlotFromSessionKey(s.key) === slot)
  const rep = under[0]
  const label = (ai?.summary ?? slot).trim() || slot
  const model = (rep?.model ?? ai?.model ?? '').trim() || undefined
  const modelProvider = (rep?.modelProvider ?? ai?.modelProvider ?? '').trim() || undefined
  return {
    label,
    model,
    modelProvider,
    verbose: rep?.verbose,
    think: rep?.think,
  }
}
