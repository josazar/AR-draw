// Turns a stream of world-space fingertip positions into 3D tubes.
//
// Each stroke is a group holding one TubeGeometry plus two hemispherical caps, so releasing the
// pinch leaves a closed, capped tube rather than an open-ended pipe.

import * as THREE from 'three'
import {CONFIG} from './config'
import {smoothPolyline} from './smoothing'

export const createDrawing = (scene) => {
  const strokes = []
  let current = null
  let colorIndex = 0

  const capGeometry = new THREE.SphereGeometry(
    CONFIG.tubeRadius, CONFIG.tubeRadialSegments, Math.round(CONFIG.tubeRadialSegments / 2)
  )

  // Timestamp of the last geometry rebuild, for throttling.
  let lastRebuild = 0

  const rebuild = (stroke) => {
    const {points} = stroke
    if (points.length < 2) return

    // Smooth the centreline before sweeping. A kinked path does not just look kinked: the tube's
    // frames rotate sharply through a corner, which twists the surface and can pinch it inside
    // out. Always from the raw points, never in place -- see smoothing.js.
    const spine = smoothPolyline(points, CONFIG.smoothingPasses, CONFIG.smoothingLambda)

    // Centripetal parameterisation avoids the overshooting loops that uniform Catmull-Rom
    // produces when points bunch up, which happens whenever the hand slows down.
    const curve = new THREE.CatmullRomCurve3(spine, false, 'centripetal', 0.5)
    const segments = Math.min(
      CONFIG.tubeMaxSegments,
      Math.max(8, spine.length * CONFIG.tubeSegmentsPerPoint)
    )
    const geometry = new THREE.TubeGeometry(
      curve, segments, CONFIG.tubeRadius, CONFIG.tubeRadialSegments, false
    )

    if (stroke.tube) {
      stroke.tube.geometry.dispose()
      stroke.tube.geometry = geometry
    } else {
      stroke.tube = new THREE.Mesh(geometry, stroke.material)
      stroke.group.add(stroke.tube)
    }

    // Caps sit on the smoothed spine, not the raw points, or they detach from the tube ends.
    stroke.startCap.position.copy(spine[0])
    stroke.endCap.position.copy(spine[spine.length - 1])
  }

  return {
    get isDrawing() {
      return current !== null
    },

    get strokeCount() {
      return strokes.length
    },

    currentColor: () => CONFIG.palette[colorIndex],

    nextColor() {
      colorIndex = (colorIndex + 1) % CONFIG.palette.length
      return CONFIG.palette[colorIndex]
    },

    begin(position) {
      // Lambert rather than Standard: PBR shading is wasted on a plain coloured tube and costs
      // real fill rate on a phone that is already running SLAM and a neural net.
      //
      // DoubleSide matters here. A swept tube can locally invert where the curve turns hard, and
      // the camera routinely ends up inside a 7 cm tube drawn 30 cm away -- both show as looking
      // straight through the surface with the default FrontSide. Drawing back faces costs nothing
      // on geometry this small and removes the whole class of hole.
      const material = new THREE.MeshLambertMaterial({
        color: CONFIG.palette[colorIndex],
        side: THREE.DoubleSide,
      })
      const group = new THREE.Group()
      const startCap = new THREE.Mesh(capGeometry, material)
      const endCap = new THREE.Mesh(capGeometry, material)
      startCap.position.copy(position)
      endCap.position.copy(position)
      group.add(startCap, endCap)
      scene.add(group)

      current = {group, material, startCap, endCap, tube: null, points: [position.clone()]}
    },

    // Returns true when the point was far enough from the previous one to be recorded.
    extend(position) {
      if (!current) return false

      const {points} = current
      const last = points[points.length - 1]
      if (position.distanceTo(last) < CONFIG.minSegmentLength) {
        // Still let the leading cap track the fingertip, so the tip does not look frozen.
        current.endCap.position.copy(position)
        return false
      }

      if (points.length >= CONFIG.maxPointsPerStroke) {
        // Stroke is full: close it and immediately start a new one from here, so drawing keeps
        // going without a visible break.
        this.end()
        this.begin(position)
        return true
      }

      points.push(position.clone())

      // Always move the trailing cap, but only rebuild the tube on a timer.
      current.endCap.position.copy(position)
      const now = performance.now()
      if (now - lastRebuild >= CONFIG.rebuildIntervalMs) {
        rebuild(current)
        lastRebuild = now
      }
      return true
    },

    end() {
      if (!current) return

      // A pinch that never moved leaves a single point and no tube; drop it rather than leaving
      // a stray blob floating in the scene.
      if (current.points.length < 2) {
        scene.remove(current.group)
        current.material.dispose()
      } else {
        // Also catches up on any points added since the last throttled rebuild.
        rebuild(current)
        strokes.push(current)
      }
      current = null
    },

    undo() {
      const stroke = strokes.pop()
      if (!stroke) return
      scene.remove(stroke.group)
      stroke.tube?.geometry.dispose()
      stroke.material.dispose()
    },

    clear() {
      this.end()
      while (strokes.length) this.undo()
    },
  }
}
