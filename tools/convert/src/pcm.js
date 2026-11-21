// 浮動小数点のサンプル(-1〜1)を、整数に丸める。16 ビットのときは、ディザ(TPDF。±1 の小さなノイズ)を足せる。
// 乱数は、毎回同じ並びを使うので、同じファイルは、いつも同じ結果になる。

export function makeQuantizer(bits, dither) {
  const scale = 2 ** (bits - 1);
  const min = -scale;
  const max = scale - 1;
  let state = 0x9e3779b9 | 0;
  const rnd = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  return dither
    ? (x) => {
        const v = Math.round(x * scale + (rnd() - rnd()));
        return v < min ? min : v > max ? max : v;
      }
    : (x) => {
        const v = Math.round(x * scale);
        return v < min ? min : v > max ? max : v;
      };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const CHUNK = 1 << 18;

/** Float32Array → 整数(bits は 16 か 24。出力は、既定では Int32Array)。途中で、画面に制御を返す */
export async function quantizeChannel(data, bits, dither, onProgress, Out = Int32Array) {
  const q = makeQuantizer(bits, dither);
  const out = new Out(data.length);
  for (let start = 0; start < data.length; start += CHUNK) {
    const end = Math.min(data.length, start + CHUNK);
    for (let i = start; i < end; i++) out[i] = q(data[i]);
    if (onProgress) onProgress(end / data.length);
    await tick();
  }
  return out;
}

/** WAV(PCM 16/24 ビット、または 32 ビット浮動小数点)。リトルエンディアンの環境が前提(ほぼすべて) */
export async function encodeWav(channels, rate, bits, dither, onProgress) {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const float = bits === 32;
  const headerLen = float ? 56 : 44;
  const dataLen = frames * nch * bytes;
  if (headerLen + dataLen > 0xffffffff) throw new Error("WAV は、4 GB までです。短く区切ってください。");
  const buf = new ArrayBuffer(headerLen + dataLen);
  const dv = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, headerLen - 8 + dataLen, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, float ? 3 : 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * nch * bytes, true);
  dv.setUint16(32, nch * bytes, true);
  dv.setUint16(34, bits, true);
  let o = 36;
  if (float) {
    str(o, "fact");
    dv.setUint32(o + 4, 4, true);
    dv.setUint32(o + 8, frames, true);
    o += 12;
  }
  str(o, "data");
  dv.setUint32(o + 4, dataLen, true);
  const body = headerLen;

  const q = float ? null : makeQuantizer(bits, dither);
  const u8 = new Uint8Array(buf);
  const f32 = float ? new Float32Array(buf, body, frames * nch) : null;
  const i16 = bits === 16 ? new Int16Array(buf, body, frames * nch) : null;
  for (let start = 0; start < frames; start += CHUNK) {
    const end = Math.min(frames, start + CHUNK);
    for (let i = start; i < end; i++) {
      for (let c = 0; c < nch; c++) {
        const x = channels[c][i];
        const k = i * nch + c;
        if (float) f32[k] = x;
        else if (i16) i16[k] = q(x);
        else {
          const v = q(x);
          const p = body + k * 3;
          u8[p] = v & 0xff;
          u8[p + 1] = (v >> 8) & 0xff;
          u8[p + 2] = (v >> 16) & 0xff;
        }
      }
    }
    if (onProgress) onProgress(end / frames);
    await tick();
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** IEEE 754 の 80 ビット拡張形式(AIFF の、サンプルレートの書き方) */
function extended80(value) {
  const out = new Uint8Array(10);
  if (value === 0) return out;
  let exp = Math.floor(Math.log2(value));
  let mant = value / 2 ** exp; // 1 以上 2 未満
  if (mant >= 2) {
    mant /= 2;
    exp++;
  }
  const e = exp + 16383;
  out[0] = (e >> 8) & 0x7f;
  out[1] = e & 0xff;
  // 仮数は、先頭の 1 を含む 64 ビット
  const hi = Math.floor(mant * 2 ** 31); // 上位 32 ビット(先頭の 1 を含む)
  const lo = Math.floor((mant * 2 ** 31 - hi) * 2 ** 32);
  out[2] = (hi >>> 24) & 0xff;
  out[3] = (hi >>> 16) & 0xff;
  out[4] = (hi >>> 8) & 0xff;
  out[5] = hi & 0xff;
  out[6] = (lo >>> 24) & 0xff;
  out[7] = (lo >>> 16) & 0xff;
  out[8] = (lo >>> 8) & 0xff;
  out[9] = lo & 0xff;
  return out;
}

/** AIFF(PCM 16 / 24 ビット。ビッグエンディアン) */
export async function encodeAiff(channels, rate, bits, dither, onProgress) {
  const nch = channels.length;
  const frames = channels[0].length;
  const bytes = bits / 8;
  const dataLen = frames * nch * bytes;
  const ssndLen = 8 + dataLen;
  const total = 4 + (8 + 18) + (8 + ssndLen + (ssndLen & 1));
  if (total + 8 > 0xffffffff) throw new Error("AIFF は、4 GB までです。短く区切ってください。");
  const buf = new ArrayBuffer(12 + 8 + 18 + 8 + 8 + dataLen + (dataLen & 1));
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i);
  };
  str(0, "FORM");
  dv.setUint32(4, buf.byteLength - 8, false);
  str(8, "AIFF");
  str(12, "COMM");
  dv.setUint32(16, 18, false);
  dv.setUint16(20, nch, false);
  dv.setUint32(22, frames, false);
  dv.setUint16(26, bits, false);
  u8.set(extended80(rate), 28);
  str(38, "SSND");
  dv.setUint32(42, ssndLen, false);
  dv.setUint32(46, 0, false);
  dv.setUint32(50, 0, false);
  const body = 54;
  const q = makeQuantizer(bits, dither);
  for (let start = 0; start < frames; start += CHUNK) {
    const end = Math.min(frames, start + CHUNK);
    for (let i = start; i < end; i++) {
      for (let c = 0; c < nch; c++) {
        const v = q(channels[c][i]);
        const p = body + (i * nch + c) * bytes;
        if (bits === 16) {
          u8[p] = (v >> 8) & 0xff;
          u8[p + 1] = v & 0xff;
        } else {
          u8[p] = (v >> 16) & 0xff;
          u8[p + 1] = (v >> 8) & 0xff;
          u8[p + 2] = v & 0xff;
        }
      }
    }
    if (onProgress) onProgress(end / frames);
    await tick();
  }
  return new Blob([buf], { type: "audio/aiff" });
}
