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
  // Solved metrically from the hand's real size and the camera projection; see estimateDepthMeters
  // in hand-tracking.js. There is no constant to calibrate -- these only bound the result, since a
  // half-detected hand can produce nonsense.
  depthMin: 0.15,
  depthMax: 1.6,
  // Used when auto depth is switched off.
  depthFixed: 0.45,

  // Correction factor on the estimated distance. The depth maths is metric, but in the default
  // 'responsive' scale mode world units are only approximately metres -- they are pinned to an
  // assumed starting camera height. Raise this if tubes land consistently too close, lower it if
  // they land too far.
  depthScale: 1.0,

  // Freeze the distance for the duration of a stroke, fixing it at the moment the pinch closes.
  // The depth estimate is the least certain part of the placement, and letting it wander mid
  // stroke bends the tube towards and away from the camera as the hand rotates -- which reads as
  // wobble even when the hand moved cleanly. The cost is that a stroke cannot be pushed away or
  // pulled closer while drawing; release and pinch again to draw at a new distance.
  lockDepthDuringStroke: true,

  // --- Touch drawing --------------------------------------------------------------------------
  // Press and hold in the middle of the screen and the phone becomes the brush: the drawing point
  // sits a fixed distance straight ahead of the lens, so moving the phone is what draws. Same
  // result as pinching in front of the camera, without needing the hand to be tracked -- it works
  // even if hand tracking never loaded.
  touchDrawDepth: 0.30,
  // Radius of the press zone, as a fraction of the screen's shorter side. Kept well away from the
  // controls so a press never means two things at once.
  touchZoneRadius: 0.22,
  // Hold time before drawing starts. Long enough that a stray tap does not leave a mark.
  longPressMs: 350,

  // --- Smoothing ------------------------------------------------------------------------------
  // One Euro filter, applied to the MEASUREMENT (fingertip position on screen, and depth) rather
  // than to the resulting world position. Filtering the world position would fight SLAM: holding
  // the hand still while turning the phone must leave the point where it is, and the camera pose
  // is exact, so only the noisy hand measurement should be smoothed.
  //
  // minCutoff sets how still a still hand looks; raise it if drawing feels laggy. beta sets how
  // quickly the filter gets out of the way when the hand moves; raise it if fast strokes lag.
  filterScreen: {minCutoff: 1.0, beta: 0.8, derivativeCutoff: 1.0},
  filterDepth: {minCutoff: 0.7, beta: 0.5, derivativeCutoff: 1.0},

  // --- Drawing --------------------------------------------------------------------------------
  // Minimum distance in metres between two recorded points. Stops thousands of duplicate points
  // piling up when the hand is held still.
  minSegmentLength: 0.015,

  // Hard cap on points per stroke, so geometry rebuilds stay cheap.
  maxPointsPerStroke: 400,

  // 3.6 cm radius, a ~7 cm thick tube.
  tubeRadius: 0.036,
  // At 3.6 cm a hexagonal cross-section is visibly faceted against a real scene; 12 reads round.
  tubeRadialSegments: 12,
  // Tube length subdivisions per recorded point. More segments let the curve actually bend
  // instead of being chorded across.
  tubeSegmentsPerPoint: 4,
  // Ceiling on total length subdivisions, so a long stroke cannot run away.
  tubeMaxSegments: 1500,

  // Laplacian smoothing of the centreline before the tube is swept along it. Each pass moves every
  // interior point a fraction `lambda` towards the midpoint of its neighbours. More passes means a
  // rounder path but also a shorter one, as corners get cut.
  smoothingPasses: 4,
  smoothingLambda: 0.5,

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
