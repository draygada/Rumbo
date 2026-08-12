import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn generates components that import from '@/lib/utils'. Existing code
    // uses relative paths and is unaffected.
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    globals: true,
  },
})
