// 画像 → 画像。ブラウザで読んで、canvas に描いて、PNG / JPG / WebP / AVIF(ブラウザが書き出せるもの)と、BMP / GIF / ICO / TIFF / TGA(imgenc.js で自前)で書き出す。
import { buildIco, encodeBmp, encodeGif, encodeTga, encodeTiff } from "./imgenc.js";
import { baseName } from "./ui.js";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg|heic|heif|ico|tiff?)$/i;
export const IMAGE_ACCEPT = "image/*,.heic,.heif,.avif,.webp";

export function isImageFile(file) {
  return file.type.startsWith("image/") || IMAGE_EXT.test(file.name);
}

export const FORMATS = {
  png: { mime: "image/png", ext: "png", label: "PNG" },
  jpeg: { mime: "image/jpeg", ext: "jpg", label: "JPG" },
  webp: { mime: "image/webp", ext: "webp", label: "WebP" },
  avif: { mime: "image/avif", ext: "avif", label: "AVIF" },
  // 以下は、自前で作る(ブラウザの canvas では、書き出せない)
  bmp: { mime: "image/bmp", ext: "bmp", label: "BMP", custom: true },
  gif: { mime: "image/gif", ext: "gif", label: "GIF", custom: true },
  ico: { mime: "image/x-icon", ext: "ico", label: "ICO", custom: true },
  tiff: { mime: "image/tiff", ext: "tiff", label: "TIFF", custom: true },
  tga: { mime: "image/x-tga", ext: "tga", label: "TGA", custom: true },
};

export const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/** このブラウザが、書き出せる形式(書き出せない形式を選ぶと、ブラウザは、黙って PNG にしてしまう) */
export function availableFormats() {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  return Object.keys(FORMATS).filter((k) => FORMATS[k].custom || c.toDataURL(FORMATS[k].mime).startsWith(`data:${FORMATS[k].mime}`));
}

async function load(file) {
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    // SVG など、createImageBitmap で読めないもの
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth || 1024, h: img.naturalHeight || 1024, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("読み込めませんでした。このブラウザでは開けない形式か、ファイルが壊れているかもしれません。");
  }
}

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** 半分ずつ縮めてから、最後に目的の大きさへ(いっぺんに縮めすぎると、ざらつくため) */
function drawScaled(src, sw, sh, tw, th, background) {
  let cur = src;
  let cw = sw;
  let ch = sh;
  while (cw >= tw * 2 && ch >= th * 2) {
    const nw = Math.max(tw, Math.ceil(cw / 2));
    const nh = Math.max(th, Math.ceil(ch / 2));
    const c = newCanvas(nw, nh);
    const x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = c;
    cw = nw;
    ch = nh;
  }
  const out = newCanvas(tw, th);
  const ctx = out.getContext("2d");
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, tw, th);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, tw, th);
  return out;
}

function targetSize(w, h, s) {
  if (s.resize !== "long") return [w, h];
  const long = Math.max(w, h);
  if (s.shrinkOnly && s.longSide >= long) return [w, h];
  const f = s.longSide / long;
  return [Math.max(1, Math.round(w * f)), Math.max(1, Math.round(h * f))];
}

const toBlob = (canvas, mime, quality) => new Promise((resolve) => canvas.toBlob(resolve, mime, quality));

/** ICO: 正方形の中に収めて、いくつかのサイズの PNG を作り、1 つにまとめる */
async function makeIco(img) {
  const images = [];
  for (const n of ICO_SIZES) {
    const f = n / Math.max(img.w, img.h);
    const dw = Math.max(1, Math.round(img.w * f));
    const dh = Math.max(1, Math.round(img.h * f));
    const scaled = drawScaled(img.src, img.w, img.h, dw, dh, null);
    const sq = newCanvas(n, n);
    sq.getContext("2d").drawImage(scaled, Math.round((n - dw) / 2), Math.round((n - dh) / 2));
    const blob = await toBlob(sq, "image/png");
    if (!blob) throw new Error("ICO にできませんでした。");
    images.push({ size: n, png: new Uint8Array(await blob.arrayBuffer()) });
  }
  return buildIco(images);
}

/**
 * @param {File} file
 * @param {{format:string, quality:number, resize:"keep"|"long", longSide:number, shrinkOnly:boolean, background:string, dither:boolean}} s
 */
export async function convertImage(file, s, onProgress) {
  const fmt = FORMATS[s.format];
  const img = await load(file);
  try {
    onProgress(0.3);
    const name = `${baseName(file.name)}.${fmt.ext}`;
    if (s.format === "ico") {
      const blob = await makeIco(img);
      return { blob, name, info: [`${img.w}×${img.h} → ${ICO_SIZES[0]}〜${ICO_SIZES[ICO_SIZES.length - 1]} px`, "ICO"].join(" · "), note: "" };
    }
    const [tw, th] = targetSize(img.w, img.h, s);
    const flat = s.format === "jpeg" || s.format === "bmp"; // 透明を持てない形式は、背景色で塗る
    const canvas = drawScaled(img.src, img.w, img.h, tw, th, flat ? s.background : null);
    onProgress(0.7);
    let blob;
    if (fmt.custom) {
      const px = canvas.getContext("2d").getImageData(0, 0, tw, th).data;
      blob = { bmp: () => encodeBmp(px, tw, th), gif: () => encodeGif(px, tw, th, s.dither), tiff: () => encodeTiff(px, tw, th), tga: () => encodeTga(px, tw, th) }[s.format]();
    } else {
      blob = await toBlob(canvas, fmt.mime, s.quality / 100);
      if (!blob || blob.type !== fmt.mime) {
        throw new Error(`${fmt.label} にできませんでした。画像が大きすぎるか、このブラウザが、この形式に対応していないかもしれません。`);
      }
    }
    return {
      blob,
      name,
      info: [img.w === tw && img.h === th ? `${tw}×${th}` : `${img.w}×${img.h} → ${tw}×${th}`, fmt.label].join(" · "),
      note: "",
    };
  } finally {
    img.close();
  }
}
