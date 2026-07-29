// Entry point. Wires the 8th Wall camera pipeline, MediaPipe hand tracking and the tube drawing
// together.
//
// The idea in one line: 8th Wall's SLAM tells us where the phone is in the room, MediaPipe tells
// us where the fingertip is on the screen, and casting a ray from one through the other gives a
// point in world space. Because that point is expressed in the SLAM world frame, the tube stays
// put when the phone moves.

import * as THREE from 'three'
import {CONFIG, HAND_CONNECTIONS, LM} from './config'
import {createHandTracker, estimateDepthMeters, imageToScreen, pinchRatio} from './hand-tracking'
import {createOneEuroFilter} from './one-euro'
import {createDrawing} from './tube-drawing'

// XRExtras expects to find three.js on the window.
window.THREE = THREE

// Injected by vite at build time; see vite.config.js.
const BUILD = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'local',
  time: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '',
}

const ui = {
  version: document.getElementById('version'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  overlay: document.getElementById('debugoverlay'),
  undo: document.getElementById('btn-undo'),
  clear: document.getElementById('btn-clear'),
  color: document.getElementById('btn-color'),
  depth: document.getElementById('btn-depth'),
  debug: document.getElementById('btn-debug'),
}

const setStatus = (text, kind = '') => {
  ui.status.textContent = text
  ui.status.className = `pill ${kind}`
}

// Collapsed by default so it stays out of the way; tapping reveals the commit and build time,
// which is what actually identifies a deploy.
const wireVersionBadge = () => {
  let expanded = false
  const render = () => {
    ui.version.textContent = expanded
      ? `v${BUILD.version}\n${BUILD.commit}\n${BUILD.time}`
      : `v${BUILD.version}`
  }
  ui.version.addEventListener('click', () => {
    expanded = !expanded
    render()
  })
  render()
}
wireVersionBadge()

const ardrawPipelineModule = () => {
  let scene
  let camera
  let arCanvas
  let drawing
  let tracker = null

  let autoDepth = true
  let debugVisible = false
  let modelSource = null

  // Latest detection ({landmarks, worldLandmarks}), reused on frames where detection is skipped.
  let detection = null
  // Where the engine last drew the camera image, in canvas pixels. Needed to map a landmark to a
  // screen position; see imageToScreen.
  let cameraViewport = null
  let frameCounter = 0

  // Rolling average of inference time, driving the automatic detection stride.
  let detectMsEma = 0
  let detectStride = 1
  let detectCount = 0

  // Measurement-space smoothing: the fingertip on screen, and its distance.
  const filterU = createOneEuroFilter(CONFIG.filterScreen)
  const filterV = createOneEuroFilter(CONFIG.filterScreen)
  const filterDepth = createOneEuroFilter(CONFIG.filterDepth)
  let smoothedDepth = CONFIG.depthFixed
  const tipWorld = new THREE.Vector3()

  const resetFilters = () => {
    filterU.reset()
    filterV.reset()
    filterDepth.reset()
  }

  // Pinch debouncing.
  let pinchHeld = false
  let pinchCandidate = false
  let pinchStreak = 0
  let lastPinchRatio = Number.POSITIVE_INFINITY

  const overlayCtx = ui.overlay.getContext('2d')
  const rayTarget = new THREE.Vector3()
  const cameraWorldPos = new THREE.Vector3()

  // Counters exposed on window for the headless harness; also handy from Safari's Web Inspector
  // when debugging on a real phone.
  const stats = {frames: 0, framesWithHand: 0, pinchEvents: 0}

  const initScene = () => {
    // MeshLambertMaterial needs light to be visible at all.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404060, 2.0))
    const key = new THREE.DirectionalLight(0xffffff, 1.0)
    key.position.set(2, 4, 3)
    scene.add(key)

    // Must sit above y=0 for SLAM to initialise with a sensible ground plane.
    camera.position.set(0, 1.4, 0)
  }

  // Projects a normalised screen point out to `depth` metres along the camera ray, in world space.
  const screenToWorld = (u, v, depth) => {
    camera.updateMatrixWorld()
    camera.getWorldPosition(cameraWorldPos)

    rayTarget.set(u * 2 - 1, -(v * 2 - 1), 0.5).unproject(camera)
    return rayTarget.sub(cameraWorldPos).normalize().multiplyScalar(depth).add(cameraWorldPos)
  }

  const resizeOverlay = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    ui.overlay.width = window.innerWidth * dpr
    ui.overlay.height = window.innerHeight * dpr
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  const drawDebugOverlay = (points) => {
    overlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    if (!points) return

    const toPx = ({u, v}) => [u * window.innerWidth, v * window.innerHeight]

    overlayCtx.strokeStyle = pinchHeld ? '#34c759' : 'rgba(255,255,255,0.85)'
    overlayCtx.lineWidth = 2
    overlayCtx.beginPath()
    for (const [a, b] of HAND_CONNECTIONS) {
      overlayCtx.moveTo(...toPx(points[a]))
      overlayCtx.lineTo(...toPx(points[b]))
    }
    overlayCtx.stroke()

    overlayCtx.fillStyle = pinchHeld ? '#34c759' : '#0a84ff'
    for (const point of points) {
      const [x, y] = toPx(point)
      overlayCtx.beginPath()
      overlayCtx.arc(x, y, 3, 0, Math.PI * 2)
      overlayCtx.fill()
    }

    // Ring on the fingertip that is actually drawing, so it is obvious which point is tracked.
    const [tx, ty] = toPx(points[LM.INDEX_TIP])
    overlayCtx.strokeStyle = '#ffd60a'
    overlayCtx.lineWidth = 3
    overlayCtx.beginPath()
    overlayCtx.arc(tx, ty, 12, 0, Math.PI * 2)
    overlayCtx.stroke()
  }

  const wireControls = () => {
    ui.undo.addEventListener('click', () => drawing.undo())
    ui.clear.addEventListener('click', () => drawing.clear())

    ui.color.addEventListener('click', () => {
      const color = drawing.nextColor()
      ui.color.style.color = `#${color.toString(16).padStart(6, '0')}`
    })

    ui.depth.addEventListener('click', () => {
      autoDepth = !autoDepth
      ui.depth.textContent = autoDepth ? 'Prof. auto' : 'Prof. fixe'
      ui.depth.classList.toggle('on', !autoDepth)
    })

    ui.debug.addEventListener('click', () => {
      debugVisible = !debugVisible
      ui.overlay.classList.toggle('visible', debugVisible)
      ui.debug.classList.toggle('on', debugVisible)
      if (!debugVisible) overlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight)
    })

    window.addEventListener('resize', resizeOverlay)
    resizeOverlay()
  }

  const toScreenPoints = (raw) =>
    raw.map(({x, y}) => imageToScreen(x, y, cameraViewport, arCanvas.width, arCanvas.height))

  const updatePinchState = (ratio) => {
    const wantsPinch = pinchHeld
      ? ratio < CONFIG.pinchOpenRatio    // stay pinched until clearly open
      : ratio < CONFIG.pinchCloseRatio   // require a clear pinch to start

    if (wantsPinch === pinchCandidate) {
      pinchStreak += 1
    } else {
      pinchCandidate = wantsPinch
      pinchStreak = 1
    }

    if (pinchStreak >= CONFIG.pinchDebounceFrames && pinchCandidate !== pinchHeld) {
      pinchHeld = pinchCandidate
      return true  // state changed
    }
    return false
  }

  return {
    name: 'ardraw',

    onStart: ({canvas}) => {
      arCanvas = canvas
      ;({scene, camera} = XR8.Threejs.xrScene())

      initScene()
      drawing = createDrawing(scene)
      wireControls()

      canvas.addEventListener('touchmove', (event) => event.preventDefault(), {passive: false})

      XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      })

      window.__ardraw = {
        stats,
        get state() {
          return {
            ...stats,
            pinchHeld,
            autoDepth,
            detectStride,
            detectMs: Number(detectMsEma.toFixed(1)),
            depth: smoothedDepth,
            pinchRatio: lastPinchRatio,
            strokes: drawing.strokeCount,
            modelSource,
            viewport: cameraViewport,
            cameraPosition: camera.position.toArray().map((n) => Number(n.toFixed(4))),
          }
        },
      }

      setStatus('Chargement du suivi de main…')

      // Report progress: the model is ~7.8 MB, so on mobile data this stage is long enough that
      // silence is indistinguishable from a hang.
      const onProgress = ({stage, received, total}) => {
        if (stage === 'wasm') setStatus('Chargement du moteur de vision…')
        else if (stage === 'init') setStatus('Initialisation du suivi…')
        else if (stage === 'model') {
          const mb = (received / 1e6).toFixed(1)
          setStatus(total
            ? `Téléchargement du modèle ${mb}/${(total / 1e6).toFixed(1)} Mo`
            : `Téléchargement du modèle ${mb} Mo`)
        }
      }

      createHandTracker(onProgress)
        .then((created) => {
          tracker = created
          modelSource = created.modelUsed
          setStatus('Montrez votre main')
          console.log(`[ardraw] MediaPipe delegate=${created.delegateUsed} model=${created.modelUsed}`)
        })
        .catch((error) => {
          console.error('[ardraw] hand tracker failed to load', error)
          setStatus('Suivi de main indisponible', 'error')
          // On screen, not just in the console: a phone has no console.
          ui.hint.textContent = String(error?.message || error)
        })
    },

    // The pixel array is published on processGpuResult, not processCpuResult -- the module reads
    // it back off the GPU during the GPU phase. The camera viewport arrives the same way.
    onUpdate: ({processGpuResult}) => {
      if (!tracker) return

      // Where the engine drew the camera this frame. Empty on the first frame or two.
      const viewport = processGpuResult?.gltexturerenderer?.viewport
      if (viewport?.width) cameraViewport = viewport

      const frame = processGpuResult?.camerapixelarray
      if (frame?.pixels) {
        frameCounter += 1
        stats.frames += 1

        // Adapt how often inference runs to what the device can actually sustain, unless the
        // stride has been pinned in config.
        if (CONFIG.detectEveryNFrames > 0) {
          detectStride = CONFIG.detectEveryNFrames
        } else if (detectMsEma > CONFIG.detectBudgetHighMs) {
          detectStride = 3
        } else if (detectMsEma > CONFIG.detectBudgetMs) {
          detectStride = 2
        } else {
          detectStride = 1
        }

        if (frameCounter % detectStride === 0) {
          const started = performance.now()
          try {
            detection = tracker.detect(frame, started)
          } catch (error) {
            console.warn('[ardraw] detection failed', error)
          }
          // The first inference pays for graph warm-up and is several orders of magnitude slower
          // than steady state; letting it seed the average would pin the stride at its slowest
          // for the next few seconds.
          const elapsed = performance.now() - started
          detectCount += 1
          if (detectCount === 2) detectMsEma = elapsed
          else if (detectCount > 2) detectMsEma = detectMsEma * 0.9 + elapsed * 0.1
        }
      }

      if (!detection) {
        // Losing the hand mid-stroke should close the tube, not leave it dangling.
        if (pinchHeld) {
          pinchHeld = false
          pinchCandidate = false
          pinchStreak = 0
          drawing.end()
          setStatus('Main perdue — tube fermé')
        } else {
          setStatus('Aucune main détectée')
        }
        // Do not carry smoothing across a gap: the hand may reappear somewhere else entirely.
        resetFilters()
        if (debugVisible) drawDebugOverlay(null)
        return
      }

      stats.framesWithHand += 1

      const {landmarks, worldLandmarks} = detection
      const {cols, rows} = frame
      lastPinchRatio = pinchRatio(landmarks, cols, rows)
      const changed = updatePinchState(lastPinchRatio)
      if (changed && pinchHeld) stats.pinchEvents += 1

      const screenPoints = toScreenPoints(landmarks)
      const now = performance.now()

      // Metric depth from the hand's real size and the camera projection. No constant to tune,
      // and it adapts to whoever is holding the phone.
      if (autoDepth && worldLandmarks) {
        const measured = estimateDepthMeters(
          screenPoints,
          worldLandmarks,
          arCanvas.width / arCanvas.height,
          camera.projectionMatrix.elements[5]
        )
        if (measured !== null) {
          smoothedDepth = THREE.MathUtils.clamp(
            filterDepth.filter(measured, now), CONFIG.depthMin, CONFIG.depthMax
          )
        }
      } else {
        smoothedDepth = CONFIG.depthFixed
      }

      // Smooth in measurement space, then project. Doing it the other way round would smear the
      // drawing whenever the phone moves, since the camera pose is exact and needs no filtering.
      const tip = screenPoints[LM.INDEX_TIP]
      const world = screenToWorld(
        filterU.filter(tip.u, now), filterV.filter(tip.v, now), smoothedDepth
      )
      tipWorld.copy(world)

      if (changed) {
        if (pinchHeld) {
          drawing.begin(tipWorld)
        } else {
          drawing.end()
        }
      } else if (pinchHeld) {
        drawing.extend(tipWorld)
      }

      if (debugVisible) {
        drawDebugOverlay(screenPoints)
        setStatus(
          `pinch ${lastPinchRatio.toFixed(2)} · prof ${smoothedDepth.toFixed(2)}m · ` +
          `${detectMsEma.toFixed(0)}ms /${detectStride} · ${drawing.strokeCount} tubes`,
          pinchHeld ? 'drawing' : ''
        )
      } else {
        setStatus(
          pinchHeld ? 'Dessin en cours…' : 'Main détectée — pincez pour dessiner',
          pinchHeld ? 'drawing' : ''
        )
      }
    },
  }
}

const onxrloaded = () => {
  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),  // Draws the camera feed.
    XR8.Threejs.pipelineModule(),            // Creates the three.js scene.
    XR8.XrController.pipelineModule(),       // SLAM world tracking.

    // Hands MediaPipe a downscaled RGBA copy of each camera frame.
    XR8.CameraPixelArray.pipelineModule({
      luminance: false,
      maxDimension: CONFIG.cameraMaxDimension,
    }),

    LandingPage.pipelineModule(),                // Unsupported-browser fallback.
    XRExtras.FullWindowCanvas.pipelineModule(),  // Canvas fills the window.
    XRExtras.Loading.pipelineModule(),           // Startup loading screen.
    XRExtras.RuntimeError.pipelineModule(),      // Error screen.

    ardrawPipelineModule(),
  ])

  XR8.run({canvas: document.getElementById('camerafeed')})
}

window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)
