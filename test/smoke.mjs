// Headless smoke + unit test.
//
// The app cannot be fully tested without a phone camera and a real hand, but a surprising amount
// is checkable in a desktop browser: stubbing the 8th Wall engine lets the real pipeline module
// run, and the geometry helpers and tube builder are pure enough to assert on directly.
//
// Usage:
//   npm i -D playwright && npx playwright install chromium   (once)
//   npm run serve                                            (in another shell)
//   node test/smoke.mjs http://127.0.0.1:5173/
//
// CHROMIUM_PATH can override the browser binary.
import {chromium} from 'playwright'

const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:5173/'

// Stand-in for the 8th Wall engine binary, which needs a camera and a CDN we do not want in a
// unit test. Only the surface app.js actually touches is implemented.
const stubEngine = () => {
  window.__errors = []
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => window.__errors.push('reject: ' + e.reason))

  let xrScene = null
  window.XR8 = {
    addCameraPipelineModules: (mods) => {
      window.__mods = mods
    },
    run: () => {},
    GlTextureRenderer: {pipelineModule: () => ({name: 'gl'})},
    Threejs: {
      pipelineModule: () => ({name: 'threejs'}),
      xrScene: () => {
        if (!xrScene) {
          const scene = new window.THREE.Scene()
          const camera = new window.THREE.PerspectiveCamera(60, 1, 0.01, 100)
          scene.add(camera)
          xrScene = {scene, camera, renderer: null}
        }
        return xrScene
      },
    },
    XrController: {
      pipelineModule: () => ({name: 'xrcontroller'}),
      updateCameraProjectionMatrix: () => {},
    },
    CameraPixelArray: {pipelineModule: () => ({name: 'camerapixelarray'})},
  }
  window.XRExtras = {
    FullWindowCanvas: {pipelineModule: () => ({name: 'fwc'})},
    Loading: {pipelineModule: () => ({name: 'loading'})},
    RuntimeError: {pipelineModule: () => ({name: 'err'})},
  }
  window.LandingPage = {pipelineModule: () => ({name: 'lp'})}
}

const results = []
const record = (line) => {
  results.push(line)
  console.log(line)
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}
)
const page = await browser.newPage({viewport: {width: 390, height: 844}})

const consoleLines = []
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`))

// Block the real engine so the stub is authoritative. Without this the test result depends on
// whether the engine is reachable (CDN) or vendored locally, and on a script load race.
await page.route(/(xr\.js|xr-slam\.js|xrextras\.js|landing-page\.js)(\?|$)/, (route) => route.abort())

await page.addInitScript(stubEngine)
await page.goto(URL_UNDER_TEST, {waitUntil: 'load'})

// --- pipeline wiring --------------------------------------------------------------------------
const registered = await page.evaluate(() => (window.__mods || []).map((m) => m.name))
record(`${registered.includes('ardraw') ? 'PASS' : 'FAIL'} pipeline registers ardraw :: ${registered.join(',')}`)

const startResult = await page.evaluate(() => {
  const mod = (window.__mods || []).find((m) => m.name === 'ardraw')
  if (!mod) return {ok: false, why: 'ardraw not registered'}
  try {
    mod.onStart({canvas: document.getElementById('camerafeed')})
    return {ok: true}
  } catch (e) {
    return {ok: false, why: String((e && e.stack) || e)}
  }
})
record(`${startResult.ok ? 'PASS' : 'FAIL'} onStart :: ${startResult.why || 'scene + controls initialised'}`)

// --- MediaPipe actually loads -------------------------------------------------------------------
const trackerStatus = await page
  .waitForFunction(
    () => {
      const t = document.getElementById('status').textContent
      return t.includes('Montrez') || t.includes('indisponible') ? t : false
    },
    {timeout: 120000}
  )
  .then((h) => h.jsonValue())
  .catch((e) => 'TIMEOUT: ' + e.message)
const trackerOk = trackerStatus.includes('Montrez')
record(
  `${trackerOk ? 'PASS' : 'FAIL'} hand tracker loads :: ${trackerStatus}` +
    (trackerOk ? '' : ` / ${await page.evaluate(() => document.getElementById('hint').textContent)}`)
)

// --- onUpdate survives real frames and every control ---------------------------------------------
const updateResult = await page.evaluate(() => {
  const mod = window.__mods.find((m) => m.name === 'ardraw')
  const cols = 320
  const rows = 240
  const pixels = new Uint8Array(cols * rows * 4).fill(128)
  try {
    // No hand in a flat grey frame, so this drives the "hand lost" branch through real inference.
    for (let i = 0; i < 5; i++) {
      mod.onUpdate({processGpuResult: {camerapixelarray: {pixels, cols, rows}}})
    }
    for (const id of ['btn-debug', 'btn-color', 'btn-depth', 'btn-undo', 'btn-clear']) {
      document.getElementById(id).click()
    }
    // Once more with the debug overlay enabled, to cover the overlay drawing path.
    mod.onUpdate({processGpuResult: {camerapixelarray: {pixels, cols, rows}}})
    return {ok: true}
  } catch (e) {
    return {ok: false, why: String((e && e.stack) || e)}
  }
})
record(`${updateResult.ok ? 'PASS' : 'FAIL'} onUpdate + controls :: ${updateResult.why || '5 frames, 6 controls'}`)

// --- pure logic ----------------------------------------------------------------------------------
const unit = await page.evaluate(async () => {
  const [{imageToScreen, pinchRatio, knuckleSpan}, {createDrawing}] = await Promise.all([
    import('/src/hand-tracking.js'),
    import('/src/tube-drawing.js'),
  ])
  const THREE = window.THREE
  const out = []
  const check = (name, cond, detail = '') =>
    out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)

  // Image -> screen mapping. These are the real numbers the engine reported on an iPhone 13
  // viewport: a 640x480 camera image scaled to cover a 376x640 canvas, so it overflows
  // horizontally and is cropped.
  const VP = {offsetX: -238.6666, offsetY: 0, width: 853.3333, height: 640}
  const CW = 376
  const CH = 640
  const map = (x, y) => imageToScreen(x, y, VP, CW, CH)

  const centre = map(0.5, 0.5)
  check(
    'the image centre lands at the screen centre',
    Math.abs(centre.u - 0.5) < 1e-3 && Math.abs(centre.v - 0.5) < 1e-3,
    `${centre.u.toFixed(4)},${centre.v.toFixed(4)}`
  )

  // These two encode the behaviour the whole feature depends on: moving the hand right must move
  // the tube right, and moving it up must move it up. An inverted axis here is exactly the bug
  // that shows up as a tube going the wrong way.
  check('moving right in the image moves right on screen', map(0.6, 0.5).u > map(0.4, 0.5).u)
  check('moving up in the image moves up on screen', map(0.5, 0.4).v < map(0.5, 0.6).v)

  // The image is wider than the canvas, so its edges fall outside the visible area. That is the
  // crop, and it must not be clamped away -- a hand near the edge is genuinely off-screen.
  check('the cropped left edge maps outside the screen', map(0, 0.5).u < 0, map(0, 0.5).u.toFixed(3))
  check('the cropped right edge maps outside the screen', map(1, 0.5).u > 1, map(1, 0.5).u.toFixed(3))

  // Vertically the image exactly fills the canvas in this configuration.
  check('the image top maps to the screen top', Math.abs(map(0.5, 0).v) < 1e-9)
  check('the image bottom maps to the screen bottom', Math.abs(map(0.5, 1).v - 1) < 1e-9)

  // No viewport yet on the first frames; must not throw or produce NaN.
  const fallback = imageToScreen(0.3, 0.6, null, 0, 0)
  check(
    'falls back to identity before the viewport is known',
    Math.abs(fallback.u - 0.3) < 1e-9 && Math.abs(fallback.v - 0.6) < 1e-9
  )

  // Synthetic hand: `scale` shrinks it as if it moved away, `gap` opens the thumb-index pinch.
  const hand = (scale, gap) => {
    const lm = Array.from({length: 21}, () => ({x: 0.5, y: 0.5, z: 0}))
    lm[0] = {x: 0.5, y: 0.5 + 0.2 * scale, z: 0}    // wrist
    lm[9] = {x: 0.5, y: 0.5, z: 0}                  // middle mcp
    lm[5] = {x: 0.5 - 0.06 * scale, y: 0.5, z: 0}   // index mcp
    lm[17] = {x: 0.5 + 0.06 * scale, y: 0.5, z: 0}  // pinky mcp
    lm[8] = {x: 0.5, y: 0.4, z: 0}                  // index tip
    lm[4] = {x: 0.5 + gap * scale, y: 0.4, z: 0}    // thumb tip
    return lm
  }

  // The whole point of normalising by hand size: the threshold must not depend on distance.
  const near = pinchRatio(hand(1.0, 0.02), 320, 320)
  const far = pinchRatio(hand(0.5, 0.02), 320, 320)
  check('pinchRatio is scale invariant', Math.abs(near - far) < 0.02, `${near.toFixed(3)} vs ${far.toFixed(3)}`)
  const closed = pinchRatio(hand(1, 0.01), 320, 320)
  const open = pinchRatio(hand(1, 0.5), 320, 320)
  check('a closed pinch is below the close threshold', closed < 0.38, closed.toFixed(3))
  check('an open hand is above the open threshold', open > 0.55, open.toFixed(3))

  check(
    'knuckleSpan shrinks as the hand moves away',
    knuckleSpan(hand(1.0, 0.02), 320, 320) > knuckleSpan(hand(0.5, 0.02), 320, 320)
  )

  // Tube builder.
  const scene = new THREE.Scene()
  const drawing = createDrawing(scene)
  check('starts idle', !drawing.isDrawing && drawing.strokeCount === 0)

  drawing.begin(new THREE.Vector3(0, 0, 0))
  check('begin() enters drawing state', drawing.isDrawing)
  check('movement below minSegmentLength is rejected', drawing.extend(new THREE.Vector3(0.001, 0, 0)) === false)

  for (let i = 1; i <= 20; i++) drawing.extend(new THREE.Vector3(i * 0.02, 0, 0))
  const meshes = []
  scene.traverse((o) => o.isMesh && meshes.push(o))
  check('a TubeGeometry is produced', meshes.some((m) => m.geometry.type === 'TubeGeometry'))

  drawing.end()
  check('end() finalises exactly one stroke', !drawing.isDrawing && drawing.strokeCount === 1, `count=${drawing.strokeCount}`)

  // A pinch with no movement should not leave a blob floating in the scene.
  drawing.begin(new THREE.Vector3(5, 5, 5))
  drawing.end()
  check('a stroke that never moved is discarded', drawing.strokeCount === 1, `count=${drawing.strokeCount}`)

  drawing.undo()
  check('undo() removes the last stroke', drawing.strokeCount === 0)
  drawing.clear()
  check('clear() is safe when empty', drawing.strokeCount === 0)

  return out
})
unit.forEach(record)

const pageErrors = await page.evaluate(() => window.__errors)
record(`${pageErrors.length === 0 ? 'PASS' : 'FAIL'} no uncaught page errors :: ${JSON.stringify(pageErrors)}`)

await browser.close()

const failed = results.filter((r) => r.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\n--- browser console ---')
  console.log(consoleLines.join('\n'))
  process.exit(1)
}
