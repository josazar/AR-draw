// MediaPipe hand tracking, fed from the 8th Wall camera pipeline.
//
// The 8th Wall engine binary ships face tracking, image targets and SLAM, but *not* hand
// tracking, so the pinch gesture comes from MediaPipe's HandLandmarker. Both need camera frames,
// and opening a second getUserMedia stream on iOS is unreliable, so instead we borrow the frames
// 8th Wall already has via XR8.CameraPixelArray.

import {FilesetResolver, HandLandmarker} from '@mediapipe/tasks-vision'
import {CONFIG, LM} from './config'

// ------------------------------------------------------------------------------------------
// Image -> screen orientation
// ------------------------------------------------------------------------------------------
// The pixel array comes straight off the camera texture, which on a phone held upright is
// landscape while the screen is portrait. On top of that, glReadPixels returns rows bottom-up.
// The net transform depends on the device, so rather than hard-code a guess this is a settable
// rotation + flip that the "Calibrer" button cycles through and localStorage remembers.

const CALIBRATION_KEY = 'ar-draw.calibration'
export const CALIBRATION_STATES = 8

// Best first guess given the window orientation reported by the engine.
const defaultCalibrationFor = (orientation) => {
  switch (orientation) {
    case 90: return 0
    case 180: return 3
    case -90:
    case 270: return 2
    default: return 1  // portrait
  }
}

export const loadCalibration = (orientation) => {
  const stored = Number(localStorage.getItem(CALIBRATION_KEY))
  return Number.isInteger(stored) && stored >= 0 && stored < CALIBRATION_STATES
    ? stored
    : defaultCalibrationFor(orientation)
}

export const saveCalibration = (index) => localStorage.setItem(CALIBRATION_KEY, String(index))

// Maps a normalised point in the camera image to a normalised point on the screen. Both use a
// top-left origin.
export const imageToScreen = (x, y, calibration) => {
  const rot = calibration & 3
  let u = x
  let v = calibration >= 4 ? 1 - y : y

  if (rot === 1) {
    const t = u
    u = 1 - v
    v = t
  } else if (rot === 2) {
    u = 1 - u
    v = 1 - v
  } else if (rot === 3) {
    const t = u
    u = v
    v = 1 - t
  }
  return {u, v}
}

// ------------------------------------------------------------------------------------------
// Geometry helpers
// ------------------------------------------------------------------------------------------
// Landmarks are normalised to the image, so x and y have different physical scales unless the
// image is square. Measuring in pixel space keeps the ratios honest.

const pixelDistance = (a, b, cols, rows) => {
  const dx = (a.x - b.x) * cols
  const dy = (a.y - b.y) * rows
  return Math.hypot(dx, dy)
}

// Thumb-index gap over hand size. Scale-invariant, so the threshold holds whether the hand is
// near or far.
export const pinchRatio = (landmarks, cols, rows) => {
  const gap = pixelDistance(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP], cols, rows)
  const handSize = pixelDistance(landmarks[LM.WRIST], landmarks[LM.MIDDLE_MCP], cols, rows)
  return handSize > 1e-6 ? gap / handSize : Number.POSITIVE_INFINITY
}

// Apparent knuckle width, normalised against the image's long edge. Bigger = hand is closer.
export const knuckleSpan = (landmarks, cols, rows) => {
  const span = pixelDistance(landmarks[LM.INDEX_MCP], landmarks[LM.PINKY_MCP], cols, rows)
  return span / Math.max(cols, rows)
}

// ------------------------------------------------------------------------------------------
// Tracker
// ------------------------------------------------------------------------------------------

export const createHandTracker = async () => {
  const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`)

  const build = (modelAssetPath, delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: {modelAssetPath, delegate},
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })

  // Prefer the self-hosted model, and the GPU delegate, but neither is guaranteed: the build-time
  // download can fail, and the GPU delegate is not available on every iOS build. Walk the
  // combinations rather than dying on the first problem.
  const candidates = [
    [`${import.meta.env.BASE_URL}${CONFIG.handModelPathLocal}`, 'GPU'],
    [`${import.meta.env.BASE_URL}${CONFIG.handModelPathLocal}`, 'CPU'],
    [CONFIG.handModelUrlRemote, 'GPU'],
    [CONFIG.handModelUrlRemote, 'CPU'],
  ]

  let landmarker = null
  let delegateUsed = null
  let modelUsed = null
  const failures = []

  for (const [modelAssetPath, delegate] of candidates) {
    try {
      landmarker = await build(modelAssetPath, delegate)
      delegateUsed = delegate
      modelUsed = modelAssetPath
      break
    } catch (error) {
      failures.push(`${delegate} ${modelAssetPath}: ${error?.message || error}`)
    }
  }

  if (!landmarker) {
    throw new Error(`Impossible de charger le modele de main.\n${failures.join('\n')}`)
  }
  if (failures.length) {
    console.warn(`[hands] fell back after ${failures.length} failed attempt(s):\n${failures.join('\n')}`)
  }

  // Scratch canvas: MediaPipe wants an image source, we have a raw RGBA buffer.
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', {willReadFrequently: true})

  // detectForVideo rejects timestamps that do not strictly increase.
  let lastTimestamp = -1

  return {
    delegateUsed,
    modelUsed,

    // frame: {pixels, cols, rows} RGBA from XR8.CameraPixelArray.
    // Returns the 21 landmarks of the first detected hand, or null.
    detect(frame, timestampMs) {
      const {pixels, cols, rows} = frame
      if (!cols || !rows) return null

      if (canvas.width !== cols || canvas.height !== rows) {
        canvas.width = cols
        canvas.height = rows
      }

      // Share the buffer instead of copying it; the layout is already tightly packed RGBA.
      const clamped = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, cols * rows * 4)
      ctx.putImageData(new ImageData(clamped, cols, rows), 0, 0)

      const timestamp = timestampMs > lastTimestamp ? timestampMs : lastTimestamp + 1
      lastTimestamp = timestamp

      const result = landmarker.detectForVideo(canvas, timestamp)
      return result?.landmarks?.length ? result.landmarks[0] : null
    },
  }
}
