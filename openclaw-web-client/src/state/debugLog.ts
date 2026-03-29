/**
 * 浏览器 Console 调试日志（便于复制发给协作者）。
 *
 * - 开发模式 (vite dev)：默认开启
 * - 生产构建：执行 `localStorage.setItem('openclawWebDebug','1')` 后刷新
 * - 开发模式临时关闭：`localStorage.setItem('openclawWebDebug','0')` 后刷新
 *
 * 排查「加载更早」：看 `loadOlder click` / `loadOlder` 前缀；若出现 `blocked` 或 `skip` 即未发请求。
 */
export function isOpenclawWebDebug(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const v = window.localStorage.getItem('openclawWebDebug')
    if (v === '0') return false
    if (v === '1') return true
  } catch {
    /* ignore */
  }
  return Boolean(import.meta.env.DEV)
}

export function openclawWebLog(tag: string, payload?: unknown) {
  if (!isOpenclawWebDebug()) return
  if (payload === undefined) {
    console.log(`[openclaw-web] ${tag}`)
  } else {
    console.log(`[openclaw-web] ${tag}`, payload)
  }
}
