import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

/**
 * Serve the face display at /face without pulling a router into the app:
 * it's a second entry (face.html), and this rewrite makes the pretty path
 * work in both dev and preview.
 */
function facePath(): Plugin {
  const rewrite = (req: { url?: string }) => {
    if (req.url === '/face' || req.url === '/face/') {
      req.url = '/face.html'
    }
  }
  return {
    name: 'face-path-rewrite',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req)
        next()
      })
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req)
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), facePath()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        face: fileURLToPath(new URL('./face.html', import.meta.url)),
      },
    },
  },
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
