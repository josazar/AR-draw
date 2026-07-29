// Entry point. Wires the 8th Wall camera pipeline to the tube drawing.
//
// The idea in one line: 8th Wall's SLAM tells us where the phone is in the room, the brush sits a
// fixed distance straight ahead of the lens, and moving the phone drags that brush through space.
// Because the brush position is derived from the SLAM camera pose, it lands in the world frame,
// which is what keeps a finished tube where you drew it.

import * as THREE from 'three'
import {CONFIG} from './config'
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
  versionToggle: document.getElementById('version-toggle'),
  versionDetails: document.getElementById('version-details'),
  versionBuild: document.getElementById('version-build'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  reticle: document.getElementById('reticle'),
  reticleDot: document.getElementById('reticle-dot'),
  depthSlider: document.getElementById('depth-slider'),
  depthValue: document.getElementById('depth-value'),
  undo: document.getElementById('btn-undo'),
  clear: document.getElementById('btn-clear'),
  color: document.getElementById('btn-color'),
  debug: document.getElementById('btn-debug'),
}

const setStatus = (text, kind = '') => {
  ui.status.textContent = text
  ui.status.className = `pill ${kind}`
}

// Collapsed by default so it stays out of the way; tapping reveals the commit and build time,
// which is what actually identifies a deploy, plus the engine attribution the licence requires.
const wireVersionBadge = () => {
  ui.versionToggle.textContent = `v${BUILD.version}`
  ui.versionBuild.textContent = `${BUILD.commit}\n${BUILD.time}`
  ui.versionToggle.addEventListener('click', () => {
    ui.versionDetails.hidden = !ui.versionDetails.hidden
  })
}
wireVersionBadge()

const ardrawPipelineModule = () => {
  let scene
  let camera
  let drawing
  let debugVisible = false

  // Every stroke lives under this group rather than directly in the scene, so the whole drawing
  // can be moved as one when SLAM shifts the world frame beneath it.
  let contentRoot

  // Press and hold in the centre zone, then move the phone to draw.
  let touchPointerId = null
  let touchTimer = null
  let touchDrawing = false

  let drawDepth = CONFIG.drawDepth
  const filterWorld = {
    x: createOneEuroFilter(CONFIG.filterWorld),
    y: createOneEuroFilter(CONFIG.filterWorld),
    z: createOneEuroFilter(CONFIG.filterWorld),
  }

  // SLAM health, straight from the engine, and how much the camera pose moves frame to frame.
  // A finished tube is static geometry, so if it shakes the pose is shaking -- these two numbers
  // are what tell a tracking problem apart from anything else.
  let trackingStatus = null
  let trackingReason = null
  let poseJitterMm = 0
  const lastCameraPos = new THREE.Vector3()
  let hasLastCameraPos = false

  const brushWorld = new THREE.Vector3()
  const rayTarget = new THREE.Vector3()
  const cameraWorldPos = new THREE.Vector3()
  let lastDotPx = -1

  // Pose-jump detection. Real motion is continuous; a relocalisation is a single-frame
  // discontinuity, so a spike against the recent median is the discriminator.
  const previousCameraMatrix = new THREE.Matrix4()
  let hasPreviousCameraMatrix = false
  const deltaHistory = []
  const jumpTransform = new THREE.Matrix4()
  const inversePrevious = new THREE.Matrix4()

  const stats = {frames: 0, jumpsCompensated: 0, pausedFrames: 0}

  const initScene = () => {
    // MeshLambertMaterial needs light to be visible at all.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404060, 2.0))
    const key = new THREE.DirectionalLight(0xffffff, 1.0)
    key.position.set(2, 4, 3)
    scene.add(key)

    contentRoot = new THREE.Group()
    contentRoot.matrixAutoUpdate = false
    scene.add(contentRoot)

    // Must sit above y=0 for SLAM to initialise with a sensible ground plane.
    camera.position.set(0, 1.4, 0)
  }

  // The brush: straight ahead of the lens, drawDepth metres out, in world coordinates.
  const brushPosition = () => {
    camera.updateMatrixWorld()
    camera.getWorldPosition(cameraWorldPos)
    rayTarget.set(0, 0, 0.5).unproject(camera)
    return rayTarget.sub(cameraWorldPos).normalize().multiplyScalar(drawDepth).add(cameraWorldPos)
  }

  // Smoothed brush position. The brush is rigidly attached to the camera, so its world position
  // IS the camera pose, and SLAM's noise lands straight in the drawing. Filtering it here is
  // filtering the noisy measurement, not fighting the tracker.
  const smoothedBrush = (now) => {
    const raw = brushPosition()
    brushWorld.set(
      filterWorld.x.filter(raw.x, now),
      filterWorld.y.filter(raw.y, now),
      filterWorld.z.filter(raw.z, now)
    )
    return brushWorld
  }

  // The inner dot previews the tube's apparent thickness at the chosen distance: a length L at
  // distance d covers L * P[5] / (2d) of the screen height. It gives the slider a visible
  // consequence before committing to a stroke.
  const updateReticleDot = () => {
    if (!camera) return
    const p5 = camera.projectionMatrix.elements[5]
    const px = ((2 * CONFIG.tubeRadius * p5) / (2 * drawDepth)) * window.innerHeight
    const clamped = Math.max(3, Math.min(px, 170))
    if (Math.abs(clamped - lastDotPx) < 0.5) return
    lastDotPx = clamped
    ui.reticleDot.style.width = `${clamped}px`
    ui.reticleDot.style.height = `${clamped}px`
  }

  // Human, actionable wording. "LIMITED" tells the user nothing; "aim at something textured" does.
  const trackingMessage = () => {
    // null = the engine has not reported yet. Treated as fine rather than degraded: a missing
    // field must never be able to block drawing forever.
    if (trackingStatus === null || trackingStatus === 'NORMAL') return null
    switch (trackingReason) {
      case 'INITIALIZING': return 'Initialisation du suivi — bougez lentement le téléphone'
      case 'RELOCALIZING': return 'Suivi perdu — revenez vers ce que vous filmiez'
      case 'EXCESSIVE_MOTION': return 'Mouvement trop rapide — ralentissez'
      case 'INSUFFICIENT_FEATURES': return 'Surface trop uniforme — visez une zone texturée'
      case 'INSUFFICIENT_LIGHT': return 'Lumière insuffisante'
      default: return 'Suivi dégradé'
    }
  }

  const trackingIsGood = () => trackingStatus === null || trackingStatus === 'NORMAL'

  // A relocalisation moves the world frame under the drawing. If the camera pose jumped from A to
  // B while the phone did not physically move, the frame shifted by B*inv(A); applying that same
  // transform to the content keeps it where the user last saw it.
  //
  // Compensating means preferring visual continuity over SLAM's corrected estimate. That is the
  // right call here: the drawing is the artefact, and having it teleport is worse than having it
  // a few centimetres off.
  const compensateJumpIfAny = () => {
    const currentMatrix = camera.matrixWorld

    if (!hasPreviousCameraMatrix) {
      previousCameraMatrix.copy(currentMatrix)
      hasPreviousCameraMatrix = true
      return false
    }

    const delta = cameraWorldPos.distanceTo(lastCameraPos)

    let jumped = false
    if (CONFIG.compensateTrackingJumps && deltaHistory.length >= CONFIG.jumpHistoryFrames) {
      const sorted = [...deltaHistory].sort((a, b) => a - b)
      const median = sorted[sorted.length >> 1]
      jumped = delta > CONFIG.jumpMinMetres && delta > median * CONFIG.jumpRelativeToMedian
    }

    if (jumped) {
      inversePrevious.copy(previousCameraMatrix).invert()
      jumpTransform.multiplyMatrices(currentMatrix, inversePrevious)
      contentRoot.matrix.premultiply(jumpTransform)
      contentRoot.matrixWorldNeedsUpdate = true
      stats.jumpsCompensated += 1
      // The history describes motion before the jump and would otherwise mask the next one.
      deltaHistory.length = 0
    } else {
      deltaHistory.push(delta)
      if (deltaHistory.length > CONFIG.jumpHistoryFrames) deltaHistory.shift()
    }

    previousCameraMatrix.copy(currentMatrix)
    return jumped
  }

  const setReticle = (state) => {
    ui.reticle.className = state
  }

  const inCentreZone = (clientX, clientY) => {
    const dx = clientX - window.innerWidth / 2
    const dy = clientY - window.innerHeight / 2
    const radius = Math.min(window.innerWidth, window.innerHeight) * CONFIG.touchZoneRadius
    return Math.hypot(dx, dy) <= radius
  }

  const startStroke = () => {
    touchTimer = null
    touchDrawing = true
    setReticle('drawing')
    // No filter history yet; resetting makes the first sample the current position rather than a
    // lurch from wherever the previous stroke ended.
    filterWorld.x.reset()
    filterWorld.y.reset()
    filterWorld.z.reset()
    drawing.begin(smoothedBrush(performance.now()))
  }

  const releaseTouch = () => {
    touchPointerId = null
    if (touchTimer !== null) {
      clearTimeout(touchTimer)
      touchTimer = null
    }
    if (touchDrawing) {
      touchDrawing = false
      drawing.end()
    }
    setReticle('')
  }

  // Listeners on the window, not the canvas: the canvas is sized by the engine, and a press that
  // missed it would silently do nothing. Pointer events rather than touch events, so the same
  // path works with a mouse -- which is what makes this testable headlessly.
  const wireTouchDrawing = () => {
    window.addEventListener('pointerdown', (event) => {
      if (touchPointerId !== null) return
      // Never steal a press meant for a control.
      if (event.target?.closest?.('#controls, #version, #depth')) return
      if (!inCentreZone(event.clientX, event.clientY)) return

      touchPointerId = event.pointerId
      setReticle('armed')
      touchTimer = setTimeout(startStroke, CONFIG.longPressMs)
    })

    const onEnd = (event) => {
      if (event.pointerId !== touchPointerId) return
      releaseTouch()
    }
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  const wireDepthSlider = () => {
    const apply = () => {
      drawDepth = Number(ui.depthSlider.value) / 100
      ui.depthValue.textContent = drawDepth >= 1
        ? `${drawDepth.toFixed(2).replace('.', ',')} m`
        : `${Math.round(drawDepth * 100)} cm`
      updateReticleDot()
    }
    ui.depthSlider.min = String(Math.round(CONFIG.drawDepthMin * 100))
    ui.depthSlider.max = String(Math.round(CONFIG.drawDepthMax * 100))
    ui.depthSlider.value = String(Math.round(CONFIG.drawDepth * 100))
    ui.depthSlider.addEventListener('input', apply)
    apply()
  }

  const wireControls = () => {
    ui.undo.addEventListener('click', () => drawing.undo())
    ui.clear.addEventListener('click', () => drawing.clear())

    ui.color.addEventListener('click', () => {
      const color = drawing.nextColor()
      ui.color.style.color = `#${color.toString(16).padStart(6, '0')}`
    })

    ui.debug.addEventListener('click', () => {
      debugVisible = !debugVisible
      ui.debug.classList.toggle('on', debugVisible)
    })

    window.addEventListener('resize', updateReticleDot)
  }

  return {
    name: 'ardraw',

    onStart: ({canvas}) => {
      ;({scene, camera} = XR8.Threejs.xrScene())

      initScene()
      drawing = createDrawing(contentRoot)
      wireControls()
      wireDepthSlider()
      wireTouchDrawing()

      canvas.addEventListener('touchmove', (event) => event.preventDefault(), {passive: false})

      XR8.XrController.updateCameraProjectionMatrix({
        origin: camera.position,
        facing: camera.quaternion,
      })

      window.__ardraw = {
        stats,
        // Exposed for the harness: jump compensation is a transform on this group, and the only
        // honest way to test it is to check the maths on it.
        contentRoot,
        get state() {
          return {
            ...stats,
            touchDrawing,
            drawDepth,
            strokes: drawing.strokeCount,
            trackingStatus,
            trackingReason,
            poseJitterMm: Number(poseJitterMm.toFixed(2)),
            cameraPosition: camera.position.toArray().map((n) => Number(n.toFixed(4))),
          }
        },
      }

      setStatus('Appui long au centre pour dessiner')
    },

    onUpdate: ({processCpuResult}) => {
      stats.frames += 1

      const reality = processCpuResult?.reality
      if (reality) {
        trackingStatus = reality.trackingStatus ?? trackingStatus
        trackingReason = reality.trackingReason ?? trackingReason
      }

      camera.updateMatrixWorld()
      camera.getWorldPosition(cameraWorldPos)

      // Must run before lastCameraPos is updated: it measures this frame's step.
      const jumped = hasLastCameraPos ? compensateJumpIfAny() : false

      if (hasLastCameraPos && !jumped) {
        poseJitterMm = poseJitterMm * 0.9 + cameraWorldPos.distanceTo(lastCameraPos) * 1000 * 0.1
      }
      lastCameraPos.copy(cameraWorldPos)
      hasLastCameraPos = true

      updateReticleDot()

      const degraded = CONFIG.pauseDrawingWhenTrackingDegraded && !trackingIsGood()

      if (touchDrawing && !degraded) {
        // Recomputed every frame: the brush is fixed relative to the camera, so the phone's
        // motion through the room is what lays down the tube.
        drawing.extend(smoothedBrush(performance.now()))
      } else if (touchDrawing) {
        // Paused, not ended: points recorded now would be placed against a pose about to be
        // corrected. The stroke resumes from where it stopped once tracking recovers, and the
        // filter is reset so it does not interpolate across the gap.
        stats.pausedFrames += 1
        filterWorld.x.reset()
        filterWorld.y.reset()
        filterWorld.z.reset()
      }

      const warning = trackingMessage()

      if (debugVisible) {
        setStatus(
          `prof ${drawDepth.toFixed(2)}m · slam ${trackingStatus || '?'}/${trackingReason || '?'} ` +
          `${poseJitterMm.toFixed(1)}mm/f · ${stats.jumpsCompensated} recal · ` +
          `${drawing.strokeCount} tubes`,
          warning ? 'error' : touchDrawing ? 'drawing' : ''
        )
      } else if (warning) {
        setStatus(warning, 'error')
      } else {
        setStatus(
          touchDrawing ? 'Dessin en cours…' : 'Appui long au centre pour dessiner',
          touchDrawing ? 'drawing' : ''
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

    LandingPage.pipelineModule(),                // Unsupported-browser fallback.
    XRExtras.FullWindowCanvas.pipelineModule(),  // Canvas fills the window.
    XRExtras.Loading.pipelineModule(),           // Startup loading screen.
    XRExtras.RuntimeError.pipelineModule(),      // Error screen.

    ardrawPipelineModule(),
  ])

  // 'responsive' locks world scale at initialisation, from the assumed starting camera height.
  // That makes it metrically approximate but STABLE. 'absolute' uses the raw monocular VIO scale
  // estimate, which is metrically honest but gets refined as the device moves -- and when it is
  // refined, everything already placed changes size. Walking out of a room and back is exactly
  // the case that triggers a re-estimate, and a drawing that shrinks is worse than a drawing
  // that is 20% off, so stability wins.
  //
  // ?scale=absolute opts back in, for comparing the two on a real device. It has to be decided
  // here: the engine refuses a scale change after XR8.run().
  const scale = new URLSearchParams(location.search).get('scale') === 'absolute'
    ? 'absolute'
    : 'responsive'
  XR8.XrController.configure({scale})
  window.__ardrawScale = scale

  XR8.run({canvas: document.getElementById('camerafeed')})
}

window.XR8 ? onxrloaded() : window.addEventListener('xrloaded', onxrloaded)
