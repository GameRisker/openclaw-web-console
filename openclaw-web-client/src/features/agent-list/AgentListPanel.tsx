import type { AgentItem, AgentListStatus } from '../../types/app'
import { formatSessionRelativeTime } from '../session-list/formatRelativeTime'

export type AgentListPanelProps = {
  agents: AgentItem[]
  activeAgentId: string
  status: AgentListStatus
  onSelectAgent: (agentId: string) => void
  onRefreshAgents: () => void
  onRequestAddAgent: () => void
}

export function AgentListPanel({
  agents,
  activeAgentId,
  status,
  onSelectAgent,
  onRefreshAgents,
  onRequestAddAgent,
}: AgentListPanelProps) {
  return (
    <div className="sidebar-panel-section">
      <h2 className="sr-only">Agents</h2>
      <div className="session-list compact-session-list sidebar-panel-list-body">
        {status === 'loading' && (
          <article className="session-card muted">
            <p className="session-subtitle">正在加载 Agent 列表…</p>
          </article>
        )}
        {status === 'error' && (
          <article className="session-card muted">
            <p className="session-subtitle">Agent 列表加载失败，请检查网关或稍后重试。</p>
          </article>
        )}
        {status === 'unsupported' && (
          <article className="session-card muted">
            <p className="session-subtitle">网关未提供 <code className="inline-code">GET /api/agents</code>（404/501）。</p>
          </article>
        )}
        {(status === 'loaded' || status === 'empty') && agents.length === 0 && (
          <article className="session-card muted">
            <p className="session-subtitle">暂无 Agent 记录。</p>
          </article>
        )}
        {agents.map((agent) => (
          <article
            key={agent.id}
            className={`session-card ${agent.id === activeAgentId ? 'active' : ''}`}
            onClick={() => onSelectAgent(agent.id)}
          >
            <div className="session-card-body">
              <h3 className="session-title">{agent.summary}</h3>
              <p className="session-subtitle">
                {`${agent.subtitle || 'agent'} · ${formatSessionRelativeTime(agent.updatedAt)}`}
              </p>
            </div>
            <div className="session-card-actions">
              <span className={`mini-state ${agent.state}`}>{agent.state}</span>
            </div>
          </article>
        ))}
      </div>
      <div className="sidebar-list-footer" role="toolbar" aria-label="Agent 列表操作">
        <button type="button" className="icon-button sidebar-icon-btn" onClick={onRefreshAgents} title="刷新 Agent 列表">
          ↻
        </button>
        <button
          type="button"
          className="icon-button sidebar-icon-btn"
          title="新建 Agent"
          onClick={() => onRequestAddAgent()}
        >
          ＋
        </button>
      </div>
    </div>
  )
}
