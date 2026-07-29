import {defineConfig} from 'vite'

export default defineConfig({
  // Relative base so the build works from a GitHub Pages project subpath.
  base: './',
  server: {
    // Needed so a tunnel (ngrok / cloudflared) can reach the dev server. The camera only works in
    // a secure context, so testing on a phone means HTTPS, which means a tunnel or a deploy.
    host: true,
    allowedHosts: ['.ngrok-free.dev', '.ngrok.io', '.trycloudflare.com'],
  },
})
