// Laplacian smoothing of a polyline.
//
// The recorded points are the fingertip's path, and even after the One Euro filter they carry
// small kinks. A tube swept along a kinked centreline looks bad for two reasons: the kink itself
// is visible, and TubeGeometry's frames rotate sharply through it, which twists the surface and
// can pinch it inside out.
//
// The standard fix is Laplacian smoothing: repeatedly move each interior point a fraction of the
// way towards the midpoint of its neighbours. It is the polyline case of the mesh smoothing used
// everywhere in geometry processing.
//
//   p[i] += lambda * ((p[i-1] + p[i+1]) / 2 - p[i])
//
// Endpoints are pinned, so a stroke still starts and ends exactly where the finger did.
//
// Always smooth FROM the raw points into a separate array. Smoothing in place would re-smooth an
// already-smoothed path on every rebuild, and the stroke would slowly collapse towards a straight
// line while being drawn.

import * as THREE from 'three'

// Scratch buffers, reused across rebuilds to avoid allocating per frame.
let bufferA = []
let bufferB = []

const ensureCapacity = (buffer, count) => {
  while (buffer.length < count) buffer.push(new THREE.Vector3())
  return buffer
}

// points: Vector3[] (not modified). Returns an array of length points.length, valid until the
// next call -- copy it if you need to keep it.
export const smoothPolyline = (points, passes, lambda) => {
  const count = points.length
  ensureCapacity(bufferA, count)
  ensureCapacity(bufferB, count)

  let source = bufferA
  let target = bufferB
  for (let i = 0; i < count; i++) source[i].copy(points[i])

  if (count < 3 || passes <= 0) return source.slice(0, count)

  for (let pass = 0; pass < passes; pass++) {
    target[0].copy(source[0])
    target[count - 1].copy(source[count - 1])

    for (let i = 1; i < count - 1; i++) {
      const previous = source[i - 1]
      const next = source[i + 1]
      const current = source[i]
      target[i].set(
        current.x + lambda * ((previous.x + next.x) * 0.5 - current.x),
        current.y + lambda * ((previous.y + next.y) * 0.5 - current.y),
        current.z + lambda * ((previous.z + next.z) * 0.5 - current.z)
      )
    }

    const swap = source
    source = target
    target = swap
  }

  return source.slice(0, count)
}
