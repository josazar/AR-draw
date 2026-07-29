// Serves the 8th Wall engine from our own origin instead of the CDN.
//
// Needed for headless testing (the sandbox has no CDN access) and useful for offline work. Writes
// a .env.local pointing the three <script> tags at public/vendor/8thwall; delete that file to go
// back to the CDN.
//
//   npm run vendor:engine
//
// The engine packages are not project dependencies, since production loads them from the CDN, so
// install them first:
//   npm i -D @8thwall/engine-binary @8thwall/xrextras @8thwall/landing-page
import {cpSync, existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dest = resolve(root, 'public/vendor/8thwall')

const files = [
  ['node_modules/@8thwall/engine-binary/dist/xr.js', 'xr.js'],
  ['node_modules/@8thwall/engine-binary/dist/xr-slam.js', 'xr-slam.js'],
  ['node_modules/@8thwall/engine-binary/dist/xr-face.js', 'xr-face.js'],
  ['node_modules/@8thwall/xrextras/dist/xrextras.js', 'xrextras.js'],
  ['node_modules/@8thwall/landing-page/dist/landing-page.js', 'landing-page.js'],
]

const missing = files.filter(([from]) => !existsSync(resolve(root, from))).map(([from]) => from)
if (missing.length) {
  console.error(
    'Missing engine files. Install the packages first:\n' +
      '  npm i -D @8thwall/engine-binary @8thwall/xrextras @8thwall/landing-page\n\n' +
      `Not found:\n  ${missing.join('\n  ')}`
  )
  process.exit(1)
}

mkdirSync(dest, {recursive: true})
for (const [from, to] of files) cpSync(resolve(root, from), resolve(dest, to))

// The engine fetches its own models, fonts and icons from a resources/ folder next to xr.js.
cpSync(
  resolve(root, 'node_modules/@8thwall/engine-binary/dist/resources'),
  resolve(dest, 'resources'),
  {recursive: true}
)

writeFileSync(
  resolve(root, '.env.local'),
  '# Written by scripts/vendor-engine.mjs. Delete this file to go back to the CDN.\n' +
    'VITE_XR8_URL=/vendor/8thwall/xr.js\n' +
    'VITE_XREXTRAS_URL=/vendor/8thwall/xrextras.js\n' +
    'VITE_LANDING_PAGE_URL=/vendor/8thwall/landing-page.js\n'
)

console.log(`[vendor-engine] engine -> ${dest}`)
console.log('[vendor-engine] wrote .env.local (delete it to return to the CDN)')
