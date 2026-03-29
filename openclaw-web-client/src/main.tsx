import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'

if (import.meta.env.PROD) {
  console.info(
    '[openclaw-web] 需要复制调试日志时执行: localStorage.setItem("openclawWebDebug","1"); location.reload()',
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
