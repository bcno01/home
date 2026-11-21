// ブラウザの canvas では書き出せない画像形式(BMP / GIF / ICO / TIFF / TGA)を、自前で作る。
// 画素は、RGBA(各 8 ビット。ImageData の data と同じ並び)で受け取る。

const u16 = (n) => [n & 255, (n >> 8) & 255];
const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];

/** BMP(24 ビット。透明は持てないので、描く前に、背景色で塗っておく) */
export function encodeBmp(rgba, w, h) {
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowBytes * h;
  const out = new Uint8Array(size);
  out.set([0x42, 0x4d, ...u32(size), 0, 0, 0, 0, ...u32(54), ...u32(40), ...u32(w), ...u32(h), ...u16(1), ...u16(24), ...u32(0), ...u32(rowBytes * h), ...u32(2835), ...u32(2835), ...u32(0), ...u32(0)]);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * rowBytes; // 下の行から
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[o++] = rgba[i + 2];
      out[o++] = rgba[i + 1];
      out[o++] = rgba[i];
    }
  }
  return new Blob([out], { type: "image/bmp" });
}

/** TGA(32 ビット。透明も持てる。左上が原点) */
export function encodeTga(rgba, w, h) {
  const out = new Uint8Array(18 + w * h * 4);
  out.set([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u16(w), ...u16(h), 32, 0x28]);
  for (let i = 0, o = 18; i < w * h * 4; i += 4, o += 4) {
    out[o] = rgba[i + 2];
    out[o + 1] = rgba[i + 1];
    out[o + 2] = rgba[i];
    out[o + 3] = rgba[i + 3];
  }
  return new Blob([out], { type: "image/x-tga" });
}

/** TIFF(無圧縮の RGBA。透明は、「アルファ(非乗算)」として持つ) */
export function encodeTiff(rgba, w, h) {
  const entries = 11;
  const ifdLen = 2 + entries * 12 + 4;
  const bpsOffset = 8 + ifdLen;
  const dataOffset = bpsOffset + 8;
  const dataLen = w * h * 4;
  const out = new Uint8Array(dataOffset + dataLen);
  const dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  dv.setUint16(8, entries, true);
  let p = 10;
  const entry = (tag, type, count, value) => {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(p + 8, value, true);
    else dv.setUint32(p + 8, value, true);
    p += 12;
  };
  entry(256, 4, 1, w); // ImageWidth
  entry(257, 4, 1, h); // ImageLength
  entry(258, 3, 4, bpsOffset); // BitsPerSample: 8,8,8,8
  entry(259, 3, 1, 1); // 無圧縮
  entry(262, 3, 1, 2); // RGB
  entry(273, 4, 1, dataOffset); // StripOffsets
  entry(277, 3, 1, 4); // SamplesPerPixel
  entry(278, 4, 1, h); // RowsPerStrip
  entry(279, 4, 1, dataLen); // StripByteCounts
  entry(284, 3, 1, 1); // PlanarConfiguration
  entry(338, 3, 1, 2); // ExtraSamples: 非乗算のアルファ
  dv.setUint32(p, 0, true);
  for (let i = 0; i < 4; i++) dv.setUint16(bpsOffset + i * 2, 8, true);
  out.set(rgba.subarray(0, dataLen), dataOffset);
  return new Blob([out], { type: "image/tiff" });
}

/** ICO(複数のサイズの PNG を、1 つにまとめる)。images: [{ size, png: Uint8Array }] */
export function buildIco(images) {
  const head = [0, 0, 1, 0, ...u16(images.length)];
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    entries.push(size >= 256 ? 0 : size, size >= 256 ? 0 : size, 0, 0, ...u16(1), ...u16(32), ...u32(png.length), ...u32(offset));
    offset += png.length;
  }
  return new Blob([new Uint8Array([...head, ...entries]), ...images.map((i) => i.png)], { type: "image/x-icon" });
}

// ---------------------------------------------------------------- GIF

/** 256 色にする(メディアンカット)。透明(alpha < 128)があれば、0 番を透明にして、255 色にする */
function quantize(rgba, w, h, dither) {
  const n = w * h;
  let hasTransparent = false;
  const counts = new Uint32Array(32768);
  const sr = new Float64Array(32768);
  const sg = new Float64Array(32768);
  const sb = new Float64Array(32768);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 128) {
      hasTransparent = true;
      continue;
    }
    const bin = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    counts[bin]++;
    sr[bin] += rgba[o];
    sg[bin] += rgba[o + 1];
    sb[bin] += rgba[o + 2];
  }
  const total = hasTransparent ? 255 : 256;
  const bins = [];
  for (let b = 0; b < 32768; b++) if (counts[b]) bins.push(b);

  const channelOf = (bin, c) => (c === 0 ? bin >> 10 : c === 1 ? (bin >> 5) & 31 : bin & 31);
  const makeBox = (list) => {
    let min = [31, 31, 31];
    let max = [0, 0, 0];
    let pop = 0;
    for (const b of list) {
      pop += counts[b];
      for (let c = 0; c < 3; c++) {
        const v = channelOf(b, c);
        if (v < min[c]) min[c] = v;
        if (v > max[c]) max[c] = v;
      }
    }
    const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const axis = ranges[1] >= ranges[0] && ranges[1] >= ranges[2] ? 1 : ranges[0] >= ranges[2] ? 0 : 2; // 緑を、少し重く見る
    return { list, pop, axis, score: Math.max(...ranges) * Math.sqrt(pop) };
  };
  let boxes = bins.length ? [makeBox(bins)] : [];
  while (boxes.length < total) {
    let best = -1;
    let bestScore = 0;
    boxes.forEach((b, i) => {
      if (b.list.length > 1 && b.score > bestScore) {
        bestScore = b.score;
        best = i;
      }
    });
    if (best < 0) break;
    const box = boxes[best];
    const sorted = box.list.slice().sort((a, b) => channelOf(a, box.axis) - channelOf(b, box.axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += counts[sorted[i]];
      cut = i + 1;
      if (acc >= box.pop / 2) break;
    }
    boxes.splice(best, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }

  const palette = new Uint8Array(256 * 3);
  const first = hasTransparent ? 1 : 0;
  const colors = boxes.map((b) => {
    let r = 0, g = 0, bl = 0, c = 0;
    for (const bin of b.list) {
      r += sr[bin];
      g += sg[bin];
      bl += sb[bin];
      c += counts[bin];
    }
    return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)];
  });
  colors.forEach((c, i) => palette.set(c, (first + i) * 3));
  const used = first + colors.length;

  const nearestCache = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = nearestCache[bin];
    if (idx >= 0) return idx;
    const cr = (r & 0xf8) | 4;
    const cg = (g & 0xf8) | 4;
    const cb = (b & 0xf8) | 4;
    let bestD = Infinity;
    idx = first;
    for (let i = first; i < used; i++) {
      const dr = palette[i * 3] - cr;
      const dg = palette[i * 3 + 1] - cg;
      const db = palette[i * 3 + 2] - cb;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) {
        bestD = d;
        idx = i;
      }
    }
    nearestCache[bin] = idx;
    return idx;
  };

  const indices = new Uint8Array(n);
  if (!dither) {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      indices[i] = rgba[o + 3] < 128 ? 0 : nearest(rgba[o], rgba[o + 1], rgba[o + 2]);
    }
  } else {
    // Floyd–Steinberg(誤差を、右・左下・下・右下に配る)
    let cur = new Float32Array((w + 2) * 3);
    let next = new Float32Array((w + 2) * 3);
    for (let y = 0; y < h; y++) {
      next.fill(0);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const o = i * 4;
        if (rgba[o + 3] < 128) {
          indices[i] = 0;
          continue;
        }
        const e = (x + 1) * 3;
        const r = Math.min(255, Math.max(0, Math.round(rgba[o] + cur[e])));
        const g = Math.min(255, Math.max(0, Math.round(rgba[o + 1] + cur[e + 1])));
        const b = Math.min(255, Math.max(0, Math.round(rgba[o + 2] + cur[e + 2])));
        const idx = nearest(r, g, b);
        indices[i] = idx;
        const er = r - palette[idx * 3];
        const eg = g - palette[idx * 3 + 1];
        const eb = b - palette[idx * 3 + 2];
        for (let c = 0; c < 3; c++) {
          const err = c === 0 ? er : c === 1 ? eg : eb;
          cur[e + 3 + c] += (err * 7) / 16;
          next[e - 3 + c] += (err * 3) / 16;
          next[e + c] += (err * 5) / 16;
          next[e + 3 + c] += err / 16;
        }
      }
      [cur, next] = [next, cur];
    }
  }
  return { palette, indices, transparent: hasTransparent ? 0 : -1 };
}

/** GIF 用の LZW(可変長の符号。最大 12 ビット)。サブブロックに分けた形で返す */
function lzw(indices, minCode) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  const bytes = [];
  let cur = 0;
  let curBits = 0;
  let size = minCode + 1;
  const emit = (code) => {
    cur |= code << curBits;
    curBits += size;
    while (curBits >= 8) {
      bytes.push(cur & 255);
      cur >>>= 8;
      curBits -= 8;
    }
  };
  let table = new Map();
  let next = eoi + 1;
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      table.set(key, next++);
      if (next - 1 === 1 << size && size < 12) size++;
    } else {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      size = minCode + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (curBits > 0) bytes.push(cur & 255);
  const blocks = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const part = bytes.slice(i, i + 255);
    blocks.push(part.length, ...part);
  }
  return blocks;
}

/** GIF(256 色。アニメーションなし)。dither: 誤差拡散で、なめらかに見せる */
export function encodeGif(rgba, w, h, dither) {
  const { palette, indices, transparent } = quantize(rgba, w, h, dither);
  const out = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16(w), ...u16(h), 0xf7, 0, 0];
  out.push(...palette);
  if (transparent >= 0) out.push(0x21, 0xf9, 4, 0x01, 0, 0, transparent, 0);
  out.push(0x2c, 0, 0, 0, 0, ...u16(w), ...u16(h), 0, 8);
  const body = lzw(indices, 8);
  return new Blob([new Uint8Array(out), new Uint8Array(body), new Uint8Array([0, 0x3b])], { type: "image/gif" });
}
