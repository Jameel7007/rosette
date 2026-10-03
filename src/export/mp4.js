// A fix-up of the finished MP4: the AAC "roll" sample group Apple's players need to time the
// sound correctly. Pure byte work (no DOM), so the tests run it in Node.
//
// Why: an AAC encoder starts its output with 2112 samples of "priming" (export/plan.js AUDIO).
// The export cancels them the standard way, with an edit list that starts the track 2112
// samples in. ffmpeg, Chrome and Firefox honour that and play in sync. Apple's AVFoundation
// (Safari, QuickTime, iOS Photos) played the sound 44 ms (= 2112 samples) EARLY: it trimmed the
// priming a second time. Measured with AVAssetReader on an export: the first click at 0.67269 s
// against its frame at 0.71667 s. Files from Apple's own encoder and from ffmpeg also carry a
// sample group of type 'roll' (each AAC packet needs the one before it to decode: roll distance
// −1), and inserting just that group into an export made AVFoundation read 0.71669 s, in sync,
// with ffmpeg unchanged. mediabunny 1.61 does not write it, so it is added here.
//
// The layout this expects is the one mediabunny's fastStart: 'in-memory' writes: ftyp, moov,
// then mdat. Inserting bytes into moov moves the media data, so every chunk offset (stco/co64)
// is shifted by the same amount.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

/** The boxes inside [start, end): { type, start, size, header } (64-bit sizes understood). */
function boxes(view, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end;) {
    let size = view.getUint32(p), header = 8;
    if (size === 1) { size = Number(view.getBigUint64(p + 8)); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error(`mp4: bad box size at ${p}`);
    const type = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5), view.getUint8(p + 6), view.getUint8(p + 7));
    out.push({ type, start: p, size, header });
    p += size;
  }
  return out;
}
const child = (view, box, type) => boxes(view, box.start + box.header, box.start + box.size).find(b => b.type === type);

/** The two boxes: sgpd (one 'roll' entry, distance −1) and sbgp (every sample in it). */
function rollBoxes(sampleCount) {
  const out = new Uint8Array(26 + 28);
  const v = new DataView(out.buffer);
  const tag = (at, s) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  v.setUint32(0, 26); tag(4, 'sgpd'); v.setUint32(8, 0x01000000);   // version 1, flags 0
  tag(12, 'roll'); v.setUint32(16, 2); v.setUint32(20, 1); v.setInt16(24, -1);   // default length 2, 1 entry, roll −1
  v.setUint32(26, 28); tag(30, 'sbgp'); v.setUint32(34, 0);            // version 0
  tag(38, 'roll'); v.setUint32(42, 1); v.setUint32(46, sampleCount); v.setUint32(50, 1);   // all samples → entry 1
  return out;
}

/**
 * The file as Blob parts with the AAC roll group added to its audio track, or unchanged (one
 * part) when there is no AAC track, the group is already there, or the layout is not ftyp-moov-
 * mdat. Only the moov box is copied: the media data stays a view of `bytes`.
 * @param {Uint8Array} bytes  the finished MP4
 * @returns {Uint8Array[]}
 */
export function withAacRollGroup(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(view, 0, bytes.byteLength);
  const moov = top.find(b => b.type === 'moov'), mdat = top.find(b => b.type === 'mdat');
  if (!moov || !mdat || mdat.start < moov.start) return [bytes];

  // The audio track's sample table, if it holds AAC ('mp4a')
  let path = null;
  for (const trak of boxes(view, moov.start + moov.header, moov.start + moov.size).filter(b => b.type === 'trak')) {
    const mdia = child(view, trak, 'mdia'), hdlr = mdia && child(view, mdia, 'hdlr');
    if (!hdlr || view.getUint32(hdlr.start + hdlr.header + 8) !== 0x736f756e) continue;   // handler 'soun'
    const minf = child(view, mdia, 'minf'), stbl = minf && child(view, minf, 'stbl');
    const stsd = stbl && child(view, stbl, 'stsd'), stsz = stbl && child(view, stbl, 'stsz');
    if (!stsd || !stsz) continue;
    const entry = boxes(view, stsd.start + stsd.header + 8, stsd.start + stsd.size)[0];
    if (entry?.type !== 'mp4a') continue;
    if (child(view, stbl, 'sgpd')) return [bytes];   // already has a sample group: leave it
    path = { boxes: [moov, trak, mdia, minf, stbl], stbl, samples: view.getUint32(stsz.start + stsz.header + 8) };
  }
  if (!path) return [bytes];

  const insert = rollBoxes(path.samples);
  const at = path.stbl.start + path.stbl.size;              // the end of the audio stbl
  const head = new Uint8Array(moov.size + insert.length);   // the new moov
  head.set(bytes.subarray(moov.start, at), 0);
  head.set(insert, at - moov.start);
  head.set(bytes.subarray(at, moov.start + moov.size), at - moov.start + insert.length);
  const hv = new DataView(head.buffer);
  // Every box around the insertion grows (all have 32-bit sizes here: moov is small)
  for (const b of path.boxes) {
    if (b.header !== 8) throw new Error('mp4: unexpected 64-bit size inside moov');
    hv.setUint32(b.start - moov.start, b.size + insert.length);
  }
  // The media data moves back by the inserted length: shift every chunk offset
  const shift = node => {
    for (const b of boxes(hv, node.start + node.header, node.start + node.size)) {
      if (CONTAINERS.has(b.type)) shift(b);
      const n = b.type === 'stco' || b.type === 'co64' ? hv.getUint32(b.start + 12) : 0;
      for (let i = 0; i < n; i++) {
        if (b.type === 'stco') hv.setUint32(b.start + 16 + 4 * i, hv.getUint32(b.start + 16 + 4 * i) + insert.length);
        else hv.setBigUint64(b.start + 16 + 8 * i, hv.getBigUint64(b.start + 16 + 8 * i) + BigInt(insert.length));
      }
    }
  };
  shift({ start: 0, header: 8, size: head.length });
  return [bytes.subarray(0, moov.start), head, bytes.subarray(moov.start + moov.size)];
}
