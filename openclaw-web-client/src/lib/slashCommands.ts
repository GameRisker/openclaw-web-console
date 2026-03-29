/**
 * 前端「/」命令树。与 TUI 完全一致须由网关下发同源注册表（GET/WS）；此处为可扩展结构与占位数据。
 */
export type SlashCommand = {
  trigger: string
  description: string
  /** 若有子项，Enter 进入二级；叶子写入 insertText ?? trigger */
  children?: SlashCommand[]
  /** 叶子最终写入输入框的完整文本（子命令常用，避免只拼半段） */
  insertText?: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { trigger: '/help', description: '帮助与可用命令' },
  { trigger: '/clear', description: '清空会话上下文' },
  { trigger: '/compact', description: '压缩上下文' },
  {
    trigger: '/model',
    description: '切换或查看模型',
    children: [
      { trigger: 'list', description: '列出当前可用模型', insertText: '/model list' },
      { trigger: 'gpt-4o', description: '使用 gpt-4o', insertText: '/model gpt-4o' },
      { trigger: 'gpt-4o-mini', description: '使用 gpt-4o-mini', insertText: '/model gpt-4o-mini' },
      { trigger: 'claude-sonnet', description: '使用 Claude Sonnet', insertText: '/model claude-sonnet' },
    ],
  },
  {
    trigger: '/sessions',
    description: '会话相关',
    children: [
      { trigger: 'list', description: '列出会话', insertText: '/sessions list' },
      { trigger: 'new', description: '新建会话', insertText: '/sessions new ' },
    ],
  },
  { trigger: '/verbose', description: '详细输出 on/off', children: [
    { trigger: 'on', description: '打开 verbose', insertText: '/verbose on' },
    { trigger: 'off', description: '关闭 verbose', insertText: '/verbose off' },
  ] },
  { trigger: '/think', description: '思考等级（占位）', children: [
    { trigger: 'low', description: 'think low', insertText: '/think low' },
    { trigger: 'high', description: 'think high', insertText: '/think high' },
  ] },
  { trigger: '/abort', description: '中止当前运行（若网关支持）' },
  { trigger: '/retry', description: '重试上一轮（若网关支持）' },
]

export type SlashToken = {
  start: number
  end: number
  /** 不含前导 `/`，已小写 */
  query: string
}

export function getSlashTokenAtCursor(text: string, cursor: number): SlashToken | null {
  if (cursor < 0 || cursor > text.length) return null
  let start = cursor
  while (start > 0) {
    const ch = text[start - 1]!
    if (ch === ' ' || ch === '\n' || ch === '\t') break
    start--
  }
  const word = text.slice(start, cursor)
  if (!word.startsWith('/')) return null
  const rest = word.slice(1)
  if (rest.includes('\n')) return null
  return { start, end: cursor, query: rest.toLowerCase() }
}

/** 仅匹配顶层命令（前缀） */
export function filterRootSlashCommands(queryLower: string): SlashCommand[] {
  if (!queryLower) return [...SLASH_COMMANDS]
  return SLASH_COMMANDS.filter((c) => c.trigger.slice(1).toLowerCase().startsWith(queryLower))
}

/** 扁平列出所有可发送叶子（用于统计或与后端对账）；有 children 的父节点不单独作为发送项 */
export function flattenLeafSlashInserts(roots: SlashCommand[] = SLASH_COMMANDS): string[] {
  const out: string[] = []
  function walk(nodes: SlashCommand[]) {
    for (const n of nodes) {
      if (n.children?.length) walk(n.children)
      else out.push(n.insertText ?? n.trigger)
    }
  }
  walk(roots)
  return out
}

/** 顶层 + 所有子项条数（用于「共 N 条」提示） */
export function countSlashMenuEntries(roots: SlashCommand[] = SLASH_COMMANDS): number {
  let n = 0
  function walk(nodes: SlashCommand[]) {
    for (const c of nodes) {
      n += 1
      if (c.children?.length) walk(c.children)
    }
  }
  walk(roots)
  return n
}
