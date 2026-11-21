// ファイルの先頭(や、ところどころ)を読んで、元のサンプルレートを調べる。読めなければ null。
// ブラウザの音声の読み込み(decodeAudioData)は、機器のサンプルレートに変換してしまうので、「元のまま」にするために使う。

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5

export function sniffSampleRate(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const tag = (o, s) => {
    for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  try {
    if (tag(0, "RIFF") && tag(8, "WAVE")) {
      for (let o = 12; o + 8 <= u8.length; ) {
        const size = dv.getUint32(o + 4, true);
        if (tag(o, "fmt ")) return dv.getUint32(o + 12, true) || null;
        o += 8 + size + (size & 1);
      }
      return null;
    }
    if (tag(0, "fLaC")) return ((u8[18] << 12) | (u8[19] << 4) | (u8[20] >> 4)) || null;
    if (tag(0, "OggS")) {
      const payload = 27 + u8[26];
      if (tag(payload, "OpusHead")) return 48000;
      if (u8[payload] === 1 && tag(payload + 1, "vorbis")) return dv.getUint32(payload + 12, true) || null;
      return null;
    }
    if (tag(4, "ftyp")) {
      // M4A: 'mp4a' の項目のなかに、サンプルレート(16.16 の固定小数点)がある
      for (let i = 0; i + 36 < u8.length; i++) {
        if (u8[i] === 0x6d && u8[i + 1] === 0x70 && u8[i + 2] === 0x34 && u8[i + 3] === 0x61) {
          const rate = dv.getUint32(i + 28, false) >>> 16;
          if (rate >= 8000 && rate <= 192000) return rate;
        }
      }
      return null;
    }
    // MP3: ID3 を飛ばして、最初のフレームの同期(0xFFE)を探す
    let start = 0;
    if (tag(0, "ID3")) start = 10 + (((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f));
    const end = Math.min(u8.length - 4, start + 65536);
    for (let i = start; i < end; i++) {
      if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
        const version = (u8[i + 1] >> 3) & 3;
        const layer = (u8[i + 1] >> 1) & 3;
        const idx = (u8[i + 2] >> 2) & 3;
        if (version !== 1 && layer !== 0 && idx !== 3) return MP3_RATES[version][idx];
      }
    }
  } catch {
    // 途中で足りなくなったら、読めなかったことにする
  }
  return null;
}
