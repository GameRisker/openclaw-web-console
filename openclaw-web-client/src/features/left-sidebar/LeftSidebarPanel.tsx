import type { SessionAgentTreePanelProps } from '../session-list/SessionAgentTreePanel'
import { SessionAgentTreePanel } from '../session-list/SessionAgentTreePanel'

export type LeftSidebarPanelProps = {
  onCollapseSidebar: () => void
  tree: SessionAgentTreePanelProps
}

/**
 * 左侧栏：会话 + Agent 树形列表（可收起子会话），共用折叠条。
 */
export function LeftSidebarPanel({ onCollapseSidebar, tree }: LeftSidebarPanelProps) {
  return (
    <aside className="panel sidebar-panel">
      <button
        type="button"
        className="sidebar-collapse-edge-tab"
        onClick={onCollapseSidebar}
        aria-label="收起侧栏"
        title="收起侧栏"
      >
        <span className="sidebar-collapse-edge-tab-icon" aria-hidden>
          ◀
        </span>
      </button>
      <SessionAgentTreePanel {...tree} />
    </aside>
  )
}
