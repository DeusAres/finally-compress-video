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

/**
 * Controllo con TARGET PER SEGMENTO (v0.28, «qualità per scena»: target = bitrate scelto dalle prove; a bitrate fisso target costante).
 * Stato = rapporto configurato/target, cioè quanto l'encoder VT sotto- o sovra-produce al ritmo di alimentazione attuale: resta valido
 * da un segmento all'altro. All'inizio del segmento s si configura ratio × target(s) (prima del keyframe); dopo ogni finestra misurata
 * sul segmento m il rapporto si aggiorna con nextBitrate verso target(m) e si riapplica al segmento in ingresso `cur` (i pacchetti
 * arrivano qualche frame dopo l'ingresso). Con target costante è identico al controllo v0.27 (nextBitrate sul configurato).
 */
// holdBelow (solo «qualità per scena»): una finestra con reale < holdBelow × target è limitata dal CONTENUTO (scena statica: l'encoder non
// spende i bit), non dal ritmo di alimentazione → il rapporto non si aggiorna, altrimenti salirebbe a 2.5× e il segmento successivo
// (magari difficile, target alto) partirebbe molto sopra il suo target. A bitrate fisso holdBelow = 0 (comportamento v0.27).
export function createSegmentRate(targetOf, ratio0 = 1, { holdBelow = 0 } = {}) {
  let ratio = clamp(Number.isFinite(ratio0) && ratio0 > 0 ? ratio0 : 1, BR_ABS[0], BR_ABS[1]);
  return {
    get ratio() { return ratio; },
    configured: (s) => ratio * targetOf(s),
    update(m, real, cur = m) { const T = targetOf(m); if (!(real < holdBelow * T)) ratio = nextBitrate(ratio * T, real, T) / T; return ratio * targetOf(cur); },
  };
}
