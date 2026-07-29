// Headless smoke + unit test.
//
// The app cannot be fully tested without a phone camera and real SLAM, but a surprising amount is
// checkable in a desktop browser: stubbing the 8th Wall engine lets the real pipeline module run,
// and the smoothing and tube builder are pure enough to assert on directly.
//
// Usage:
//   npm i -D playwright && npx playwright install chromium   (once)
//   npm run serve                                            (in another shell)
//   npm run smoke -- http://127.0.0.1:5173/
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
          const camera = new window.THREE.PerspectiveCamera(60, 390 / 844, 0.01, 100)
          camera.updateProjectionMatrix()
          scene.add(camera)
          xrScene = {scene, camera, renderer: null}
          // Exposed so a test can move the camera, standing in for the phone moving.
          window.__xrSceneRef = xrScene
        }
        return xrScene
      },
    },
    XrController: {
      pipelineModule: () => ({name: 'xrcontroller'}),
      updateCameraProjectionMatrix: () => {},
      configure: (opts) => {
        window.__xrControllerConfig = opts
      },
    },
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

// --- pipeline wiring ----------------------------------------------------------------------------
const registered = await page.evaluate(() => (window.__mods || []).map((m) => m.name))
record(`${registered.includes('ardraw') ? 'PASS' : 'FAIL'} pipeline registers ardraw :: ${registered.join(',')}`)

// Hand tracking is gone: MediaPipe read ordinary room geometry as a pinch, so filming a room
// started drawing by itself. Nothing should pull the camera pixels off the GPU any more either --
// that readback existed only to feed inference.
record(
  `${!registered.includes('camerapixelarray') ? 'PASS' : 'FAIL'} no camera pixel readback remains` +
    ` :: ${registered.join(',')}`
)

// Scale must be locked at init ('responsive'), not re-estimated as the device moves
// ('absolute'). A refined scale estimate resizes everything already drawn, which is what made
// tubes shrink after walking out of a room and back.
const xrConfig = await page.evaluate(() => window.__xrControllerConfig)
record(
  `${xrConfig?.scale === 'responsive' ? 'PASS' : 'FAIL'} SLAM scale is locked at init` +
    ` :: ${JSON.stringify(xrConfig)}`
)

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

// Nothing to download and no model to load, so the app is usable immediately.
const readyStatus = await page.evaluate(() => document.getElementById('status').textContent)
record(
  `${readyStatus.includes('Appui long') ? 'PASS' : 'FAIL'} ready with no asset download` +
    ` :: "${readyStatus}"`
)

// --- onUpdate and the controls --------------------------------------------------------------
const updateResult = await page.evaluate(() => {
  const mod = window.__mods.find((m) => m.name === 'ardraw')
  try {
    const ok = {reality: {trackingStatus: 'NORMAL', trackingReason: 'UNSPECIFIED'}}
    for (let i = 0; i < 5; i++) mod.onUpdate({processCpuResult: ok})
    for (const id of ['btn-debug', 'btn-color', 'btn-undo', 'btn-clear']) {
      document.getElementById(id).click()
    }
    mod.onUpdate({processCpuResult: ok})
    return {ok: true}
  } catch (e) {
    return {ok: false, why: String((e && e.stack) || e)}
  }
})
record(`${updateResult.ok ? 'PASS' : 'FAIL'} onUpdate + controls :: ${updateResult.why || '6 frames, 4 controls'}`)

// --- depth slider -------------------------------------------------------------------------------
{
  const initial = await page.evaluate(() => ({
    depth: window.__ardraw.state.drawDepth,
    label: document.getElementById('depth-value').textContent,
    dot: document.getElementById('reticle-dot').style.width,
  }))
  record(
    `${Math.abs(initial.depth - 0.3) < 1e-9 ? 'PASS' : 'FAIL'} the slider starts at 30 cm` +
      ` :: ${initial.depth}m "${initial.label}"`
  )

  const far = await page.evaluate(() => {
    const slider = document.getElementById('depth-slider')
    slider.value = '200'
    slider.dispatchEvent(new Event('input', {bubbles: true}))
    return {
      depth: window.__ardraw.state.drawDepth,
      label: document.getElementById('depth-value').textContent,
      dot: parseFloat(document.getElementById('reticle-dot').style.width),
    }
  })
  record(
    `${Math.abs(far.depth - 2) < 1e-9 ? 'PASS' : 'FAIL'} the slider sets the draw distance` +
      ` :: ${far.depth}m`
  )
  record(
    `${far.label.includes('m') && !far.label.includes('cm') ? 'PASS' : 'FAIL'}` +
      ` distances past a metre are labelled in metres :: "${far.label}"`
  )
  // The preview dot is the slider's visible consequence: further away means a thinner tube.
  record(
    `${far.dot < parseFloat(initial.dot) ? 'PASS' : 'FAIL'} the preview dot shrinks with distance` +
      ` :: ${initial.dot} -> ${far.dot}px`
  )

  // A stroke drawn far away must land far away.
  const reach = await page.evaluate(() => {
    const mod = window.__mods.find((m) => m.name === 'ardraw')
    const {camera} = window.__xrSceneRef
    camera.position.set(0, 0, 0)
    camera.quaternion.identity()
    camera.updateMatrixWorld()
    mod.onUpdate({processCpuResult: {reality: {trackingStatus: 'NORMAL'}}})
    return window.__ardraw.state.drawDepth
  })
  record(`${Math.abs(reach - 2) < 1e-9 ? 'PASS' : 'FAIL'} the distance survives a frame :: ${reach}`)

  await page.evaluate(() => {
    const slider = document.getElementById('depth-slider')
    slider.value = '30'
    slider.dispatchEvent(new Event('input', {bubbles: true}))
  })
}

// --- touch drawing: press and hold, then move the phone -----------------------------------------
{
  const before = await page.evaluate(() => window.__ardraw.state.strokes)

  await page.mouse.move(195, 422)
  await page.mouse.down()
  const armed = await page.evaluate(() => document.getElementById('reticle').className)
  await page.waitForTimeout(500)
  const drawingNow = await page.evaluate(() => window.__ardraw.state.touchDrawing)

  // Walk the camera forward, which is what actually lays down the tube in this mode.
  await page.evaluate(() => {
    const mod = window.__mods.find((m) => m.name === 'ardraw')
    const {camera} = window.__xrSceneRef
    for (let i = 1; i <= 20; i++) {
      camera.position.set(i * 0.05, 1.4, 0)
      camera.updateMatrixWorld()
      mod.onUpdate({processCpuResult: {reality: {trackingStatus: 'NORMAL'}}})
    }
  })

  await page.mouse.up()
  const after = await page.evaluate(() => window.__ardraw.state)

  record(`${armed === 'armed' ? 'PASS' : 'FAIL'} the reticle arms on press :: "${armed}"`)
  record(`${drawingNow ? 'PASS' : 'FAIL'} holding past the threshold starts a stroke`)
  record(
    `${after.strokes === before + 1 ? 'PASS' : 'FAIL'} releasing closes exactly one tube` +
      ` :: ${before} -> ${after.strokes}`
  )
  record(`${!after.touchDrawing ? 'PASS' : 'FAIL'} drawing stops on release`)

  // A quick tap must not leave a mark.
  const beforeTap = after.strokes
  await page.mouse.move(195, 422)
  await page.mouse.down()
  await page.waitForTimeout(80)
  await page.mouse.up()
  const afterTap = await page.evaluate(() => window.__ardraw.state.strokes)
  record(`${afterTap === beforeTap ? 'PASS' : 'FAIL'} a short tap draws nothing :: ${afterTap}`)

  // Pressing outside the centre zone must not arm either.
  await page.mouse.move(30, 120)
  await page.mouse.down()
  const outside = await page.evaluate(() => document.getElementById('reticle').className)
  await page.waitForTimeout(500)
  const outsideDrawing = await page.evaluate(() => window.__ardraw.state.touchDrawing)
  await page.mouse.up()
  record(
    `${outside === '' && !outsideDrawing ? 'PASS' : 'FAIL'} pressing outside the zone does nothing` +
      ` :: "${outside}" drawing=${outsideDrawing}`
  )

  // Dragging the slider must never start a stroke, even though it is a long press.
  const sliderBox = await page.evaluate(() => {
    const r = document.getElementById('depth-slider').getBoundingClientRect()
    return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}
  })
  await page.mouse.move(sliderBox.x, sliderBox.y)
  await page.mouse.down()
  await page.waitForTimeout(500)
  const sliderDrawing = await page.evaluate(() => window.__ardraw.state.touchDrawing)
  await page.mouse.up()
  record(`${!sliderDrawing ? 'PASS' : 'FAIL'} holding the slider does not draw`)
}

// --- tracking robustness ------------------------------------------------------------------------
{
  // Drawing while SLAM is degraded records points against a pose that is about to be corrected,
  // so the stroke must pause rather than lay them down.
  const paused = await page.evaluate(async () => {
    const mod = window.__mods.find((m) => m.name === 'ardraw')
    const {camera} = window.__xrSceneRef
    const good = {reality: {trackingStatus: 'NORMAL'}}
    const bad = {reality: {trackingStatus: 'LIMITED', trackingReason: 'RELOCALIZING'}}

    // An earlier test left debug mode on, which replaces the plain message with the metrics line.
    const debugButton = document.getElementById('btn-debug')
    if (debugButton.classList.contains('on')) debugButton.click()

    camera.position.set(0, 1.4, 0)
    camera.updateMatrixWorld()
    mod.onUpdate({processCpuResult: good})

    const before = window.__ardraw.state.pausedFrames
    // Pretend a stroke is open by pressing, then degrade tracking.
    for (let i = 1; i <= 6; i++) {
      camera.position.set(i * 0.05, 1.4, 0)
      camera.updateMatrixWorld()
      mod.onUpdate({processCpuResult: bad})
    }
    return {
      pausedDelta: window.__ardraw.state.pausedFrames - before,
      status: document.getElementById('status').textContent,
    }
  })
  record(
    `${paused.status.includes('Suivi perdu') ? 'PASS' : 'FAIL'} a relocalisation is explained in` +
      ` plain words :: "${paused.status}"`
  )

  // Smooth motion must not be mistaken for a relocalisation.
  const smoothRun = await page.evaluate(() => {
    const mod = window.__mods.find((m) => m.name === 'ardraw')
    const {camera} = window.__xrSceneRef
    const good = {reality: {trackingStatus: 'NORMAL'}}
    const before = window.__ardraw.state.jumpsCompensated
    for (let i = 0; i < 40; i++) {
      camera.position.set(i * 0.01, 1.4, 0)
      camera.updateMatrixWorld()
      mod.onUpdate({processCpuResult: good})
    }
    return window.__ardraw.state.jumpsCompensated - before
  })
  record(`${smoothRun === 0 ? 'PASS' : 'FAIL'} steady motion is not read as a jump :: ${smoothRun}`)

  // A single-frame teleport is a relocalisation, and the drawing must stay put relative to what
  // the camera sees rather than following the world frame.
  const jump = await page.evaluate(() => {
    const THREE = window.THREE
    const mod = window.__mods.find((m) => m.name === 'ardraw')
    const {camera} = window.__xrSceneRef
    const root = window.__ardraw.contentRoot
    const good = {reality: {trackingStatus: 'NORMAL'}}

    // An arbitrary point of the drawing, in content space.
    const local = new THREE.Vector3(0.2, 1.3, -0.5)

    const cameraRelative = () => {
      const world = local.clone().applyMatrix4(root.matrix)
      return world.applyMatrix4(camera.matrixWorldInverse)
    }

    const before = cameraRelative()
    const jumpsBefore = window.__ardraw.state.jumpsCompensated

    // Teleport: a metre and a big rotation in one frame, which no hand achieves.
    camera.position.set(1.4, 1.9, 0.8)
    camera.rotateY(0.7)
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    mod.onUpdate({processCpuResult: good})

    const after = cameraRelative()
    return {
      detected: window.__ardraw.state.jumpsCompensated - jumpsBefore,
      drift: before.distanceTo(after),
    }
  })
  record(`${jump.detected === 1 ? 'PASS' : 'FAIL'} a teleport is detected as a jump :: ${jump.detected}`)
  record(
    `${jump.drift < 1e-6 ? 'PASS' : 'FAIL'} the drawing keeps its place relative to the camera` +
      ` :: drift ${jump.drift.toExponential(2)} m`
  )
}

// --- pure logic -----------------------------------------------------------------------------
const unit = await page.evaluate(async () => {
  const [{createDrawing}, {createOneEuroFilter}, {smoothPolyline}] = await Promise.all([
    import('/src/tube-drawing.js'),
    import('/src/one-euro.js'),
    import('/src/smoothing.js'),
  ])
  const THREE = window.THREE
  const out = []
  const check = (name, cond, detail = '') =>
    out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)

  // --- One Euro filter --------------------------------------------------------------------------
  const settle = (f, x, n = 60) => {
    let value = 0
    for (let i = 0; i < n; i++) value = f.filter(x, i * 16.7)
    return value
  }
  check(
    'the filter converges to a constant input',
    Math.abs(settle(createOneEuroFilter({minCutoff: 1, beta: 0.8, derivativeCutoff: 1}), 0.7) - 0.7) < 1e-3
  )

  // The point of the filter: a still pose is smoothed hard, a moving one is not.
  const jitter = createOneEuroFilter({minCutoff: 1, beta: 0.8, derivativeCutoff: 1})
  let inputSwing = 0
  let outputSwing = 0
  let prevIn = null
  let prevOut = null
  for (let i = 0; i < 120; i++) {
    // Deterministic alternating noise -- no Math.random, so the test cannot flake.
    const x = 0.5 + (i % 2 ? 0.01 : -0.01)
    const y = jitter.filter(x, i * 16.7)
    if (i > 40) {
      if (prevIn !== null) inputSwing += Math.abs(x - prevIn)
      if (prevOut !== null) outputSwing += Math.abs(y - prevOut)
    }
    prevIn = x
    prevOut = y
  }
  check(
    'jitter on a still pose is attenuated at least 5x',
    outputSwing * 5 < inputSwing,
    `input ${inputSwing.toFixed(3)} -> output ${outputSwing.toFixed(3)}`
  )

  const ramp = createOneEuroFilter({minCutoff: 1, beta: 0.8, derivativeCutoff: 1})
  let last = 0
  for (let i = 0; i < 60; i++) last = ramp.filter(i * 0.01, i * 16.7)
  check(
    'a fast movement is tracked with little lag',
    Math.abs(last - 59 * 0.01) < 0.05,
    `target ${(59 * 0.01).toFixed(3)} vs ${last.toFixed(3)}`
  )

  // --- centreline smoothing ---------------------------------------------------------------------
  const zigzag = () =>
    Array.from({length: 21}, (_, i) => new THREE.Vector3(i * 0.02, i % 2 ? 0.01 : -0.01, 0))

  const pathLength = (pts) => {
    let total = 0
    for (let i = 1; i < pts.length; i++) total += pts[i].distanceTo(pts[i - 1])
    return total
  }

  const rawZig = zigzag()
  const rawLength = pathLength(rawZig)
  const smoothed = smoothPolyline(rawZig, 4, 0.5)

  check(
    'smoothing shortens a zigzag',
    pathLength(smoothed) < rawLength * 0.8,
    `${rawLength.toFixed(3)} -> ${pathLength(smoothed).toFixed(3)}`
  )
  check(
    'smoothing pins both endpoints',
    smoothed[0].distanceTo(rawZig[0]) < 1e-9 &&
      smoothed[smoothed.length - 1].distanceTo(rawZig[rawZig.length - 1]) < 1e-9
  )
  check('smoothing preserves the point count', smoothed.length === rawZig.length)

  // The failure that would slowly flatten a stroke while it is being drawn: smoothing the input
  // in place, so every rebuild re-smooths an already-smoothed path.
  check(
    'smoothing does not modify its input',
    Math.abs(rawZig[1].y - 0.01) < 1e-12 && Math.abs(rawZig[2].y + 0.01) < 1e-12,
    `y1=${rawZig[1].y}`
  )

  const again = smoothPolyline(rawZig, 4, 0.5)
  check(
    'smoothing is deterministic across calls',
    again.every((p, i) => p.distanceTo(smoothed[i]) < 1e-12)
  )
  check(
    'smoothing a 2-point line is a no-op',
    smoothPolyline([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], 4, 0.5).length === 2
  )

  // --- tube builder -----------------------------------------------------------------------------
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

  // FrontSide is what lets you see straight through a tube you are standing inside, or through a
  // section where the sweep inverted on a tight corner.
  check(
    'the tube is double-sided',
    meshes.every((m) => m.material.side === THREE.DoubleSide),
    `side=${meshes[0]?.material.side}`
  )

  drawing.end()
  check('end() finalises exactly one stroke', !drawing.isDrawing && drawing.strokeCount === 1)

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

// --- the scale escape hatch ---------------------------------------------------------------------
{
  const altPage = await browser.newPage({viewport: {width: 390, height: 844}})
  await altPage.route(/(xr\.js|xr-slam\.js|xrextras\.js|landing-page\.js)(\?|$)/, (r) => r.abort())
  await altPage.addInitScript(stubEngine)
  const sep = URL_UNDER_TEST.includes('?') ? '&' : '?'
  await altPage.goto(`${URL_UNDER_TEST}${sep}scale=absolute`, {waitUntil: 'load'})
  const altConfig = await altPage.evaluate(() => window.__xrControllerConfig)
  record(
    `${altConfig?.scale === 'absolute' ? 'PASS' : 'FAIL'} ?scale=absolute overrides the default` +
      ` :: ${JSON.stringify(altConfig)}`
  )
  await altPage.close()
}

await browser.close()

const failed = results.filter((r) => r.startsWith('FAIL'))
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.log('\n--- browser console ---')
  console.log(consoleLines.join('\n'))
  process.exit(1)
}
