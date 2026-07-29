// Generates a .y4m clip that Chromium can present as a webcam, via
// --use-file-for-fake-video-capture. y4m is uncompressed: a short text header, then FRAME plus
// raw I420 planes per frame. No ffmpeg needed.
//
//   node test/make-fake-camera.mjs out.y4m
//
// To test hand tracking for real you want footage of an actual hand instead. Record a clip of
// yourself pinching, then convert it (note y4m is uncompressed -- keep it short):
//
//   ffmpeg -i hand.mov -t 10 -s 640x480 -pix_fmt yuv420p hand.y4m
import {createWriteStream} from 'node:fs'

const W = 640
const H = 480
const FPS = 15
const SECONDS = Number(process.env.SECONDS || 8)
const path = process.argv[2]

if (!path) {
  console.error('usage: node test/make-fake-camera.mjs <out.y4m>')
  process.exit(1)
}

const out = createWriteStream(path)
out.write(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420\n`)

const y = Buffer.alloc(W * H)
const u = Buffer.alloc((W / 2) * (H / 2))
const v = Buffer.alloc((W / 2) * (H / 2))
u.fill(128)
v.fill(128)

// A drifting checkerboard. SLAM needs corners to lock onto -- a flat colour gives it nothing, so
// this stands in for a camera panning across a textured surface.
for (let f = 0; f < FPS * SECONDS; f++) {
  const shift = Math.round(f * 1.5)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const cx = Math.floor((i + shift) / 24)
      const cy = Math.floor((j + Math.round(shift * 0.3)) / 24)
      const base = (cx + cy) % 2 ? 210 : 40
      // A fine gradient on top, so every corner is locally unambiguous.
      y[j * W + i] = Math.min(255, Math.max(0, base + ((i * 7 + j * 3) % 24) - 12))
    }
  }
  out.write('FRAME\n')
  out.write(y)
  out.write(u)
  out.write(v)
}

out.end(() => console.log(`wrote ${path} (${FPS * SECONDS} frames, ${W}x${H})`))
