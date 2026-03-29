/** 会话列表「更新时间」展示用，与 session-list 模块内聚 */
export function formatSessionRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'recently'
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
