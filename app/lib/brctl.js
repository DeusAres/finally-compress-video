// Closed-loop bitrate correction. The VideoToolbox realtime rate control follows wall-clock time, not timestamps:
// fed faster than real time it produces LESS than the configured bitrate (measured: ×0.89 at ~100 fps, ×0.66 at ~178 fps).
// After each measurement window we scale the configured bitrate so the REAL bitrate converges on the target.
export const BR_STEP = [0.7, 1.5], BR_ABS = [0.5, 2.5], BR_GAIN = 0.8, BR_WINDOW = 120, BR_MIN_FRAMES = 30;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Real bitrate (bps) of a window: bytes × 8 / sum of frame durations (media time, not wall clock). */
export const realBitrate = (bytes, durS) => (durS > 0 ? bytes * 8 / durS : 0);

/** Next configured bitrate (bps): proportional damped control, step ∈ [0.7,1.5], absolute ∈ [0.5,2.5]×target. */
export function nextBitrate(configured, real, target) {
  if (!(real > 0) || !(configured > 0) || !(target > 0)) return configured > 0 ? configured : target;
  return clamp(configured * clamp(Math.pow(target / real, BR_GAIN), BR_STEP[0], BR_STEP[1]), target * BR_ABS[0], target * BR_ABS[1]);
}
