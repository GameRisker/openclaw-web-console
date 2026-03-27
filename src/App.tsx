import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import { AppShellPage } from './pages/AppShellPage'
import { LoginPage } from './pages/LoginPage'

function App() {
  const isAuthenticated = true

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/app"
        element={isAuthenticated ? <AppShellPage /> : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  )
}

export default App
