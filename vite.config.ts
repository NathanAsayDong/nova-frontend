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

const localApiUrl = 'http://127.0.0.1:8000'
const remoteApiUrl = 'http://10.1.10.118:8000'

function resolveApiUrl(mode: string): string {
  if (process.env.VITE_API_URL) {
    return process.env.VITE_API_URL
  }
  return mode === 'localhost' ? localApiUrl : remoteApiUrl
}

export default defineConfig(({ mode }) => {
  const apiUrl = resolveApiUrl(mode)
  process.env.VITE_API_URL = apiUrl

  return {
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
          target: apiUrl,
          ws: true,
        },
        '/tools': {
          target: apiUrl,
        },
        '/chat': {
          target: apiUrl,
        },
        '/conversations': {
          target: apiUrl,
        },
        '/projects': {
          target: apiUrl,
        },
        '/mcp-servers': {
          target: apiUrl,
        },
        '/nova': {
          target: apiUrl,
        },
        '/meetings': {
          target: apiUrl,
        },
        '/coding': {
          target: apiUrl,
        },
      },
    },
  }
})
