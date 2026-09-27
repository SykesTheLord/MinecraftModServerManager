import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // changeOrigin must stay false: the manager rejects writes/WebSockets
      // whose Origin doesn't match the Host they were sent to, and Vite's
      // string shorthand would rewrite Host to localhost:8080.
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/ws': { target: 'ws://localhost:8080', ws: true, changeOrigin: false },
    },
  },
})
