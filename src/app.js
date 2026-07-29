// Entry point. Wires the 8th Wall camera pipeline, MediaPipe hand tracking and the tube drawing
// together.
//
// The idea in one line: 8th Wall's SLAM tells us where the phone is in the room, MediaPipe tells
// us where the fingertip is on the screen, and casting a ray from one through the other gives a
// point in world space. Because that point is expressed in the SLAM world frame, the tube stays
// put when the phone moves.

import * as THREE from 'three'
import {CONFIG, HAND_CONNECTIONS} from './config'
import {
  CALIBRATION_STATES,
  createHandTracker,
  imageToScreen,
  knuckleSpan,
  loadCalibration,
  pinchRatio,
  saveCalibration,
} from './hand-tracking'
import {createDrawing} from './tube-drawing'

// XRExtras expects to find three.js on the window.
window.THREE = THREE

const ui = {
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  overlay: document.getElementById('debugoverlay'),
  undo: document.getElementById('btn-undo'),
  clear: document.getElementById('btn-clear'),
  color: document.getElementById('btn-color'),
  depth: document.getElementById('btn-depth'),
  calib: document.getElementById('btn-calib'),
  debug: document.getElementById('btn-debug'),
}

const setStatus = (text, kind = '') => {
  ui.status.textContent = text
  ui.status.className = `pill ${kind}`
}

const screenAngle = () => {
  const angle = window.screen?.orientation?.angle
  return Number.isFinite(angle) ? angle : (window.orientation || 0)
}

const ardrawPipelineModule = () => {
  let scene
  let camera
  let drawing
  let tracker = null

  let calibration = loadCalibration(screenAngle())
  let autoDepth = true
  let debugVisible = false

  // Latest detection, reused on frames where detection is skipped.
  let landmarks = null
  let frameCounter = 0

  // Smoothed state.
  let smoothedDepth = CONFIG.depthFixed
  const smoothedTip = new THREE.Vector3()
  let hasSmoothedTip = false

  // Pinch debouncing.
  let pinchHeld = false
  let pinchCandidate = false
  let pinchStreak = 0
  let lastPinchRatio = Number.POSITIVE_INFINITY

  const overlayCtx = ui.overlay.getContext('2d')
  const rayTarget = new THREE.Vector3()
  const cameraWorldPos = new THREE.Vector3()

  const initScene = () => {
    // MeshStandardMaterial needs light to be visible at all.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404060, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
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

    ui.calib.addEventListener('click', () => {
      calibration = (calibration + 1) % CALIBRATION_STATES
      saveCalibration(calibration)
      ui.hint.textContent = `Calibrage ${calibration + 1}/${CALIBRATION_STATES} — le squelette doit suivre votre main`
      if (!debugVisible) ui.debug.click()
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

  // Converts the raw landmark list into screen-space points using the current calibration.
  const toScreenPoints = (raw) => raw.map(({x, y}) => imageToScreen(x, y, calibration))

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
      ;({scene, camera} = XR8.Threejs.xrScene())

      initScene()
      drawing = createDrawing(scene)
      wireControls()

      canvas.addEventListener('touchmove', (event) => event.preventDefault(), {passive: false})

      XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      })

      setStatus('Chargement du suivi de main…')
      createHandTracker()
        .then((created) => {
          tracker = created
          setStatus('Montrez votre main')
          ui.hint.textContent = 'Pincez pouce + index pour dessiner'
          console.log(`[ardraw] MediaPipe delegate=${created.delegateUsed} model=${created.modelUsed}`)
        })
        .catch((error) => {
          console.error('[ardraw] hand tracker failed to load', error)
          setStatus('Suivi de main indisponible', 'error')
          ui.hint.textContent = String(error?.message || error)
        })
    },

    onUpdate: ({processCpuResult}) => {
      if (!tracker) return

      const frame = processCpuResult?.camerapixelarray
      if (frame?.pixels) {
        frameCounter += 1
        if (frameCounter % CONFIG.detectEveryNFrames === 0) {
          try {
            landmarks = tracker.detect(frame, performance.now())
          } catch (error) {
            console.warn('[ardraw] detection failed', error)
          }
        }
      }

      if (!landmarks) {
        // Losing the hand mid-stroke should close the tube, not leave it dangling.
        if (pinchHeld) {
          pinchHeld = false
          pinchCandidate = false
          pinchStreak = 0
          drawing.end()
          setStatus('Main perdue — tube ferme')
        } else if (!drawing.isDrawing) {
          setStatus('Montrez votre main')
        }
        hasSmoothedTip = false
        if (debugVisible) drawDebugOverlay(null)
        return
      }

      const {cols, rows} = frame
      lastPinchRatio = pinchRatio(landmarks, cols, rows)
      const changed = updatePinchState(lastPinchRatio)

      // Depth from apparent hand size, so pushing the hand away pushes the tube away too.
      if (autoDepth) {
        const span = knuckleSpan(landmarks, cols, rows)
        const raw = span > 1e-6
          ? THREE.MathUtils.clamp(CONFIG.depthCalibration / span, CONFIG.depthMin, CONFIG.depthMax)
          : CONFIG.depthFixed
        smoothedDepth += (raw - smoothedDepth) * CONFIG.depthSmoothing
      } else {
        smoothedDepth = CONFIG.depthFixed
      }

      const screenPoints = toScreenPoints(landmarks)
      const tip = screenPoints[8]  // index fingertip
      const world = screenToWorld(tip.u, tip.v, smoothedDepth)

      if (hasSmoothedTip) {
        smoothedTip.lerp(world, CONFIG.positionSmoothing)
      } else {
        smoothedTip.copy(world)
        hasSmoothedTip = true
      }

      if (changed) {
        if (pinchHeld) {
          drawing.begin(smoothedTip)
        } else {
          drawing.end()
        }
      } else if (pinchHeld) {
        drawing.extend(smoothedTip)
      }

      if (debugVisible) {
        drawDebugOverlay(screenPoints)
        setStatus(
          `pinch ${lastPinchRatio.toFixed(2)} · prof ${smoothedDepth.toFixed(2)}m · ` +
          `calib ${calibration + 1}/${CALIBRATION_STATES} · ${drawing.strokeCount} tubes`,
          pinchHeld ? 'drawing' : ''
        )
      } else {
        setStatus(pinchHeld ? 'Dessin en cours…' : 'Pincez pour dessiner', pinchHeld ? 'drawing' : '')
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
