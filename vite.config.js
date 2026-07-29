import {execSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {defineConfig} from 'vite'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Netlify exposes the deployed commit as COMMIT_REF; fall back to git for local builds. Knowing
// exactly which build is on screen is the difference between "it is broken" and a bug report.
const commit = (() => {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim()
  } catch {
    return 'local'
  }
})()

const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  // Relative base so the build works from a GitHub Pages project subpath.
  base: './',

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },

  server: {
    // Needed so a tunnel (ngrok / cloudflared) can reach the dev server. The camera only works in
    // a secure context, so testing on a phone means HTTPS, which means a tunnel or a deploy.
    host: true,
    allowedHosts: ['.ngrok-free.dev', '.ngrok.io', '.trycloudflare.com'],
  },
})
