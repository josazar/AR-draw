// Every tunable in one place. These are the knobs worth touching first when the feel is off on a
// real device.

export const CONFIG = {
  // --- Hand detection -------------------------------------------------------------------------
  // Downscaled camera frame fed to MediaPipe. The detector rescales to 192x192 internally, so
  // going much above this buys accuracy only for small/distant hands, while every extra pixel is
  // paid twice: once in the engine's readPixels off the GPU, once in inference.
  cameraMaxDimension: 256,

  // Run detection on 1 frame out of N. 0 = adapt automatically from measured inference time,
  // which is the sane default across a fast iPhone and a slow one. Set 1/2/3 to pin it.
  detectEveryNFrames: 0,

  // Inference-time targets for the automatic stride, in milliseconds. Above the first, detection
  // drops to every other frame; above the second, every third.
  detectBudgetMs: 12,
  detectBudgetHighMs: 24,

  // ~7 MB. scripts/copy-mediapipe-wasm.js downloads it into public/models at build time so it is
  // served from our own origin; the Google URL is only a fallback for when that download failed.
  handModelPathLocal: 'models/hand_landmarker.task',
  handModelUrlRemote:
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',

  // --- Pinch ----------------------------------------------------------------------------------
  // Thumb-tip to index-tip distance, divided by wrist-to-middle-knuckle distance, so the value is
  // independent of how far the hand is from the camera. Two thresholds give hysteresis, which
  // stops the stroke flickering on and off right at the boundary.
  pinchCloseRatio: 0.38,
  pinchOpenRatio: 0.55,

  // A pinch must be held/released for this many consecutive detections before it counts. Filters
  // out single-frame detection glitches.
  pinchDebounceFrames: 2,

  // --- Depth ----------------------------------------------------------------------------------
  // The fingertip is a 2D point; it has to be pushed out to some distance along the camera ray.
  // In auto mode the apparent width of the knuckles estimates that distance: a hand that looks
  // small is far away. depth = depthCalibration / normalisedKnuckleSpan.
  depthCalibration: 0.052,
  depthMin: 0.18,
  depthMax: 1.4,
  // Used when auto depth is switched off.
  depthFixed: 0.45,
  // Exponential smoothing on the depth estimate. Lower = smoother but laggier.
  depthSmoothing: 0.25,

  // --- Drawing --------------------------------------------------------------------------------
  // Exponential smoothing on the fingertip position. MediaPipe output is noisy; without this the
  // tube looks like barbed wire.
  positionSmoothing: 0.45,

  // Minimum distance in metres between two recorded points. Stops thousands of duplicate points
  // piling up when the hand is held still.
  minSegmentLength: 0.008,

  // Hard cap on points per stroke, so geometry rebuilds stay cheap.
  maxPointsPerStroke: 400,

  tubeRadius: 0.012,
  // 6 sides is indistinguishable from 8 at this radius on a phone screen, and costs 25% less.
  tubeRadialSegments: 6,
  // Tube length subdivisions per recorded point.
  tubeSegmentsPerPoint: 2,

  // The whole tube mesh is rebuilt whenever a point is added, which is the single most expensive
  // thing the app does while drawing. Throttling to ~16 rebuilds a second is imperceptible, and
  // the trailing cap still follows the fingertip every frame so the tip never looks frozen.
  rebuildIntervalMs: 60,

  palette: [0xff3b30, 0x34c759, 0x0a84ff, 0xffd60a, 0xff2d95, 0xffffff],
}

// MediaPipe hand landmark indices used throughout.
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  PINKY_MCP: 17,
}

// Bone pairs, for drawing the debug skeleton.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]
