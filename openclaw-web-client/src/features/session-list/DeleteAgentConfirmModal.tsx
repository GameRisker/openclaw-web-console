import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export type DeleteAgentConfirmModalProps = {
  open: boolean
  agentSlot: string
  agentTitle: string
  onDismiss: () => void
  /** 执行删除；成功返回 true */
  performDelete: (slot: string) => Promise<boolean>
  onDeleted?: () => void
  onDeleteFailed?: () => void
}

/**
 * 删除 Agent 确认弹窗（从 Agent 设置内触发）。
 */
export function DeleteAgentConfirmModal({
  open,
  agentSlot,
  agentTitle,
  onDismiss,
  performDelete,
  onDeleted,
  onDeleteFailed,
}: DeleteAgentConfirmModalProps) {
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) setBusy(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onDismiss])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  async function handleConfirm() {
    if (!agentSlot || busy) return
    setBusy(true)
    try {
      const ok = await performDelete(agentSlot)
      if (ok) onDeleted?.()
      else onDeleteFailed?.()
      onDismiss()
    } finally {
      setBusy(false)
    }
  }

  if (!open || !agentSlot) return null

  const title = agentTitle.trim() || agentSlot

  return createPortal(
    <div
      className="rename-session-modal-root"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onDismiss()
      }}
    >
      <div
        className="rename-session-modal-panel delete-session-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-agent-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="delete-session-modal-body">
          <h2 id="delete-agent-modal-title" className="rename-session-modal-title">
            删除 Agent
          </h2>
          <p className="delete-session-modal-desc">
            确定从 OpenClaw 配置中删除 Agent「<strong>{title}</strong>」（槽位 <code className="inline-code">{agentSlot}</code>）吗？
          </p>
          <p className="delete-session-modal-hint">此操作不可撤销；若网关已加载配置，可能需要重启网关。</p>
          {busy && (
            <p className="delete-session-modal-status" aria-live="polite">
              正在删除…
            </p>
          )}
          <div className="rename-session-modal-actions delete-session-modal-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onDismiss()}>
              取消
            </button>
            <button type="button" className="danger-button" disabled={busy} onClick={() => void handleConfirm()}>
              {busy ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
