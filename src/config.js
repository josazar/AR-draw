// Every tunable in one place. These are the knobs worth touching first when the feel is off on a
// real device.

export const CONFIG = {
  // --- Drawing trigger --------------------------------------------------------------------------
  // Press and hold in the middle of the screen and the phone becomes the brush: the drawing point
  // sits a fixed distance straight ahead of the lens, so moving the phone is what draws.
  //
  // Hand tracking used to be the other trigger and was removed. MediaPipe read ordinary room
  // geometry as a hand often enough that filming a room would start drawing on its own, and a
  // gesture that fires when you did not gesture is worse than no gesture at all. Dropping it also
  // removed a 7.8 MB model download, a neural net per frame, and the synchronous GPU readback that
  // fed it.

  // Radius of the press zone, as a fraction of the screen's shorter side. Kept well away from the
  // controls so a press never means two things at once.
  touchZoneRadius: 0.22,
  // Hold time before drawing starts. Long enough that a stray tap does not leave a mark.
  longPressMs: 350,

  // --- Depth ------------------------------------------------------------------------------------
  // How far ahead of the lens the brush sits, in metres, driven by the slider.
  drawDepth: 0.30,
  drawDepthMin: 0.15,
  drawDepthMax: 2.5,

  // --- Tracking robustness ----------------------------------------------------------------------
  // Points recorded while SLAM is not tracking properly are placed against a pose that is about to
  // be corrected, so they land in the wrong place. Rather than draw them anyway, a stroke pauses
  // and resumes where it left off.
  pauseDrawingWhenTrackingDegraded: true,

  // Relocalisation moves the world frame under the drawing: come back to a spot and the tubes are
  // somewhere else. That shows up as a single-frame discontinuity in the camera pose, which is
  // distinguishable from real motion because real motion is continuous. A frame is treated as a
  // jump when its pose delta is both absolutely large and far out of line with recent frames.
  compensateTrackingJumps: true,
  jumpMinMetres: 0.03,
  jumpRelativeToMedian: 5,
  // Frames of delta history used for the median. Roughly half a second.
  jumpHistoryFrames: 15,

  // --- Smoothing --------------------------------------------------------------------------------
  // One Euro filter on the brush's world position. In this mode the brush is rigidly attached to
  // the camera, so its world position is the camera pose -- and SLAM pose noise lands directly in
  // the drawing. Filtering it is therefore filtering the noisy measurement, not fighting the
  // tracker. Raise minCutoff if drawing feels laggy, raise beta if fast sweeps lag.
  filterWorld: {minCutoff: 1.2, beta: 1.0, derivativeCutoff: 1.0},

  // --- Drawing ------------------------------------------------------------------------------
  // Minimum distance in metres between two recorded points. Stops thousands of duplicate points
  // piling up when the phone is held still.
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
  // the trailing cap still follows the brush every frame so the tip never looks frozen.
  rebuildIntervalMs: 60,

  palette: [0xff3b30, 0x34c759, 0x0a84ff, 0xffd60a, 0xff2d95, 0xffffff],
}
