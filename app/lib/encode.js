// HEVC encoder wrapper (Safari 27 WebCodecs → libwebrtc RTCVideoEncoderH265, VT realtime).
// Measured facts (research/02 §10): Main10 is chosen from the native frame (codec string ignored);
// keyFrame per-frame honoured; configure() with only bitrate changes rate without a keyframe;
// chunk.duration is always 0 → we keep durations ourselves; bitrateMode 'quantizer' unsupported.

export function createHevcEncoder({ width, height, bitrate, onChunk, onError }) {
  let decoderConfig = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig;
      onChunk(chunk, meta);
    },
    error: (e) => onError(e),
  });
  const cfg = { codec: 'hvc1.2.4.L123.B0', width, height, bitrate, framerate: 60, latencyMode: 'quality', bitrateMode: 'variable' };
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
