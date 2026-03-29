import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { fetchModelsCatalog, type CreateAgentPayload, type ModelCatalogEntry } from '../../state/api'

const SLOT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export type AddAgentDialogProps = {
  open: boolean
  onDismiss: () => void
  onSubmit: (payload: CreateAgentPayload) => Promise<void>
}

type VerboseUi = 'on' | 'off'
type ThinkUi = 'low' | 'high' | 'off'

/**
 * 新建 Agent：槽位 + 与会话设置对齐的模型 / verbose / think；描述落盘为 workspace 根目录 AGENTS.md，首条引导语独立发送。
 */
export function AddAgentDialog({ open, onDismiss, onSubmit }: AddAgentDialogProps) {
  const [slot, setSlot] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [bootstrapMessage, setBootstrapMessage] = useState('Start a new session.')
  const [modelSelect, setModelSelect] = useState('')
  const [modelManual, setModelManual] = useState('')
  const [useManualModel, setUseManualModel] = useState(false)
  const [modelProviderExtra, setModelProviderExtra] = useState('')
  const [verboseUi, setVerboseUi] = useState<VerboseUi>('on')
  const [thinkUi, setThinkUi] = useState<ThinkUi>('low')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogMeta, setCatalogMeta] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSlot('')
    setLabel('')
    setDescription('')
    setBootstrapMessage('Start a new session.')
    setModelSelect('')
    setModelManual('')
    setUseManualModel(false)
    setModelProviderExtra('')
    setVerboseUi('on')
    setThinkUi('low')
    setBusy(false)
    setError(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setCatalogLoading(true)
    void fetchModelsCatalog()
      .then((d) => {
        if (cancelled) return
        setCatalog(d.models ?? [])
        const parts = [d.source ? `来源：${d.source}` : null, d.error ? d.error : null].filter(Boolean)
        setCatalogMeta(parts.length ? parts.join(' · ') : null)
        const def = typeof d.defaultModel === 'string' ? d.defaultModel.trim() : ''
        if (def) {
          setModelSelect((prev) => prev || def)
          setModelManual((prev) => prev || def)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setCatalog([])
          setCatalogMeta(e instanceof Error ? e.message : '模型列表加载失败')
        }
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const effectiveModel = useMemo(() => {
    if (useManualModel) return modelManual.trim()
    return modelSelect.trim()
  }, [useManualModel, modelManual, modelSelect])

  const slotTrim = slot.trim()
  const slotOk = SLOT_PATTERN.test(slotTrim) && slotTrim !== '_other'

  const canSubmit = slotOk && !busy

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
    if (!canSubmit) return
    setError(null)
    setBusy(true)
    try {
      const payload: CreateAgentPayload = {
        slot: slotTrim,
        verbose: verboseUi === 'on',
        think: thinkUi,
      }
      const lt = label.trim()
      if (lt) payload.label = lt
      const desc = description.trim()
      if (desc) payload.description = desc
      const boot = bootstrapMessage.trim()
      if (boot) payload.bootstrapMessage = boot
      if (effectiveModel) payload.model = effectiveModel
      const mp = modelProviderExtra.trim()
      if (mp) payload.modelProvider = mp
      await onSubmit(payload)
      onDismiss()
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return createPortal(
    <div
      className="rename-session-modal-root"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onDismiss()
      }}
    >
      <div
        className="rename-session-modal-panel agent-config-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-agent-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <form className="agent-config-modal-form" onSubmit={(e) => void handleSubmit(e)}>
          <div className="agent-config-modal-scroll">
            <h2 id="add-agent-modal-title" className="rename-session-modal-title">
              新建 Agent
            </h2>
            <p className="agent-config-modal-hint">
              槽位会写入会话 key 的 <code className="inline-code">agent:&lt;槽位&gt;:tui-…</code> 段；保存后可在 Sessions
              里看到新会话，并与右侧「会话设置」一样调整模型与参数。
            </p>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">槽位 ID（必填）</span>
              <input
                className="rename-session-modal-input"
                value={slot}
                onChange={(e) => setSlot(e.target.value)}
                placeholder="例如 main、research-bot"
                autoComplete="off"
                disabled={busy}
              />
              {!slotTrim ? null : !slotOk ? (
                <span className="agent-config-modal-field-error">
                  1–64 字符，字母或数字开头，仅含 . _ -，且不能为 _other
                </span>
              ) : null}
            </label>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">显示名称（会话标题）</span>
              <input
                className="rename-session-modal-input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="留空则使用槽位 ID"
                autoComplete="off"
                disabled={busy}
              />
            </label>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">描述（可选）</span>
              <textarea
                className="rename-session-modal-input agent-config-modal-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="说明会写入 workspace-〈槽位〉/AGENTS.md（与 agents add 的 workspace 一致，默认在 ~/.openclaw 下）"
                rows={3}
                disabled={busy}
              />
            </label>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">首条引导消息</span>
              <textarea
                className="rename-session-modal-input agent-config-modal-textarea"
                value={bootstrapMessage}
                onChange={(e) => setBootstrapMessage(e.target.value)}
                placeholder="发给网关 agent 的首条 user 类引导"
                rows={2}
                disabled={busy}
              />
            </label>

            <div className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">模型</span>
              {catalogLoading ? (
                <p className="agent-config-modal-hint">正在加载可选模型…</p>
              ) : catalog.length > 0 ? (
                <>
                  <select
                    className="rename-session-modal-input context-settings-select"
                    value={useManualModel ? '__manual__' : modelSelect}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '__manual__') {
                        setUseManualModel(true)
                        setModelManual(modelSelect.trim() || modelManual.trim())
                        return
                      }
                      setUseManualModel(false)
                      setModelSelect(v)
                    }}
                    disabled={busy}
                  >
                    <option value="">（未指定）</option>
                    {catalog.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                    <option value="__manual__">自定义…</option>
                  </select>
                  {useManualModel ? (
                    <input
                      type="text"
                      className="rename-session-modal-input agent-config-modal-input-tight"
                      value={modelManual}
                      onChange={(e) => setModelManual(e.target.value)}
                      placeholder="如 openai/gpt-4o"
                      disabled={busy}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <p className="agent-config-modal-hint">
                    未拉到模型目录{catalogMeta ? `（${catalogMeta}）` : ''}，请手动填写。
                  </p>
                  <input
                    type="text"
                    className="rename-session-modal-input"
                    value={modelManual}
                    onChange={(e) => {
                      setModelManual(e.target.value)
                      setModelSelect(e.target.value)
                    }}
                    placeholder="model 或 provider/model"
                    disabled={busy}
                  />
                </>
              )}
            </div>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">Model provider（可选）</span>
              <input
                className="rename-session-modal-input"
                value={modelProviderExtra}
                onChange={(e) => setModelProviderExtra(e.target.value)}
                placeholder="若网关要求与 model 分开传，再填此项"
                autoComplete="off"
                disabled={busy}
              />
            </label>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">Verbose</span>
              <select
                className="rename-session-modal-input context-settings-select"
                value={verboseUi}
                onChange={(e) => setVerboseUi(e.target.value as VerboseUi)}
                disabled={busy}
              >
                <option value="on">开</option>
                <option value="off">关</option>
              </select>
            </label>

            <label className="rename-session-modal-label">
              <span className="rename-session-modal-field-label">Think</span>
              <select
                className="rename-session-modal-input context-settings-select"
                value={thinkUi}
                onChange={(e) => setThinkUi(e.target.value as ThinkUi)}
                disabled={busy}
              >
                <option value="low">low</option>
                <option value="high">high</option>
                <option value="off">off</option>
              </select>
            </label>

            {error ? <p className="context-settings-error">{error}</p> : null}
          </div>

          <div className="agent-config-modal-footer rename-session-modal-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onDismiss()}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={!canSubmit}>
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
