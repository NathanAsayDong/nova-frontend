import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    proxy: {
      '/ws': {
        target: 'http://127.0.0.1:8000',
        ws: true,
      },
      '/tools': {
        target: 'http://127.0.0.1:8000',
      },
      '/chat': {
        target: 'http://127.0.0.1:8000',
      },
      '/conversations': {
        target: 'http://127.0.0.1:8000',
      },
      '/projects': {
        target: 'http://127.0.0.1:8000',
      },
      '/mcp-servers': {
        target: 'http://127.0.0.1:8000',
      },
      '/nova': {
        target: 'http://127.0.0.1:8000',
      },
      '/meetings': {
        target: 'http://127.0.0.1:8000',
      },
    },
  },
})
