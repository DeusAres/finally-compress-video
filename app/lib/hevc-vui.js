// Patch an HEVC hvcC so the SPS carries a VUI with colour description
// (Safari's WebCodecs HEVC encoder emits vui_parameters_present_flag=0).
// Pure ES2020, no dependencies: works in browsers and Node.

// ---- RBSP <-> NAL payload (emulation prevention) ----
function unescapeRbsp(b) {
  const out = [];
  for (let i = 0, z = 0; i < b.length; i++) {
    if (z >= 2 && b[i] === 3) { z = 0; continue; }
    out.push(b[i]);
    z = b[i] === 0 ? z + 1 : 0;
  }
  return Uint8Array.from(out);
}
function escapeRbsp(b) {
  const out = [];
  for (let i = 0, z = 0; i < b.length; i++) {
    if (z >= 2 && b[i] <= 3) { out.push(3); z = 0; }
    out.push(b[i]);
    z = b[i] === 0 ? z + 1 : 0;
  }
  return Uint8Array.from(out);
}

class BitReader {
  constructor(b) { this.b = b; this.pos = 0; }
  u1() {
    const p = this.pos++;
    if ((p >> 3) >= this.b.length) throw new Error('SPS: read past end');
    return (this.b[p >> 3] >> (7 - (p & 7))) & 1;
  }
  u(n) { let v = 0; while (n-- > 0) v = v * 2 + this.u1(); return v; }
  ue() {
    let z = 0;
    while (this.u1() === 0) if (++z > 32) throw new Error('SPS: bad ue');
    return z ? 2 ** z - 1 + this.u(z) : 0;
  }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
  skip(n) { this.pos += n; }
}

class BitWriter {
  constructor() { this.bits = []; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) & 1); }
  copy(src, from, to) { for (let p = from; p < to; p++) this.bits.push((src[p >> 3] >> (7 - (p & 7))) & 1); }
  bytes() {
    this.bits.push(1); // rbsp_stop_one_bit
    while (this.bits.length & 7) this.bits.push(0);
    const out = new Uint8Array(this.bits.length >> 3);
    this.bits.forEach((bit, i) => { out[i >> 3] |= bit << (7 - (i & 7)); });
    return out;
  }
}

// ---- SPS parsing (H.265 7.3.2.2) ----
function parsePtl(r, maxSub) {
  const ptl = { profileSpace: r.u(2), tier: r.u(1), profileIdc: r.u(5) };
  r.skip(32 + 4 + 43 + 1); // compat flags, source flags, reserved/constraint bits
  ptl.levelIdc = r.u(8);
  const prof = [], lvl = [];
  for (let i = 0; i < maxSub; i++) { prof.push(r.u1()); lvl.push(r.u1()); }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSub; i++) {
    if (prof[i]) r.skip(88);
    if (lvl[i]) r.skip(8);
  }
  return ptl;
}

function skipScalingListData(r) {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let m = 0; m < 6; m += sizeId === 3 ? 3 : 1) {
      if (!r.u1()) r.ue(); // scaling_list_pred_matrix_id_delta
      else {
        const n = Math.min(64, 1 << (4 + (sizeId << 1)));
        if (sizeId > 1) r.se(); // dc_coef_minus8
        for (let i = 0; i < n; i++) r.se();
      }
    }
  }
}

// Returns the RPS as {s0, s1} arrays of delta POCs (NumDeltaPocs = s0.length + s1.length).
function parseStRps(r, idx, sets) {
  const inter = idx !== 0 ? r.u1() : 0;
  const s0 = [], s1 = [];
  if (inter) {
    const sign = r.u1(), dRps = (1 - 2 * sign) * (r.ue() + 1);
    const ref = sets[idx - 1], n0 = ref.s0.length, n = n0 + ref.s1.length;
    const useDelta = [];
    for (let j = 0; j <= n; j++) {
      const used = r.u1();
      useDelta.push(used ? 1 : r.u1());
    }
    for (let j = ref.s1.length - 1; j >= 0; j--) {
      const d = ref.s1[j] + dRps;
      if (d < 0 && useDelta[n0 + j]) s0.push(d);
    }
    if (dRps < 0 && useDelta[n]) s0.push(dRps);
    for (let j = 0; j < n0; j++) {
      const d = ref.s0[j] + dRps;
      if (d < 0 && useDelta[j]) s0.push(d);
    }
    for (let j = n0 - 1; j >= 0; j--) {
      const d = ref.s0[j] + dRps;
      if (d > 0 && useDelta[j]) s1.push(d);
    }
    if (dRps > 0 && useDelta[n]) s1.push(dRps);
    for (let j = 0; j < ref.s1.length; j++) {
      const d = ref.s1[j] + dRps;
      if (d > 0 && useDelta[n0 + j]) s1.push(d);
    }
  } else {
    const nn = r.ue(), np = r.ue();
    let p = 0;
    for (let i = 0; i < nn; i++) { p -= r.ue() + 1; r.u1(); s0.push(p); }
    p = 0;
    for (let i = 0; i < np; i++) { p += r.ue() + 1; r.u1(); s1.push(p); }
  }
  return { s0, s1 };
}

// Parse the leading part of the VUI, up to and including colour description.
function parseVuiHead(r) {
  const v = { videoSignalTypePresent: 0, colourDescPresent: 0 };
  if (r.u1()) { if (r.u(8) === 255) r.skip(32); } // aspect_ratio_info
  if (r.u1()) r.skip(1);                          // overscan
  if (r.u1()) { // video_signal_type_present_flag
    v.videoSignalTypePresent = 1;
    v.videoFormat = r.u(3);
    v.fullRange = r.u1();
    v.colourFlagPos = r.pos;
    if (r.u1()) {
      v.colourDescPresent = 1;
      v.colourPos = r.pos; // bit position of colour_primaries
      v.primaries = r.u(8); v.transfer = r.u(8); v.matrix = r.u(8);
    }
  }
  return v;
}

/** Parse an SPS NAL (with 2-byte header). */
export function parseSps(nal) {
  if (((nal[0] >> 1) & 0x3f) !== 33) throw new Error('not an SPS NAL');
  const rbsp = unescapeRbsp(nal.subarray(2));
  const r = new BitReader(rbsp);
  const s = { rbsp };
  s.vpsId = r.u(4);
  s.maxSubLayersMinus1 = r.u(3);
  s.temporalIdNesting = r.u1();
  s.ptl = parsePtl(r, s.maxSubLayersMinus1);
  s.spsId = r.ue();
  s.chromaFormatIdc = r.ue();
  if (s.chromaFormatIdc === 3) s.separateColourPlane = r.u1();
  s.width = r.ue(); s.height = r.ue();
  s.codedWidth = s.width; s.codedHeight = s.height;
  s.confWin = null;
  if (r.u1()) {
    s.confWin = { left: r.ue(), right: r.ue(), top: r.ue(), bottom: r.ue() };
    const sw = s.chromaFormatIdc === 1 || s.chromaFormatIdc === 2 ? 2 : 1;
    const sh = s.chromaFormatIdc === 1 ? 2 : 1;
    s.displayWidth = s.width - sw * (s.confWin.left + s.confWin.right);
    s.displayHeight = s.height - sh * (s.confWin.top + s.confWin.bottom);
  } else { s.displayWidth = s.width; s.displayHeight = s.height; }
  s.bitDepthLuma = r.ue() + 8;
  s.bitDepthChroma = r.ue() + 8;
  s.log2MaxPocLsb = r.ue() + 4;
  const subInfo = r.u1();
  s.subLayerOrdering = [];
  for (let i = subInfo ? 0 : s.maxSubLayersMinus1; i <= s.maxSubLayersMinus1; i++)
    s.subLayerOrdering.push([r.ue(), r.ue(), r.ue()]);
  s.log2MinCb = r.ue() + 3; s.log2DiffCb = r.ue();
  s.log2MinTb = r.ue() + 2; s.log2DiffTb = r.ue();
  s.maxTHDepthInter = r.ue(); s.maxTHDepthIntra = r.ue();
  s.scalingListEnabled = r.u1();
  s.scalingListDataPresent = 0;
  if (s.scalingListEnabled) {
    s.scalingListDataPresent = r.u1();
    if (s.scalingListDataPresent) skipScalingListData(r);
  }
  s.amp = r.u1();
  s.sao = r.u1();
  s.pcm = r.u1();
  if (s.pcm) {
    s.pcmBitDepthLuma = r.u(4) + 1; s.pcmBitDepthChroma = r.u(4) + 1;
    s.log2MinPcm = r.ue() + 3; s.log2DiffPcm = r.ue();
    s.pcmLoopFilterDisabled = r.u1();
  }
  s.numStRps = r.ue();
  const sets = [];
  for (let i = 0; i < s.numStRps; i++) sets.push(parseStRps(r, i, sets));
  s.stRps = sets;
  s.longTermRefPicsPresent = r.u1();
  s.numLongTermRefPicsSps = 0;
  if (s.longTermRefPicsPresent) {
    s.numLongTermRefPicsSps = r.ue();
    for (let i = 0; i < s.numLongTermRefPicsSps; i++) { r.skip(s.log2MaxPocLsb); r.u1(); }
  }
  s.temporalMvp = r.u1();
  s.strongIntraSmoothing = r.u1();
  s.vuiFlagPos = r.pos; // bit position of vui_parameters_present_flag in the RBSP
  s.vui = r.u1();
  s.vuiFields = s.vui ? parseVuiHead(r) : null;
  return s;
}

// ---- SPS rewriting ----
function patchSps(nal, o) {
  const s = parseSps(nal);
  const hdr = nal.subarray(0, 2);
  let rbsp;
  let end = s.rbsp.length; // locate rbsp_stop_one_bit (last 1 bit)
  while (end > 0 && s.rbsp[end - 1] === 0) end--;
  if (!end) throw new Error('SPS: no trailing bits');
  let endBit = end * 8 - 1;
  while (((s.rbsp[endBit >> 3] >> (7 - (endBit & 7))) & 1) === 0) endBit--;
  const colour = (w) => { w.u(8, o.primaries); w.u(8, o.transfer); w.u(8, o.matrix); };
  if (!s.vui) {
    const w = new BitWriter();
    w.copy(s.rbsp, 0, s.vuiFlagPos);
    w.u(1, 1);              // vui_parameters_present_flag
    w.u(1, 0);              // aspect_ratio_info_present_flag
    w.u(1, 0);              // overscan_info_present_flag
    w.u(1, 1);              // video_signal_type_present_flag
    w.u(3, o.videoFormat); w.u(1, o.fullRange ? 1 : 0);
    w.u(1, 1);              // colour_description_present_flag
    colour(w);
    w.u(7, 0);              // chroma_loc, neutral_chroma, field_seq, frame_field_info, default_display_window, timing_info, bitstream_restriction
    w.copy(s.rbsp, s.vuiFlagPos + 1, endBit); // remaining original bits (sps_extension...)
    rbsp = w.bytes();
  } else if (s.vuiFields.colourDescPresent) {
    // Same-length overwrite of the colour fields (full_range/format are before colourPos).
    rbsp = Uint8Array.from(s.rbsp);
    const w = new BitWriter();
    colour(w);
    w.bits.forEach((bit, i) => {
      const p = s.vuiFields.colourPos + i, m = 1 << (7 - (p & 7));
      rbsp[p >> 3] = bit ? rbsp[p >> 3] | m : rbsp[p >> 3] & ~m;
    });
  } else if (s.vuiFields.videoSignalTypePresent) {
    // Flip colour_description_present_flag to 1 and insert the three fields.
    const f = s.vuiFields, w = new BitWriter();
    w.copy(s.rbsp, 0, f.colourFlagPos);
    w.u(1, 1); colour(w);
    w.copy(s.rbsp, f.colourFlagPos + 1, endBit);
    rbsp = w.bytes();
  } else {
    console.warn('hevc-vui: SPS already has a VUI without video_signal_type; left unchanged');
    return nal;
  }
  const esc = escapeRbsp(rbsp);
  const out = new Uint8Array(2 + esc.length);
  out.set(hdr); out.set(esc, 2);
  return out;
}

/** Rewrite the SPS inside an hvcC adding a colour VUI; everything else is copied. */
export function patchHvcC(hvcC, opts = {}) {
  const o = { primaries: 9, transfer: 18, matrix: 9, fullRange: false, videoFormat: 5, ...opts };
  if (hvcC[0] !== 1 || hvcC.length < 23) throw new Error('invalid hvcC');
  const dv = new DataView(hvcC.buffer, hvcC.byteOffset, hvcC.byteLength);
  const parts = [hvcC.subarray(0, 23)];
  let off = 23;
  for (let a = 0; a < hvcC[22]; a++) {
    const type = hvcC[off] & 0x3f, count = dv.getUint16(off + 1);
    const head = Uint8Array.from(hvcC.subarray(off, off + 3));
    off += 3;
    const nals = [];
    for (let n = 0; n < count; n++) {
      const len = dv.getUint16(off);
      let nal = hvcC.subarray(off + 2, off + 2 + len);
      off += 2 + len;
      if (type === 33) nal = patchSps(nal, o);
      nals.push(nal);
    }
    parts.push(head);
    for (const nal of nals) { parts.push(Uint8Array.of(nal.length >> 8, nal.length & 255), nal); }
  }
  if (off < hvcC.length) parts.push(hvcC.subarray(off)); // trailing bytes, if any
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

/** Remove in-band VPS/SPS/PPS (types 32-34) from a length-prefixed sample. */
export function stripParameterSets(sample, nalLengthSize = 4) {
  const dv = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
  const keep = [];
  let removed = false;
  for (let off = 0; off + nalLengthSize <= sample.length;) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = len * 256 + dv.getUint8(off + i);
    const end = off + nalLengthSize + len;
    if (end > sample.length) throw new Error('truncated NAL in sample');
    const type = (sample[off + nalLengthSize] >> 1) & 0x3f;
    if (type >= 32 && type <= 34) removed = true;
    else keep.push(sample.subarray(off, end));
    off = end;
  }
  if (!removed) return sample;
  const out = new Uint8Array(keep.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const k of keep) { out.set(k, p); p += k.length; }
  return out;
}
