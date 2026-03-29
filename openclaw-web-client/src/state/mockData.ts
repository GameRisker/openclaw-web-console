import type { SessionItem, SideCard } from '../types/app'

const mockT0 = 1_700_000_000_000

export const mockSessions: SessionItem[] = [
  { id: 'main', summary: '当前主会话', state: 'active', createdAt: mockT0, updatedAt: mockT0 + 60_000 },
  { id: 'project-ui', summary: 'Web UI 方案讨论', state: 'idle', createdAt: mockT0 + 3_600_000, updatedAt: mockT0 + 3_600_000 },
  { id: 'config-review', summary: '配置管理设计', state: 'idle', createdAt: mockT0 + 7_200_000, updatedAt: mockT0 + 7_200_000 },
]

export const mockSideCards: SideCard[] = [
  {
    title: 'Session Status',
    items: ['Session: main', 'Messages: 148', 'State: busy'],
  },
  {
    title: 'Runtime Health',
    items: ['Host: Dan-MacBook', 'Gateway: online', 'Tailnet: connected'],
  },
  {
    title: 'Model Selector',
    items: ['当前 JSON 中可用模型', 'openai-codex/gpt-5.4', 'glm-4.7'],
  },
  {
    title: 'Settings / Config',
    items: ['Drawer 入口预留', '未来接 control adapter'],
  },
]
