// FLAC のエンコーダ(可逆圧縮)。固定予測(0〜4次)+ Rice 符号。ブラウザの中だけで動く。
// 入力は、チャンネルごとの整数のサンプル(Int32Array。16 か 24 ビット)。出力は Blob。
// 仕様: https://xiph.org/flac/format.html (ブロック長は 4096 で固定。MD5 は、未設定(0)のまま)

const BLOCK = 4096;
const MAX_PARTITION_ORDER = 6;

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();
const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

function crc8(buf, end) {
  let c = 0;
  for (let i = 0; i < end; i++) c = CRC8[c ^ buf[i]];
  return c;
}
function crc16(buf, end) {
  let c = 0;
  for (let i = 0; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ buf[i]];
  return c;
}

class BitWriter {
  constructor(capacity = 1 << 14) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0; // 書き終えたバイト数
    this.cur = 0; // 書きかけのバイト(上位の fill ビットが入っている)
    this.fill = 0;
  }
  _byte() {
    if (this.pos >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.pos++] = this.cur;
    this.cur = 0;
    this.fill = 0;
  }
  /** v(0 以上 2^n 未満の整数)を、n ビットで書く(n は 32 まで) */
  write(v, n) {
    if (n > 24) {
      const lo = v % 65536;
      this.write((v - lo) / 65536, n - 16);
      this.write(lo, 16);
      return;
    }
    while (n > 0) {
      const space = 8 - this.fill;
      if (n >= space) {
        const shift = n - space;
        this.cur = (this.cur << space) | ((v >>> shift) & ((1 << space) - 1));
        v &= (1 << shift) - 1;
        n = shift;
        this._byte();
      } else {
        this.cur = (this.cur << n) | v;
        this.fill += n;
        n = 0;
      }
    }
  }
  writeSigned(v, n) {
    this.write(v < 0 ? v + 2 ** n : v, n);
  }
  /** q 個の 0 と、1 つの 1(Rice 符号の、商の部分) */
  writeUnary(q) {
    let n = q;
    const space = 8 - this.fill;
    if (n >= space) {
      n -= space;
      this.cur <<= space;
      this._byte();
      while (n >= 8) {
        this._byte();
        n -= 8;
      }
    }
    this.cur <<= n;
    this.fill += n;
    this.write(1, 1);
  }
  align() {
    if (this.fill > 0) this.write(0, 8 - this.fill);
  }
  bytes() {
    return this.buf.slice(0, this.pos);
  }
}

function writeUtf8Number(bw, n) {
  if (n < 0x80) {
    bw.write(n, 8);
    return;
  }
  const len = n < 0x800 ? 2 : n < 0x10000 ? 3 : n < 0x200000 ? 4 : n < 0x4000000 ? 5 : 6;
  const first = (0xff << (8 - len)) & 0xff;
  bw.write(first | Math.floor(n / 2 ** (6 * (len - 1))), 8);
  for (let i = len - 2; i >= 0; i--) bw.write(0x80 | (Math.floor(n / 2 ** (6 * i)) & 0x3f), 8);
}

/** 商と余りの Rice 符号で、合計がいちばん短くなる k(0〜30)。合計は、概算 */
function bestRice(sum, count) {
  if (count === 0) return { k: 0, bits: 0 };
  let bestK = 0;
  let bestBits = Infinity;
  for (let k = 0; k <= 30; k++) {
    const bits = count * (k + 1) + Math.floor(sum / 2 ** k);
    if (bits < bestBits) {
      bestBits = bits;
      bestK = k;
    } else if (bits > bestBits) break;
  }
  return { k: bestK, bits: bestBits };
}

const residualScratch = new Int32Array(BLOCK);

function encodeSubframe(bw, x, bps) {
  const n = x.length;
  let same = true;
  for (let i = 1; i < n; i++) {
    if (x[i] !== x[0]) {
      same = false;
      break;
    }
  }
  if (same) {
    bw.write(0x00, 8); // 定数
    bw.writeSigned(x[0], bps);
    return;
  }
  if (n < 16) return verbatim(bw, x, bps);

  // 固定予測の次数(0〜4): 残差の絶対値の合計が、いちばん小さいもの
  const s = [0, 0, 0, 0, 0];
  for (let i = 4; i < n; i++) {
    const a = x[i], b = x[i - 1], c = x[i - 2], d = x[i - 3], e = x[i - 4];
    s[0] += Math.abs(a);
    s[1] += Math.abs(a - b);
    s[2] += Math.abs(a - 2 * b + c);
    s[3] += Math.abs(a - 3 * b + 3 * c - d);
    s[4] += Math.abs(a - 4 * b + 6 * c - 4 * d + e);
  }
  let order = 0;
  for (let o = 1; o <= 4; o++) if (s[o] < s[order]) order = o;

  // 残差
  const res = residualScratch;
  for (let i = order; i < n; i++) {
    let r;
    switch (order) {
      case 0: r = x[i]; break;
      case 1: r = x[i] - x[i - 1]; break;
      case 2: r = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    res[i - order] = r;
  }

  // 分割の次数(ブロックを 2^po に等分して、それぞれに k を決める)
  let maxPo = 0;
  while (maxPo < MAX_PARTITION_ORDER && n % (1 << (maxPo + 1)) === 0 && (n >> (maxPo + 1)) > order) maxPo++;
  const parts = 1 << maxPo;
  const per = n >> maxPo;
  const fineSums = new Float64Array(parts);
  const fineCounts = new Int32Array(parts);
  for (let p = 0, idx = 0; p < parts; p++) {
    const len = p === 0 ? per - order : per;
    let sum = 0;
    for (let j = 0; j < len; j++, idx++) {
      const r = res[idx];
      sum += r >= 0 ? r * 2 : -r * 2 - 1;
    }
    fineSums[p] = sum;
    fineCounts[p] = len;
  }
  // 粗い分割は、細かい分割の合計を足し合わせて作る
  const levels = new Array(maxPo + 1);
  levels[maxPo] = { sums: fineSums, counts: fineCounts };
  for (let po = maxPo - 1; po >= 0; po--) {
    const f = levels[po + 1];
    const sums = new Float64Array(1 << po);
    const counts = new Int32Array(1 << po);
    for (let p = 0; p < sums.length; p++) {
      sums[p] = f.sums[2 * p] + f.sums[2 * p + 1];
      counts[p] = f.counts[2 * p] + f.counts[2 * p + 1];
    }
    levels[po] = { sums, counts };
  }
  let bestPo = 0;
  let bestTotal = Infinity;
  for (let po = 0; po <= maxPo; po++) {
    const { sums, counts } = levels[po];
    let total = 4 + 5 * sums.length;
    for (let p = 0; p < sums.length; p++) total += bestRice(sums[p], counts[p]).bits;
    if (total < bestTotal) {
      bestTotal = total;
      bestPo = po;
    }
  }
  const level = levels[bestPo];
  // 同じ長さの、そのまま書く方が短いなら、そちらにする
  if (bestTotal + order * bps + 8 + 2 >= n * bps) return verbatim(bw, x, bps);

  bw.write((8 | order) << 1, 8); // 固定予測。無駄ビットなし
  for (let i = 0; i < order; i++) bw.writeSigned(x[i], bps);
  bw.write(1, 2); // Rice 符号(パラメータは 5 ビット)
  bw.write(bestPo, 4);
  const pCount = 1 << bestPo;
  const pLen = n >> bestPo;
  let idx = 0;
  for (let p = 0; p < pCount; p++) {
    const len = p === 0 ? pLen - order : pLen;
    const { k } = bestRice(level.sums[p], level.counts[p]);
    bw.write(k, 5);
    const mask = k === 0 ? 0 : (1 << k) - 1;
    for (let j = 0; j < len; j++, idx++) {
      const r = res[idx];
      const u = r >= 0 ? r * 2 : -r * 2 - 1;
      bw.writeUnary(u >>> k);
      if (k > 0) bw.write(u & mask, k);
    }
  }
}

function verbatim(bw, x, bps) {
  bw.write(0x02, 8);
  for (let i = 0; i < x.length; i++) bw.writeSigned(x[i], bps);
}

function encodeFrame(channels, start, n, frameNumber, bps) {
  const bw = new BitWriter(n * channels.length * 4 + 64);
  bw.write(0xfff8, 16); // 同期 + 固定ブロック長
  const sizeCode = n === BLOCK ? 12 : n <= 256 ? 6 : 7;
  bw.write(sizeCode, 4);
  bw.write(0, 4); // サンプルレート: STREAMINFO に従う
  bw.write(channels.length - 1, 4); // チャンネルは、独立
  bw.write(0, 3); // ビット深度: STREAMINFO に従う
  bw.write(0, 1);
  writeUtf8Number(bw, frameNumber);
  if (sizeCode === 6) bw.write(n - 1, 8);
  else if (sizeCode === 7) bw.write(n - 1, 16);
  bw.write(crc8(bw.buf, bw.pos), 8);
  for (const ch of channels) encodeSubframe(bw, ch.subarray(start, start + n), bps);
  bw.align();
  bw.write(crc16(bw.buf, bw.pos), 16);
  return bw.bytes();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {Int32Array[]} channels  チャンネルごとの整数のサンプル(同じ長さ)
 * @param {number} rate  サンプルレート(Hz。655350 まで)
 * @param {number} bps  16 か 24
 * @param {(p:number)=>void} [onProgress]  0〜1
 * @returns {Promise<Blob>}
 */
export async function encodeFlac(channels, rate, bps, onProgress) {
  const nch = channels.length;
  const total = channels[0].length;
  const frames = [];
  let minFrame = Infinity;
  let maxFrame = 0;
  let frameNumber = 0;
  for (let start = 0; start < total; start += BLOCK, frameNumber++) {
    const n = Math.min(BLOCK, total - start);
    const bytes = encodeFrame(channels, start, n, frameNumber, bps);
    frames.push(bytes);
    if (bytes.length < minFrame) minFrame = bytes.length;
    if (bytes.length > maxFrame) maxFrame = bytes.length;
    if (frameNumber % 64 === 63) {
      if (onProgress) onProgress(start / total);
      await tick();
    }
  }
  if (frames.length === 0) minFrame = 0;

  const info = new BitWriter(64);
  info.write(0x80, 8); // 最後のメタデータ + STREAMINFO
  info.write(34, 24);
  const bs = Math.max(16, Math.min(BLOCK, total)); // STREAMINFO のブロック長は、16 以上
  info.write(bs, 16);
  info.write(bs, 16);
  info.write(minFrame, 24);
  info.write(maxFrame, 24);
  info.write(rate, 20);
  info.write(nch - 1, 3);
  info.write(bps - 1, 5);
  info.write(Math.floor(total / 2 ** 32), 4);
  info.write(total % 2 ** 32, 32);
  for (let i = 0; i < 16; i++) info.write(0, 8); // MD5: 未設定
  if (onProgress) onProgress(1);
  return new Blob([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), info.bytes(), ...frames], { type: "audio/flac" });
}
