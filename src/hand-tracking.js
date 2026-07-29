// MediaPipe hand tracking, fed from the 8th Wall camera pipeline.
//
// The 8th Wall engine binary ships face tracking, image targets and SLAM, but *not* hand
// tracking, so the pinch gesture comes from MediaPipe's HandLandmarker. Both need camera frames,
// and opening a second getUserMedia stream on iOS is unreliable, so instead we borrow the frames
// 8th Wall already has via XR8.CameraPixelArray.

import {FilesetResolver, HandLandmarker} from '@mediapipe/tasks-vision'
import {CONFIG, LM} from './config'

// ------------------------------------------------------------------------------------------
// Image -> screen
// ------------------------------------------------------------------------------------------
// GlTextureRenderer reports the exact rectangle it drew the camera into, as
// processGpuResult.gltexturerenderer.viewport, in canvas pixels. The camera image is scaled to
// cover the canvas and cropped, never rotated, and CameraPixelArray hands back that same image
// upright. So the mapping is a plain scale-and-offset -- no orientation guesswork, and it stays
// correct whatever the device does, because it is the engine's own number.
//
// Verified against a marker clip: a bright block in the source's top-left corner comes back in
// the pixel array's top-left corner and renders in the canvas's top-left corner, at the exact
// pixel position this formula predicts.

export const imageToScreen = (x, y, viewport, canvasWidth, canvasHeight) => {
  // Identity is the safe fallback for the first frame or two, before the viewport is published.
  if (!viewport || !canvasWidth || !canvasHeight) return {u: x, v: y}

  return {
    u: (viewport.offsetX + x * viewport.width) / canvasWidth,
    v: (viewport.offsetY + y * viewport.height) / canvasHeight,
  }
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

// ------------------------------------------------------------------------------------------
// Metric depth
// ------------------------------------------------------------------------------------------
// The fingertip is a 2D point and has to be pushed out along the camera ray; how far decides
// where the tube actually lands in the room. Rather than scale a hand-tuned constant by apparent
// hand size, solve it properly.
//
// MediaPipe also returns worldLandmarks: the same 21 points in METRES, so the hand's true size is
// known rather than assumed. For a perspective camera, a length L at distance d covers a fraction
// of the screen height  f = P[5] * L / (2d)  (P[5] = 1/tan(fovY/2)), so  d = P[5] * L / (2f).
//
// Using the camera's own projection matrix -- the same one the unprojection uses -- keeps the
// estimate self-consistent, and using the real hand size makes it self-calibrating: it works for
// a large hand and a small one with no constant to tune.

// Rigid pairs, chosen because the distance between them barely changes as fingers move.
const DEPTH_PAIRS = [
  [LM.INDEX_MCP, LM.PINKY_MCP],
  [LM.WRIST, LM.INDEX_MCP],
  [LM.WRIST, LM.PINKY_MCP],
  [LM.WRIST, LM.MIDDLE_MCP],
]

const distance3d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// screenPoints: landmarks already mapped to normalised screen coords.
// widthOverHeight: canvas aspect, to express a horizontal offset in screen-height units.
// projectionP5: camera.projectionMatrix.elements[5].
// Returns metres, or null if the hand geometry was unusable.
export const estimateDepthMeters = (screenPoints, worldLandmarks, widthOverHeight, projectionP5) => {
  // A tilted hand foreshortens, which shrinks the measured fraction and would push the depth
  // estimate too far away. Taking the largest ratio picks whichever pair is closest to
  // fronto-parallel, i.e. the least foreshortened and most trustworthy one.
  let bestRatio = 0

  for (const [a, b] of DEPTH_PAIRS) {
    const trueLength = distance3d(worldLandmarks[a], worldLandmarks[b])
    if (trueLength < 1e-4) continue

    const du = (screenPoints[a].u - screenPoints[b].u) * widthOverHeight
    const dv = screenPoints[a].v - screenPoints[b].v
    const fraction = Math.hypot(du, dv)

    bestRatio = Math.max(bestRatio, fraction / trueLength)
  }

  return bestRatio > 1e-6 ? projectionP5 / (2 * bestRatio) : null
}

// ------------------------------------------------------------------------------------------
// Tracker
// ------------------------------------------------------------------------------------------

// Handing MediaPipe a URL it cannot load does NOT reject: it logs "Unable to open zip archive"
// internally and the promise never settles, so the app hangs on its loading message forever.
// That is worth guarding against wherever we await the library.
const withTimeout = (promise, ms, label) => {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: pas de reponse apres ${ms / 1000}s`)), ms)
    }),
  ])
}

// Fetching the model ourselves, rather than passing a URL, is what makes a missing or broken
// model a clear error instead of a hang -- and it lets us report download progress, which matters
// because the file is ~7.8 MB over mobile data.
const fetchModel = async (url, onProgress) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  // A misconfigured host answers a missing file with its HTML 404 page, which MediaPipe would
  // then try to open as a zip archive and hang on.
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    throw new Error('page HTML recue au lieu du modele (404 ?)')
  }

  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const chunks = []
  let received = 0

  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress?.(received, total)
  }

  const buffer = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }

  if (buffer.byteLength < 1_000_000) {
    throw new Error(`fichier trop petit (${buffer.byteLength} octets)`)
  }
  return buffer
}

// onProgress: ({stage, received, total}) => void, for the loading UI.
export const createHandTracker = async (onProgress) => {
  const report = (stage, received = 0, total = 0) => onProgress?.({stage, received, total})

  report('wasm')
  const fileset = await withTimeout(
    FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`),
    30000,
    'runtime WASM'
  )

  // Prefer the self-hosted copy; fall back to Google's if the build-time download did not happen.
  const modelUrls = [
    `${import.meta.env.BASE_URL}${CONFIG.handModelPathLocal}`,
    CONFIG.handModelUrlRemote,
  ]

  const failures = []
  let modelBuffer = null
  let modelUsed = null

  for (const url of modelUrls) {
    try {
      report('model')
      modelBuffer = await withTimeout(
        fetchModel(url, (received, total) => report('model', received, total)),
        60000,
        `telechargement du modele (${url})`
      )
      modelUsed = url
      break
    } catch (error) {
      failures.push(`modele ${url}: ${error?.message || error}`)
    }
  }

  if (!modelBuffer) {
    throw new Error(`Modele de main introuvable.\n${failures.join('\n')}`)
  }

  report('init')

  // The GPU delegate is much faster but is not available on every iOS build.
  let landmarker = null
  let delegateUsed = null

  for (const delegate of ['GPU', 'CPU']) {
    try {
      landmarker = await withTimeout(
        HandLandmarker.createFromOptions(fileset, {
          // A fresh copy per attempt: MediaPipe may consume the buffer, leaving nothing for the
          // fallback.
          baseOptions: {modelAssetBuffer: modelBuffer.slice(), delegate},
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
        30000,
        `initialisation ${delegate}`
      )
      delegateUsed = delegate
      break
    } catch (error) {
      failures.push(`${delegate}: ${error?.message || error}`)
    }
  }

  if (!landmarker) {
    throw new Error(`Initialisation du suivi de main impossible.\n${failures.join('\n')}`)
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
    // Returns {landmarks, worldLandmarks} for the first detected hand, or null. landmarks are
    // normalised to the image; worldLandmarks are in metres, relative to the hand's centre.
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
      if (!result?.landmarks?.length) return null

      return {
        landmarks: result.landmarks[0],
        worldLandmarks: result.worldLandmarks?.[0] || null,
      }
    },
  }
}
