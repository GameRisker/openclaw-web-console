/**
 * 将 token 数格式化为约 KB（与 composer 状态行一致）。
 * 网关的 contextTokens/totalTokens 未必是「已用/上限」；仅当分母 ≥ 分子时百分比才有意义。
 */
export function formatTokenCount(value?: number): string | undefined {
  if (typeof value !== 'number') return undefined
  const kb = value / 1024
  if (kb >= 100) return `${Math.round(kb)}KB`
  if (kb >= 10) return `${kb.toFixed(1)}KB`
  return `${kb.toFixed(2)}KB`
}

export function formatContextUsageLine(contextTokens?: number, totalTokens?: number): string | undefined {
  const contextTokenLabel = formatTokenCount(contextTokens)
  const totalTokenLabel = formatTokenCount(totalTokens)
  const ctxN = contextTokens
  const totN = totalTokens
  if (contextTokenLabel && totalTokenLabel) {
    if (typeof ctxN === 'number' && typeof totN === 'number' && totN > 0 && ctxN <= totN) {
      return `tokens ${contextTokenLabel}/${totalTokenLabel} (${Math.round((ctxN / totN) * 100)}%)`
    }
    return `tokens ctx ${contextTokenLabel} · ${totalTokenLabel}`
  }
  if (totalTokenLabel) return `tokens ${totalTokenLabel}`
  return undefined
}
