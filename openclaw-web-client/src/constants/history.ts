/**
 * 首屏 HTTP 默认 limit；若网关/WS 首包也带 limit，宜与本值对齐。
 */
export const HISTORY_PAGE_SIZE = 20

/** 「加载更早」每次请求的条数；expand 重试时按该步长累加 limit，直至 HISTORY_FETCH_MAX */
export const HISTORY_OLDER_STEP = 10

/** 与网关 parseHistoryLimit 上限一致（若服务端更小，以服务端为准） */
export const HISTORY_FETCH_MAX = 200
