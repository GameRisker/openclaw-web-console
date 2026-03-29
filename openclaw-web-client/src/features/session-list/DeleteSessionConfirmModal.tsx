import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export type DeleteSessionConfirmModalProps = {
  open: boolean
  sessionId: string
  sessionSummary: string
  onDismiss: () => void
  /** 执行删除；成功返回 true */
  performDelete: (sessionId: string) => Promise<boolean>
  onDeleted?: () => void
  onDeleteFailed?: () => void
}

/**
 * 删除会话确认弹窗；删除中禁用操作并提示「正在删除…」。
 */
export function DeleteSessionConfirmModal({
  open,
  sessionId,
  sessionSummary,
  onDismiss,
  performDelete,
  onDeleted,
  onDeleteFailed,
}: DeleteSessionConfirmModalProps) {
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
    if (!sessionId || busy) return
    setBusy(true)
    try {
      const ok = await performDelete(sessionId)
      if (ok) onDeleted?.()
      else onDeleteFailed?.()
      onDismiss()
    } finally {
      setBusy(false)
    }
  }

  if (!open || !sessionId) return null

  const title = sessionSummary.trim() || sessionId

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
        aria-labelledby="delete-session-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="delete-session-modal-body">
          <h2 id="delete-session-modal-title" className="rename-session-modal-title">
            删除会话
          </h2>
          <p className="delete-session-modal-desc">
            确定删除「<strong>{title}</strong>」吗？
          </p>
          <p className="delete-session-modal-hint">此操作不可撤销。</p>
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
