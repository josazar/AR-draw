// Prepares the MediaPipe assets under public/ so they are served from our own origin.
//
// Two reasons not to load these from a CDN at runtime:
//  - the WASM version and the bundled JS version can drift apart, which fails at runtime with
//    confusing errors;
//  - the hand model is ~7 MB, and a phone on a flaky connection would simply get no hand
//    tracking at all if the CDN is unreachable.
//
// The model download is best-effort: if it fails the build still succeeds and the app falls back
// to fetching the model from Google at runtime.
import {cpSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(here, '../public')

// --- WASM runtime ---------------------------------------------------------------------------
const wasmSrc = resolve(here, '../node_modules/@mediapipe/tasks-vision/wasm')
const wasmDest = resolve(publicDir, 'mediapipe-wasm')
mkdirSync(wasmDest, {recursive: true})
cpSync(wasmSrc, wasmDest, {recursive: true})
console.log(`[assets] wasm -> ${wasmDest}`)

// --- Hand landmark model --------------------------------------------------------------------
export const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const modelDir = resolve(publicDir, 'models')
const modelPath = resolve(modelDir, 'hand_landmarker.task')

if (existsSync(modelPath) && statSync(modelPath).size > 1_000_000) {
  console.log(`[assets] model already present (${statSync(modelPath).size} bytes)`)
} else {
  mkdirSync(modelDir, {recursive: true})
  try {
    const response = await fetch(MODEL_URL)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength < 1_000_000) throw new Error(`suspiciously small: ${bytes.byteLength} bytes`)

    // Write then rename, so an interrupted build never leaves a truncated model behind.
    const tmp = `${modelPath}.partial`
    writeFileSync(tmp, bytes)
    renameSync(tmp, modelPath)
    console.log(`[assets] model -> ${modelPath} (${bytes.byteLength} bytes)`)
  } catch (error) {
    console.warn(
      `[assets] could not download the hand model (${error.message}). ` +
      'The build will continue; the app will fall back to loading it from Google at runtime.'
    )
  }
}
