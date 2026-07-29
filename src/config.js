// Every tunable in one place. These are the knobs worth touching first when the feel is off on a
// real device.

export const CONFIG = {
  // --- Hand detection -------------------------------------------------------------------------
  // Downscaled camera frame fed to MediaPipe. 320px is a good speed/accuracy trade-off on an
  // iPhone; raising it costs frame rate fast.
  cameraMaxDimension: 320,

  // Run detection on 1 frame out of N. 1 = every frame. Raise to 2 if the frame rate suffers.
  detectEveryNFrames: 1,

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
  tubeRadialSegments: 8,
  // Tube length subdivisions per recorded point.
  tubeSegmentsPerPoint: 3,

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
