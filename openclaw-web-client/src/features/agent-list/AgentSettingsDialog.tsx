import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchModelsCatalog, type ModelCatalogEntry, type SessionPatchPayload } from '../../state/api'

type VerboseUi = 'on' | 'off'
type ThinkUi = 'low' | 'high' | 'off'

function coalesceVerbose(verbose: boolean | undefined): boolean {
  return typeof verbose === 'boolean' ? verbose : true
}

function coalesceThink(think: string | undefined): ThinkUi {
  const s = String(think ?? '').trim().toLowerCase()
  if (s === 'low' || s === 'high' || s === 'off') return s
  return 'low'
}

export type AgentSettingsDialogProps = {
  open: boolean
  slot: string
  label: string
  model?: string
  modelProvider?: string
  verbose?: boolean
  think?: string
  onDismiss: () => void
  onSave: (patch: SessionPatchPayload) => Promise<void>
  /** 打开删除确认（槽位非 _other 时展示删除按钮） */
  onRequestDeleteAgent?: (slot: string, displayTitle: string) => void
}

/**
 * Agent 级设置：名称与模型写入 openclaw agents.list（若有项），并对该槽位下所有会话做与「会话设置」相同的网关 patch。
 */
export function AgentSettingsDialog({
  open,
  slot,
  label,
  model,
  modelProvider,
  verbose,
  think,
  onDismiss,
  onSave,
  onRequestDeleteAgent,
}: AgentSettingsDialogProps) {
  const [title, setTitle] = useState(label)
  const [modelSelect, setModelSelect] = useState(() => (model ?? '').trim())
  const [modelManual, setModelManual] = useState(() => (model ?? '').trim())
  const [useManualModel, setUseManualModel] = useState(false)
  const [verboseUi, setVerboseUi] = useState<VerboseUi>(() => (coalesceVerbose(verbose) ? 'on' : 'off'))
  const [thinkUi, setThinkUi] = useState<ThinkUi>(() => coalesceThink(think))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okFlash, setOkFlash] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogMeta, setCatalogMeta] = useState<string | null>(null)

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

  useEffect(() => {
    if (!open) return
    setTitle(label)
    const m = (model ?? '').trim()
    setModelSelect(m)
    setModelManual(m)
    setUseManualModel(false)
    setVerboseUi(coalesceVerbose(verbose) ? 'on' : 'off')
    setThinkUi(coalesceThink(think))
    setError(null)
    setOkFlash(false)
  }, [open, slot, label, model, verbose, think])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) {
        e.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, saving, onDismiss])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  const verboseBaselineStr = coalesceVerbose(verbose) ? 'on' : 'off'
  const thinkBaselineVal = coalesceThink(think)
  const modelBaseline = (model ?? '').trim()

  const effectiveModelForSave = useMemo(() => {
    if (useManualModel) return modelManual.trim()
    return modelSelect.trim()
  }, [useManualModel, modelManual, modelSelect])

  const dirty = useMemo(() => {
    return (
      title.trim() !== label.trim() ||
      effectiveModelForSave !== modelBaseline ||
      verboseUi !== verboseBaselineStr ||
      thinkUi !== thinkBaselineVal
    )
  }, [
    title,
    label,
    effectiveModelForSave,
    modelBaseline,
    verboseUi,
    verboseBaselineStr,
    thinkUi,
    thinkBaselineVal,
  ])

  const catalogIds = useMemo(() => new Set(catalog.map((x) => x.id)), [catalog])
  const currentModelInCatalog = modelBaseline !== '' && catalogIds.has(modelBaseline)

  async function handleSave() {
    setError(null)
    if (!dirty) return

    const patch: SessionPatchPayload = {}
    if (title.trim() !== label.trim()) {
      if (!title.trim()) {
        setError('显示名称不能为空')
        return
      }
      patch.label = title.trim()
    }
    if (effectiveModelForSave !== modelBaseline) {
      if (effectiveModelForSave === '' && modelBaseline !== '') {
        setError('暂不支持清空模型')
        return
      }
      if (effectiveModelForSave !== '') patch.model = effectiveModelForSave
    }
    if (verboseUi !== verboseBaselineStr) {
      patch.verbose = verboseUi === 'on'
    }
    if (thinkUi !== thinkBaselineVal) {
      patch.think = thinkUi
    }

    if (Object.keys(patch).length === 0) return

    setSaving(true)
    try {
      await onSave(patch)
      setOkFlash(true)
      window.setTimeout(() => setOkFlash(false), 2200)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !slot) return null

  const showDeleteAgent = slot !== '_other' && typeof onRequestDeleteAgent === 'function'

  return createPortal(
    <div
      className="rename-session-modal-root"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onDismiss()
      }}
    >
      <div
        className="rename-session-modal-panel agent-config-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="agent-config-modal-scroll">
          <h2 id="agent-settings-modal-title" className="rename-session-modal-title">
            Agent 设置
          </h2>
          <p className="agent-config-modal-hint">
            槽位 <code className="inline-code">{slot}</code>：名称与模型会更新{' '}
            <code className="inline-code">agents.list</code>（若存在该项）；Verbose / Think 与模型还会应用到该 Agent
            下<strong>所有</strong>会话。修改配置后有时需重启网关。
          </p>

          <div className="context-settings-form agent-settings-modal-form">
            <label className="context-settings-field">
              <span className="context-settings-field-label">显示名称</span>
              <input
                type="text"
                className="context-settings-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoComplete="off"
                placeholder="Agent 显示名"
                disabled={saving}
              />
            </label>

            <div className="context-settings-field">
              <span className="context-settings-field-label">模型</span>
              {modelProvider?.trim() ? (
                <p className="context-settings-muted">列表中的提供方参考（只读）：{modelProvider.trim()}</p>
              ) : null}
              {catalogLoading ? (
                <p className="context-settings-muted">正在加载可选模型…</p>
              ) : catalog.length > 0 ? (
                <>
                  <select
                    className="context-settings-input context-settings-select"
                    value={useManualModel ? '__manual__' : modelSelect}
                    disabled={saving}
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
                  >
                    {modelBaseline === '' ? <option value="">（未指定）</option> : null}
                    {modelBaseline && !currentModelInCatalog ? (
                      <option value={modelBaseline}>{modelBaseline}（当前）</option>
                    ) : null}
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
                      className="context-settings-input context-settings-input--tight"
                      value={modelManual}
                      onChange={(e) => setModelManual(e.target.value)}
                      placeholder="自定义 model 字符串"
                      disabled={saving}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <p className="context-settings-muted">
                    未拉到模型目录{catalogMeta ? `（${catalogMeta}）` : ''}，请手动填写。
                  </p>
                  <input
                    type="text"
                    className="context-settings-input"
                    value={modelManual}
                    onChange={(e) => {
                      setModelManual(e.target.value)
                      setModelSelect(e.target.value)
                    }}
                    placeholder="model"
                    disabled={saving}
                  />
                </>
              )}
            </div>

            <label className="context-settings-field">
              <span className="context-settings-field-label">Verbose</span>
              <select
                className="context-settings-input context-settings-select"
                value={verboseUi}
                disabled={saving}
                onChange={(e) => setVerboseUi(e.target.value as VerboseUi)}
              >
                <option value="on">开</option>
                <option value="off">关</option>
              </select>
            </label>

            <label className="context-settings-field">
              <span className="context-settings-field-label">Think</span>
              <select
                className="context-settings-input context-settings-select"
                value={thinkUi}
                disabled={saving}
                onChange={(e) => setThinkUi(e.target.value as ThinkUi)}
              >
                <option value="low">low</option>
                <option value="high">high</option>
                <option value="off">off</option>
              </select>
            </label>

            {error && <p className="context-settings-error">{error}</p>}
            {okFlash && !error && <p className="context-settings-ok">已保存</p>}

            <div className="rename-session-modal-actions agent-settings-modal-actions agent-settings-modal-actions--footer">
              <div className="agent-settings-modal-actions-start">
                {showDeleteAgent ? (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={saving}
                    onClick={() => onRequestDeleteAgent!(slot, title.trim() || label.trim() || slot)}
                  >
                    删除 Agent
                  </button>
                ) : null}
              </div>
              <div className="agent-settings-modal-actions-end">
                <button type="button" className="secondary-button" disabled={saving} onClick={() => onDismiss()}>
                  关闭
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!dirty || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
