import type { SessionItem } from '../../types/app'
import { formatSessionRelativeTime } from './formatRelativeTime'

export type SessionListPanelProps = {
  sessions: SessionItem[]
  activeSessionId: string
  onSelectSession: (sessionId: string) => void
  onCollapseSidebar: () => void
  onRefreshSessions: () => void
  /** 由上层决定如何弹窗/校验并创建 */
  onRequestCreateSession: () => void | Promise<void>
  /** 双击标题时打开重命名（由上层弹出 dialog，勿用 prompt） */
  onBeginRenameSession: (sessionId: string, currentTitle: string) => void
  /** 删除会话（上层弹出确认后再调 API） */
  onRequestDeleteSession: (sessionId: string, summary: string) => void
}

/**
 * 左侧会话列表：样式仍用全局 App.css（.sidebar-panel / .session-card 等），
 * 逻辑集中在此文件，后续可单独加 SessionListPanel.css 或子组件。
 */
export function SessionListPanel({
  sessions,
  activeSessionId,
  onSelectSession,
  onCollapseSidebar,
  onRefreshSessions,
  onRequestCreateSession,
  onBeginRenameSession,
  onRequestDeleteSession,
}: SessionListPanelProps) {
  return (
    <aside className="panel sidebar-panel">
      <div className="panel-header compact-sidebar-header">
        <div className="sidebar-panel-title">
          <h2>Sessions</h2>
        </div>
        <div className="panel-header-actions sidebar-panel-toolbar">
          <button type="button" className="icon-button sidebar-icon-btn" onClick={onCollapseSidebar} title="收起列表">
            ◀
          </button>
          <button type="button" className="icon-button sidebar-icon-btn" onClick={onRefreshSessions} title="刷新历史">
            ↻
          </button>
          <button
            type="button"
            className="icon-button sidebar-icon-btn"
            title="新建会话"
            onClick={() => void onRequestCreateSession()}
          >
            ＋
          </button>
        </div>
      </div>

      <div className="session-list compact-session-list">
        {sessions.map((session) => (
          <article
            key={session.id}
            className={`session-card ${session.id === activeSessionId ? 'active' : ''}`}
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
        ))}
      </div>
    </aside>
  )
}
