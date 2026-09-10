import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

/**
 * Serve the face display at /face without pulling a router into the app:
 * it's a second entry (face.html), and this rewrite makes the pretty path
 * work in both dev and preview. (Firebase Hosting does the same in
 * firebase.json.)
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
const towerLanApiUrl = 'http://10.1.10.118:8000'

/**
 * Where the built app talks to.
 *
 * Every request the app makes is absolute against this, so it has to be
 * right per environment:
 *
 *   npm run dev          .env / .env.development, else the tower on the LAN
 *   npm run dev:local    always the backend on this machine
 *   npm run dev:tower    always the tower on the LAN
 *   npm run build        .env.production — the public tunnel URL, required
 *
 * A VITE_API_URL in the shell wins over all of that.
 */
function resolveApiUrl(mode: string): string {
  // Below, the resolved URL is written back into process.env for the dev
  // server. Vite re-runs this file in the same process when it hot-restarts,
  // so without the marker our own earlier answer would read as a shell
  // override and pin the first mode forever.
  const fromShell = process.env.VITE_API_URL?.trim()
  if (fromShell && fromShell !== process.env.NOVA_VITE_API_URL_SELF_SET) {
    return fromShell.replace(/\/+$/, '')
  }
  if (mode === 'localhost') {
    return localApiUrl
  }
  if (mode === 'tower') {
    return towerLanApiUrl
  }

  const fromFile = loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL?.trim()
  if (fromFile && !fromFile.includes('YOUR-DOMAIN')) {
    return fromFile.replace(/\/+$/, '')
  }
  if (mode === 'production') {
    throw new Error(
      'VITE_API_URL is not set for production. Put the public API URL ' +
        '(https://api.yourdomain.com, the Cloudflare tunnel) in .env.production.',
    )
  }
  return towerLanApiUrl
}

export default defineConfig(({ mode }) => {
  const apiUrl = resolveApiUrl(mode)

  // The app must see exactly what was resolved above, whatever the .env files
  // say. Two mechanisms because Vite has two: `define` is what a production
  // build inlines, while the dev server builds import.meta.env at runtime
  // from VITE_-prefixed process.env — so it has to be set there too.
  process.env.VITE_API_URL = apiUrl
  process.env.NOVA_VITE_API_URL_SELF_SET = apiUrl

  return {
    plugins: [react(), babel({ presets: [reactCompilerPreset()] }), facePath()],
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(apiUrl),
    },
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          face: fileURLToPath(new URL('./face.html', import.meta.url)),
        },
      },
    },
  }
})
