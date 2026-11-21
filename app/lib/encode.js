// HEVC encoder wrapper (Safari 27 WebCodecs → libwebrtc RTCVideoEncoderH265, VT realtime).
// Measured facts (research/02 §10): Main10 is chosen from the native frame (codec string ignored);
// keyFrame per-frame honoured; configure() with only bitrate changes rate without a keyframe;
// chunk.duration is always 0 → we keep durations ourselves; bitrateMode 'quantizer' unsupported.

// framerate: frame rate MEDIO reale della sorgente (frame/durata dal demux, 2 decimali; per VFR la media), non più 60 fisso.
// width/height: dimensioni CONFIGURATE; se i frame passati sono più grandi («Riduci a 1080p») deve scalarli l'encoder (WebCodecs).
export function createHevcEncoder({ width, height, bitrate, framerate = 60, onChunk, onError, log }) {
  let decoderConfig = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
      onChunk(chunk, meta);
    },
    error: (e) => onError(e),
  });
  const cfg = { codec: 'hvc1.2.4.L123.B0', width, height, bitrate, framerate, latencyMode: 'quality', bitrateMode: 'variable' };
  log?.(`encoder: framerate ${framerate} fps`);
  enc.configure(cfg);
  return {
    get decoderConfig() { return decoderConfig; },
    get queue() { return enc.encodeQueueSize; },
    encode(frame, keyFrame) { enc.encode(frame, { keyFrame }); },
    setBitrate(b) { cfg.bitrate = b; enc.configure(cfg); },
    async drain(max = 4) { // backpressure (research/03: encodeQueue ≤ 4)
      while (enc.encodeQueueSize > max) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    },
    flush: () => enc.flush(),
    close: () => { try { enc.close(); } catch {} },
  };
}
