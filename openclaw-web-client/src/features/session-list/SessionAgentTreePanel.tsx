import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentItem, AgentListStatus, SessionItem } from '../../types/app'
import { agentSlotFromSessionKey } from '../../utils/agentSession'
import { formatSessionRelativeTime } from './formatRelativeTime'

export type SessionAgentTreePanelProps = {
  sessions: SessionItem[]
  agents: AgentItem[]
  agentListStatus: AgentListStatus
  activeSessionId: string
  activeAgentId: string
  sessionSearch: string
  onSessionSearchChange: (value: string) => void
  onSelectSession: (sessionId: string) => void
  onSelectAgent: (slot: string) => void
  onRefreshTree: () => void | Promise<void>
  onRequestCreateSession: () => void | Promise<void>
  onRequestAddAgent: () => void
  onBeginRenameSession: (sessionId: string, currentTitle: string) => void
  onRequestDeleteSession: (sessionId: string, summary: string) => void
  /** 打开 Agent 设置（名称、模型、verbose、think、删除） */
  onOpenAgentSettings?: (slot: string) => void
}

type TreeGroup = {
  slot: string
  title: string
  subtitle: string
  sessions: SessionItem[]
}

function SessionTreeAgentGearIcon() {
  return (
    <svg className="session-tree-agent-gear-svg" viewBox="0 0 24 24" width={14} height={14} aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.09-.68-1.69-.87l-.38-2.65A.506.506 0 0016 2h-4c-.25 0-.46.18-.5.42l-.38 2.65c-.6.19-1.17.48-1.69.87l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.31.61.22l2.49-1c.52.39 1.09.68 1.69.87l.38 2.65c.05.24.25.42.5.42h4c.25 0 .45-.18.5-.42l.38-2.65c.6-.19 1.17-.48 1.69-.87l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"
      />
    </svg>
  )
}

function sortSessionsByCreatedDesc(a: SessionItem, b: SessionItem) {
  const ca = a.createdAt ?? a.updatedAt ?? 0
  const cb = b.createdAt ?? b.updatedAt ?? 0
  if (cb !== ca) return cb - ca
  return String(a.id).localeCompare(String(b.id))
}

function defaultSlotTitle(slot: string): string {
  if (slot === '_other') return '其他会话'
  return slot
}

function buildTreeGroups(sessions: SessionItem[], agents: AgentItem[]): TreeGroup[] {
  const bySlot = new Map<string, SessionItem[]>()
  for (const s of sessions) {
    const slot = agentSlotFromSessionKey(s.key)
    if (!bySlot.has(slot)) bySlot.set(slot, [])
    bySlot.get(slot)!.push(s)
  }
  for (const list of bySlot.values()) {
    list.sort(sortSessionsByCreatedDesc)
  }

  const slotOrder: string[] = []
  const seen = new Set<string>()
  for (const a of agents) {
    if (!seen.has(a.id)) {
      slotOrder.push(a.id)
      seen.add(a.id)
    }
  }
  const extras = [...bySlot.keys()].filter((k) => !seen.has(k)).sort((a, b) => a.localeCompare(b))
  slotOrder.push(...extras)

  const groups: TreeGroup[] = []
  for (const slot of slotOrder) {
    const list = bySlot.get(slot) ?? []
    const ai = agents.find((a) => a.id === slot)
    if (list.length === 0 && !ai) continue
    groups.push({
      slot,
      title: ai?.summary ?? defaultSlotTitle(slot),
      subtitle: ai?.subtitle ?? `${list.length} 个会话`,
      sessions: list,
    })
  }
  return groups
}

/**
 * 左侧会话树：Agent 为父节点（可收起），Session 为子节点。
 */
export function SessionAgentTreePanel({
  sessions,
  agents,
  agentListStatus,
  activeSessionId,
  activeAgentId,
  sessionSearch,
  onSessionSearchChange,
  onSelectSession,
  onSelectAgent,
  onRefreshTree,
  onRequestCreateSession,
  onRequestAddAgent,
  onBeginRenameSession,
  onRequestDeleteSession,
  onOpenAgentSettings,
}: SessionAgentTreePanelProps) {
  const groups = useMemo(() => buildTreeGroups(sessions, agents), [sessions, agents])

  /** 被用户收起的槽位；未出现在 Set 中视为展开 */
  const [collapsedSlots, setCollapsedSlots] = useState<Set<string>>(() => new Set())

  const isExpanded = useCallback(
    (slot: string) => !collapsedSlots.has(slot),
    [collapsedSlots],
  )

  const toggleSlot = useCallback((slot: string) => {
    setCollapsedSlots((prev) => {
      const next = new Set(prev)
      if (next.has(slot)) next.delete(slot)
      else next.add(slot)
      return next
    })
  }, [])

  /** 当前会话所在 Agent 自动展开 */
  useEffect(() => {
    const sess = sessions.find((s) => s.id === activeSessionId)
    if (!sess) return
    const slot = agentSlotFromSessionKey(sess.key)
    setCollapsedSlots((prev) => {
      if (!prev.has(slot)) return prev
      const next = new Set(prev)
      next.delete(slot)
      return next
    })
  }, [activeSessionId, sessions])

  /** 搜索命中时展开含结果的 Agent */
  useEffect(() => {
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return
    const slotsToOpen = new Set<string>()
    for (const s of sessions) {
      if (s.id.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q)) {
        slotsToOpen.add(agentSlotFromSessionKey(s.key))
      }
    }
    if (slotsToOpen.size === 0) return
    setCollapsedSlots((prev) => {
      const next = new Set(prev)
      for (const sl of slotsToOpen) next.delete(sl)
      return next
    })
  }, [sessionSearch, sessions])

  return (
    <div className="sidebar-panel-section">
      <h2 className="sr-only">会话与 Agent</h2>
      <div className="session-tree-toolbar">
        <input
          type="search"
          className="session-tree-search"
          placeholder="搜索会话…"
          value={sessionSearch}
          onChange={(e) => onSessionSearchChange(e.target.value)}
          aria-label="搜索会话"
          autoComplete="off"
        />
      </div>

      <div className="session-list compact-session-list sidebar-panel-list-body session-tree-scroll">
        {agentListStatus === 'loading' && groups.length === 0 && (
          <article className="session-card muted">
            <p className="session-subtitle">正在加载 Agent 列表…</p>
          </article>
        )}
        {agentListStatus === 'error' && (
          <article className="session-card muted">
            <p className="session-subtitle">Agent 列表加载失败</p>
          </article>
        )}
        {groups.map((g) => {
          const expanded = isExpanded(g.slot)
          const agentActive = activeAgentId === g.slot
          const showAgentSettings = g.slot !== '_other' && typeof onOpenAgentSettings === 'function'
          return (
            <div key={g.slot} className="session-tree-group">
              <div className={`session-tree-agent-row ${agentActive ? 'session-tree-agent-row--active' : ''}`}>
                <button
                  type="button"
                  className="session-tree-chevron"
                  aria-expanded={expanded}
                  aria-controls={`session-tree-branch-${g.slot}`}
                  id={`session-tree-trigger-${g.slot}`}
                  aria-label={expanded ? '收起' : '展开'}
                  title={expanded ? '收起' : '展开'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleSlot(g.slot)
                  }}
                >
                  {expanded ? '▾' : '▸'}
                </button>
                <button
                  type="button"
                  className="session-tree-agent-main"
                  onClick={() => {
                    onSelectAgent(g.slot)
                    setCollapsedSlots((prev) => {
                      if (!prev.has(g.slot)) return prev
                      const next = new Set(prev)
                      next.delete(g.slot)
                      return next
                    })
                  }}
                >
                  <span className="session-tree-agent-title">{g.title}</span>
                  <span className="session-tree-agent-meta">
                    <span className="session-tree-agent-count">{g.sessions.length}</span>
                  </span>
                </button>
                {showAgentSettings && (
                  <button
                    type="button"
                    className="session-tree-agent-settings"
                    title="Agent 设置"
                    aria-label={`${g.title} 的设置`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onOpenAgentSettings!(g.slot)
                    }}
                  >
                    <SessionTreeAgentGearIcon />
                  </button>
                )}
              </div>
              {expanded && g.sessions.length > 0 && (
                <ul
                  className="session-tree-children"
                  role="group"
                  id={`session-tree-branch-${g.slot}`}
                  aria-labelledby={`session-tree-trigger-${g.slot}`}
                >
                  {g.sessions.map((session) => (
                    <li key={session.id} className="session-tree-child-item">
                      <article
                        className={`session-card session-tree-session-card ${session.id === activeSessionId ? 'active' : ''}`}
                        onClick={() => onSelectSession(session.id)}
                      >
                        <div className="session-card-body">
                          <h3
                            className="session-title"
                            onMouseDown={(event) => {
                              if (event.button !== 0) return
                              if (event.detail !== 2) return
                              event.preventDefault()
                              event.stopPropagation()
                              onBeginRenameSession(session.id, session.summary)
                            }}
                            onDoubleClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                            title="双击重命名"
                          >
                            {session.summary}
                          </h3>
                          <p className="session-subtitle">
                            {`${session.subtitle || 'session'} · ${formatSessionRelativeTime(session.updatedAt)}`}
                          </p>
                        </div>
                        <div className="session-card-actions">
                          <span className={`mini-state ${session.state}`}>{session.state}</span>
                          <button
                            type="button"
                            className="session-card-delete-btn"
                            title="删除会话"
                            aria-label={`删除会话 ${session.summary}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              onRequestDeleteSession(session.id, session.summary)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </article>
                    </li>
                  ))}
                </ul>
              )}
              {expanded && g.sessions.length === 0 && (
                <p className="session-tree-empty-branch">该 Agent 下暂无会话</p>
              )}
            </div>
          )
        })}
        {groups.length === 0 && agentListStatus !== 'loading' && (
          <article className="session-card muted">
            <p className="session-subtitle">暂无会话，请新建或检查网关</p>
          </article>
        )}
      </div>

      <div className="sidebar-list-footer" role="toolbar" aria-label="侧栏操作">
        <button type="button" className="icon-button sidebar-icon-btn" title="刷新列表" onClick={() => void onRefreshTree()}>
          ↻
        </button>
        <button type="button" className="icon-button sidebar-icon-btn" title="新建会话" onClick={() => void onRequestCreateSession()}>
          ＋
        </button>
        <button type="button" className="icon-button sidebar-icon-btn" title="新建 Agent" onClick={() => onRequestAddAgent()}>
          ⊕
        </button>
      </div>
    </div>
  )
}
