// Opus のパケットを、Ogg の入れものに包む(.opus)。
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return c >>> 0;
}

/** ページを 1 つ作る。packets: Uint8Array の配列(各パケットは、最後まで、このページに入る) */
function page(packets, { headerType, granule, serial, sequence }) {
  const segs = [];
  for (const p of packets) {
    let left = p.length;
    while (left >= 255) {
      segs.push(255);
      left -= 255;
    }
    segs.push(left);
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + segs.length + bodyLen);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53, 0, headerType]);
  dv.setUint32(6, granule % 2 ** 32, true);
  dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, sequence, true);
  out[26] = segs.length;
  out.set(segs, 27);
  let o = 27 + segs.length;
  for (const p of packets) {
    out.set(p, o);
    o += p.length;
  }
  dv.setUint32(22, crc32(out), true);
  return out;
}

const text = (s) => new TextEncoder().encode(s);

/**
 * @param {{data:Uint8Array, samples:number}[]} packets  48 kHz のパケット
 * @param {number} channels
 * @param {number} inputFrames  元の長さ(サンプル数。最後の余りを切り落とすために使う)
 * @param {number} inputRate  元のサンプルレート(ヘッダに、参考として書く)
 * @param {number} preSkip  先頭で捨てるサンプル数
 */
export function muxOggOpus(packets, channels, inputFrames, inputRate, preSkip) {
  const serial = 0x42434e4f; // "BCNO"
  const head = new Uint8Array(19);
  head.set(text("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  head[10] = preSkip & 0xff;
  head[11] = (preSkip >> 8) & 0xff;
  new DataView(head.buffer).setUint32(12, inputRate, true);
  const vendor = text("BCNO File Converter");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(text("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const pages = [page([head], { headerType: 0x02, granule: 0, serial, sequence: 0 }), page([tags], { headerType: 0, granule: 0, serial, sequence: 1 })];
  let seq = 2;
  let granule = preSkip;
  let batch = [];
  let segCount = 0;
  const lastGranule = preSkip + inputFrames;
  const flush = (last) => {
    if (!batch.length) return;
    pages.push(page(batch, { headerType: last ? 0x04 : 0, granule: last ? lastGranule : Math.min(granule, lastGranule), serial, sequence: seq++ }));
    batch = [];
    segCount = 0;
  };
  packets.forEach((p, i) => {
    const segs = Math.floor(p.data.length / 255) + 1;
    if (segCount + segs > 250) flush(false);
    batch.push(p.data);
    segCount += segs;
    granule += p.samples;
    if (i === packets.length - 1) flush(true);
  });
  if (!packets.length) pages.push(page([], { headerType: 0x04, granule: preSkip, serial, sequence: seq }));
  return new Blob(pages, { type: "audio/ogg" });
}
