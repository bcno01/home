// AAC のパケットを、MP4(.m4a)の入れものに包む。moov(目次)を先頭に置くので、ダウンロード中でも再生を始められる。
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const fourcc = (s) => [...s].map((c) => c.charCodeAt(0));

function box(type, ...parts) {
  const body = parts.flatMap((p) => (p instanceof Uint8Array ? [...p] : p));
  return [...u32(8 + body.length), ...fourcc(type), ...body];
}
const full = (type, version, flags, ...parts) => box(type, version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255, ...parts);

/** MPEG-4 の記述子(タグ + 長さ + 中身)。長さは、4 バイトの可変長で書く */
function descriptor(tag, ...parts) {
  const body = parts.flatMap((p) => (p instanceof Uint8Array ? [...p] : p));
  const n = body.length;
  return [tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f, ...body];
}

/**
 * @param {{data:Uint8Array, samples:number}[]} packets  AAC-LC(1 パケット = 1024 サンプル)
 * @param {Uint8Array} asc  AudioSpecificConfig
 * @param {number} bitrate  bps(esds に書く、参考値)
 */
export function muxM4a(packets, asc, rate, channels, inputFrames, bitrate) {
  const sizes = packets.map((p) => p.data.length);
  const mdatSize = sizes.reduce((s, n) => s + n, 0);
  const ftyp = box("ftyp", fourcc("M4A "), u32(0), fourcc("M4A "), fourcc("mp42"), fourcc("isom"));

  const esds = full(
    "esds", 0, 0,
    descriptor(0x03, u16(0), 0,
      descriptor(0x04, 0x40, 0x15, 0, 0, 0, u32(bitrate), u32(bitrate), descriptor(0x05, asc)),
      descriptor(0x06, 0x02))
  );
  const mp4a = box("mp4a", [0, 0, 0, 0, 0, 0], u16(1), [0, 0, 0, 0, 0, 0, 0, 0], u16(channels), u16(16), u16(0), u16(0), u16(rate), u16(0), esds);
  const stsd = full("stsd", 0, 0, u32(1), mp4a);
  const stts = full("stts", 0, 0, u32(1), u32(packets.length), u32(1024));
  const stsc = full("stsc", 0, 0, u32(1), u32(1), u32(packets.length), u32(1));
  const stsz = full("stsz", 0, 0, u32(0), u32(packets.length), sizes.flatMap((n) => u32(n)));

  const build = (chunkOffset) => {
    const stco = full("stco", 0, 0, u32(1), u32(chunkOffset));
    const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
    const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
    const minf = box("minf", full("smhd", 0, 0, u16(0), u16(0)), dinf, stbl);
    const hdlr = full("hdlr", 0, 0, u32(0), fourcc("soun"), u32(0), u32(0), u32(0), [...fourcc("SoundHandler"), 0]);
    const mdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(rate), u32(inputFrames), u16(0x55c4), u16(0));
    const mdia = box("mdia", mdhd, hdlr, minf);
    const matrix = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
    const movieDuration = inputFrames; // mvhd の時間の単位も、サンプルレートにそろえる
    const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), matrix, u32(0), u32(0));
    const trak = box("trak", tkhd, mdia);
    const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(rate), u32(movieDuration), u32(0x10000), u16(0x0100), u16(0), u32(0), u32(0), matrix, new Uint8Array(24), u32(2));
    return box("moov", mvhd, trak);
  };
  const probe = build(0);
  const moov = build(ftyp.length + probe.length + 8);
  const header = new Uint8Array([...u32(8 + mdatSize), ...fourcc("mdat")]);
  return new Blob([new Uint8Array(ftyp), new Uint8Array(moov), header, ...packets.map((p) => p.data)], { type: "audio/mp4" });
}
