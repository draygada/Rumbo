import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { applyTheme } from './hooks/useTheme'

const storedTheme = (window.localStorage.getItem('rumbo:theme') as 'light' | 'dark' | 'system' | null) ?? 'system'
applyTheme(storedTheme)

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
