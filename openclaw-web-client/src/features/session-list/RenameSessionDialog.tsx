import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'

export type RenameSessionDialogProps = {
  open: boolean
  sessionId: string | null
  initialLabel: string
  onDismiss: () => void
  onCommit: (sessionId: string, label: string) => Promise<void>
}

/**
 * 自定义居中弹窗（遮罩 + 卡片），避免原生 dialog 在各环境下的样式/层级差异。
 */
export function RenameSessionDialog({
  open,
  sessionId,
  initialLabel,
  onDismiss,
  onCommit,
}: RenameSessionDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setValue(initialLabel)
  }, [open, initialLabel, sessionId])

  useEffect(() => {
    if (!open || !sessionId) return
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(t)
  }, [open, sessionId])

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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!sessionId || busy) return
    const t = value.trim()
    if (!t) return
    setBusy(true)
    try {
      await onCommit(sessionId, t)
      onDismiss()
    } finally {
      setBusy(false)
    }
  }

  if (!open || !sessionId) return null

  return createPortal(
    <div
      className="rename-session-modal-root"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onDismiss()
      }}
    >
      <div
        className="rename-session-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-session-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <form className="rename-session-modal-form" onSubmit={handleSubmit}>
          <h2 id="rename-session-modal-title" className="rename-session-modal-title">
            重命名会话
          </h2>
          <label className="rename-session-modal-label">
            <span className="rename-session-modal-field-label">名称</span>
            <input
              ref={inputRef}
              className="rename-session-modal-input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
              disabled={busy}
            />
          </label>
          <div className="rename-session-modal-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onDismiss()}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy || !value.trim()}>
              {busy ? '保存中…' : '确定'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
