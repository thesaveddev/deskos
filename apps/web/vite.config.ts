import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5180,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      // WebSocket signalling for the connect page / session console in dev.
      // Production routes /ws via nginx to the relay container.
      '/ws': { target: 'ws://localhost:4100', ws: true, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks improve long-term cacheability and keep the
        // initial shell small; route chunks are produced by React.lazy.
        manualChunks: {
          // Keep react, react-dom and react-router-dom in a single chunk:
          // react-router-dom re-exports react, so splitting react into its own
          // chunk produced an empty chunk and risked duplicate React copies.
          'vendor-core': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query', 'zustand'],
          'vendor-auth': ['@simplewebauthn/browser', 'qrcode'],
        },
      },
    },
  },
})
