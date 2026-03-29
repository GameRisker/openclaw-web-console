import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../openclaw-web-api/dist'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 必须 ws: true，否则 /api/realtime 无法升级到后端 WebSocket（浏览器会报 closed before established）
      '/api': {
        target: 'http://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
