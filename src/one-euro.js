// One Euro filter.
//
// A plain exponential average forces a bad trade: smooth enough to kill MediaPipe's jitter means
// visibly laggy when the hand moves fast. This filter varies its cutoff with speed -- heavy
// smoothing when the hand is nearly still (where jitter is what you see), almost none when it is
// moving (where lag is what you feel). That is exactly the drawing case.
//
// Casiez, Roussel & Vogel, CHI 2012.

const alpha = (cutoffHz, dtSeconds) => {
  const tau = 1 / (2 * Math.PI * cutoffHz)
  return 1 / (1 + tau / dtSeconds)
}

export const createOneEuroFilter = ({minCutoff, beta, derivativeCutoff}) => {
  let value = null
  let derivative = 0
  let lastMs = 0

  return {
    reset() {
      value = null
      derivative = 0
    },

    filter(x, nowMs) {
      if (value === null) {
        value = x
        derivative = 0
        lastMs = nowMs
        return x
      }

      // Clamp dt: a stalled frame would otherwise produce a huge velocity and blow the cutoff
      // wide open, letting a spike straight through.
      const dt = Math.min(Math.max((nowMs - lastMs) / 1000, 1 / 240), 1 / 5)
      lastMs = nowMs

      const rawDerivative = (x - value) / dt
      derivative += alpha(derivativeCutoff, dt) * (rawDerivative - derivative)

      const cutoff = minCutoff + beta * Math.abs(derivative)
      value += alpha(cutoff, dt) * (x - value)
      return value
    },
  }
}
