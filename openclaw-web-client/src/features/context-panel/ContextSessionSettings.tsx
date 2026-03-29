import { useEffect, useMemo, useState } from 'react'
import { fetchModelsCatalog, type ModelCatalogEntry, type SessionPatchPayload } from '../../state/api'

type VerboseUi = 'on' | 'off'
type ThinkUi = 'low' | 'high' | 'off'

/** 网关未返回 verbose 时，与常见运行默认一致：视为开启 */
function coalesceVerbose(verbose: boolean | undefined): boolean {
  return typeof verbose === 'boolean' ? verbose : true
}

/** 网关未返回 think 时，与常见运行默认一致：视为 low */
function coalesceThink(think: string | undefined): ThinkUi {
  const s = String(think ?? '').trim().toLowerCase()
  if (s === 'low' || s === 'high' || s === 'off') return s
  return 'low'
}

type Props = {
  sessionId: string
  label: string
  model?: string
  modelProvider?: string
  verbose?: boolean
  think?: string
  onPatch: (patch: SessionPatchPayload) => Promise<void>
  onCompact: () => Promise<void>
}

export function ContextSessionSettings({
  sessionId,
  label,
  model,
  modelProvider,
  verbose,
  think,
  onPatch,
  onCompact,
}: Props) {
  const [title, setTitle] = useState(label)
  const [modelSelect, setModelSelect] = useState(() => (model ?? '').trim())
  const [modelManual, setModelManual] = useState(() => (model ?? '').trim())
  const [useManualModel, setUseManualModel] = useState(false)
  const [verboseUi, setVerboseUi] = useState<VerboseUi>(() => (coalesceVerbose(verbose) ? 'on' : 'off'))
  const [thinkUi, setThinkUi] = useState<ThinkUi>(() => coalesceThink(think))
  const [saving, setSaving] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okFlash, setOkFlash] = useState(false)
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogMeta, setCatalogMeta] = useState<string | null>(null)

  useEffect(() => {
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
  }, [])

  useEffect(() => {
    setTitle(label)
    const m = (model ?? '').trim()
    setModelSelect(m)
    setModelManual(m)
    setUseManualModel(false)
    setVerboseUi(coalesceVerbose(verbose) ? 'on' : 'off')
    setThinkUi(coalesceThink(think))
    setError(null)
  }, [sessionId, label, model, verbose, think])

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
        setError('会话名不能为空')
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
      await onPatch(patch)
      setOkFlash(true)
      window.setTimeout(() => setOkFlash(false), 2200)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleCompact() {
    setError(null)
    setCompacting(true)
    try {
      await onCompact()
      setOkFlash(true)
      window.setTimeout(() => setOkFlash(false), 2200)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'compact 失败')
    } finally {
      setCompacting(false)
    }
  }

  return (
    <section className="context-card context-card--session-settings">
      <h3>会话设置</h3>
      <p className="context-settings-hint">
        会话名与模型走 sessions.patch；Verbose / Think 由桥接发 /verbose、/thinking 斜杠（与 TUI 一致）。列表常不返回 verbose/think 时，下拉用默认「开」「low」，保存后会记住你刚改的值。
      </p>

      <div className="context-settings-form">
        <label className="context-settings-field">
          <span className="context-settings-field-label">1. 会话名</span>
          <input
            type="text"
            className="context-settings-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
            placeholder="会话显示名称"
          />
        </label>

        <div className="context-settings-field">
          <span className="context-settings-field-label">2. 模型</span>
          {modelProvider?.trim() ? (
            <p className="context-settings-muted">当前提供方（只读）：{modelProvider.trim()}</p>
          ) : null}
          {catalogLoading ? (
            <p className="context-settings-muted">正在加载可选模型…</p>
          ) : catalog.length > 0 ? (
            <>
              <select
                className="context-settings-input context-settings-select"
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
              />
            </>
          )}
        </div>

        <label className="context-settings-field">
          <span className="context-settings-field-label">3. Verbose</span>
          <select
            className="context-settings-input context-settings-select"
            value={verboseUi}
            onChange={(e) => setVerboseUi(e.target.value as VerboseUi)}
          >
            <option value="on">开</option>
            <option value="off">关</option>
          </select>
        </label>

        <label className="context-settings-field">
          <span className="context-settings-field-label">4. Think</span>
          <select
            className="context-settings-input context-settings-select"
            value={thinkUi}
            onChange={(e) => setThinkUi(e.target.value as ThinkUi)}
          >
            <option value="low">low</option>
            <option value="high">high</option>
            <option value="off">off</option>
          </select>
        </label>

        <div className="context-settings-field context-settings-field--compact">
          <span className="context-settings-field-label">5. Compact</span>
          <button
            type="button"
            className="primary-button context-settings-compact-btn"
            disabled={compacting}
            onClick={() => void handleCompact()}
          >
            {compacting ? '执行中…' : '执行'}
          </button>
        </div>

        {error && <p className="context-settings-error">{error}</p>}
        {okFlash && !error && <p className="context-settings-ok">已完成</p>}
        <div className="context-settings-actions">
          <button
            type="button"
            className="primary-button context-settings-submit"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
          >
            {saving ? '保存中…' : '保存 1–4 项'}
          </button>
        </div>
      </div>
    </section>
  )
}
