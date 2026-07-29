// Runs the WHOLE app headlessly: the real 8th Wall engine, real SLAM, real MediaPipe, against a
// video file that Chromium presents as a webcam.
//
// Unlike test/smoke.mjs (which stubs the engine), nothing is faked here except the camera, so
// this catches integration problems the smoke test cannot see.
//
//   npm i -D playwright @8thwall/engine-binary @8thwall/xrextras @8thwall/landing-page
//   npx playwright install chromium
//   npm run vendor:engine          # engine must be same-origin
//   node test/make-fake-camera.mjs /tmp/fake.y4m
//   npm run serve                  # another shell
//   npm run live -- http://127.0.0.1:5173/ /tmp/fake.y4m live.png
//
// Point it at a clip of a real hand pinching to exercise the drawing path for real.
import {chromium, devices} from 'playwright'

const [, , URL_UNDER_TEST, VIDEO, SHOT = 'live.png'] = process.argv

if (!URL_UNDER_TEST || !VIDEO) {
  console.error('usage: node test/live.mjs <url> <video.y4m> [screenshot.png]')
  process.exit(1)
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: [
    '--use-fake-ui-for-media-stream',      // auto-accept the camera prompt
    '--use-fake-device-for-media-stream',  // synthesise a capture device
    `--use-file-for-fake-video-capture=${VIDEO}`,
    '--enable-unsafe-swiftshader',         // software WebGL under headless
    '--autoplay-policy=no-user-gesture-required',
  ],
})

// Emulate the real target. Without a mobile user agent, 8th Wall's LandingPage module decides
// this is a desktop browser and swaps the app for a "scan this QR code" screen, so nothing runs.
const context = await browser.newContext({...devices['iPhone 13'], permissions: ['camera']})
const page = await context.newPage()

const consoleLines = []
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message.slice(0, 300)}`))
page.on('requestfailed', (r) =>
  consoleLines.push(`[reqfail] ${r.url().slice(0, 120)} :: ${r.failure()?.errorText}`)
)

await page.goto(URL_UNDER_TEST, {waitUntil: 'load'})

const running = await page
  .waitForFunction(() => Boolean(window.__ardraw), {timeout: 60000})
  .then(() => true)
  .catch(() => false)

if (!running) {
  console.log('FAIL app never started')
  console.log(consoleLines.join('\n'))
  await browser.close()
  process.exit(1)
}
console.log('PASS 8th Wall engine started and the pipeline is running')

// Let the clip play through so SLAM has motion to track and MediaPipe sees several frames.
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1000)
  const state = await page.evaluate(() => window.__ardraw.state)
  console.log(`t+${i + 1}s ${JSON.stringify(state)}`)
}

const final = await page.evaluate(() => window.__ardraw.state)
await page.screenshot({path: SHOT})

const checks = [
  ['camera frames reach the pipeline', final.frames > 0, `${final.frames} frames`],
  [
    'hand detected',
    final.framesWithHand > 0,
    final.framesWithHand > 0
      ? `${final.framesWithHand}/${final.frames} frames`
      : 'none -- expected with a synthetic clip; use real hand footage to exercise drawing',
  ],
  ['no page errors', !consoleLines.some((l) => l.startsWith('[pageerror]')), ''],
]

console.log('')
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'WARN'} ${name}${detail ? ' :: ' + detail : ''}`)
}
console.log(`\nscreenshot: ${SHOT}`)

if (consoleLines.some((l) => l.startsWith('[pageerror]'))) {
  console.log('\n--- browser console ---')
  console.log(consoleLines.join('\n'))
}

await browser.close()
