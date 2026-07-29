// Turns a stream of world-space fingertip positions into 3D tubes.
//
// Each stroke is a group holding one TubeGeometry plus two hemispherical caps, so releasing the
// pinch leaves a closed, capped tube rather than an open-ended pipe.

import * as THREE from 'three'
import {CONFIG} from './config'

export const createDrawing = (scene) => {
  const strokes = []
  let current = null
  let colorIndex = 0

  const capGeometry = new THREE.SphereGeometry(CONFIG.tubeRadius, CONFIG.tubeRadialSegments, 8)

  const rebuild = (stroke) => {
    const {points} = stroke
    if (points.length < 2) return

    // Centripetal parameterisation avoids the overshooting loops that uniform Catmull-Rom
    // produces when points bunch up, which happens whenever the hand slows down.
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5)
    const segments = Math.min(
      1200,
      Math.max(8, points.length * CONFIG.tubeSegmentsPerPoint)
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

    stroke.startCap.position.copy(points[0])
    stroke.endCap.position.copy(points[points.length - 1])
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
      const material = new THREE.MeshStandardMaterial({
        color: CONFIG.palette[colorIndex],
        roughness: 0.35,
        metalness: 0.05,
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
      rebuild(current)
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
