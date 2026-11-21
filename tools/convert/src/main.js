import { AUDIO_ACCEPT, AUDIO_FORMATS, availableAudioFormats, convertAudio, isAudioFile } from "./audio.js";
import { createBatch } from "./batch.js";
import { IMAGE_ACCEPT, FORMATS, availableFormats, convertImage, isImageFile } from "./image.js";
import { checkField, colorField, numberField, rangeField, segField } from "./ui.js";

// ページの外にファイルを落としたときに、ブラウザが、そのファイルを開いてしまわないように
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// --- タブ(音声 / 画像)。URL の # で、開く方を指定できる ---
const tabs = [
  { id: "audio", tab: document.getElementById("cv-tab-audio"), panel: document.getElementById("cv-audio") },
  { id: "image", tab: document.getElementById("cv-tab-image"), panel: document.getElementById("cv-image") },
];
function showTab(id, focus) {
  for (const t of tabs) {
    const on = t.id === id;
    t.tab.setAttribute("aria-selected", String(on));
    t.tab.tabIndex = on ? 0 : -1;
    t.panel.hidden = !on;
    if (on && focus) t.tab.focus();
  }
  try {
    history.replaceState(null, "", id === "audio" ? location.pathname + location.search : `#${id}`);
  } catch {
    // 履歴を書き換えられない環境でも、動く
  }
}
tabs.forEach((t, i) => {
  t.tab.addEventListener("click", () => showTab(t.id));
  t.tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    showTab(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].id, true);
  });
});
showTab(location.hash === "#image" ? "image" : "audio");

// --- 音声 ---
const audioFormats = await availableAudioFormats(); // M4A と Opus は、ブラウザが書き出せるときだけ
const audio = { format: "wav", kbps: 256, bits: 24, rate: "keep", channels: "keep", dither: true };
const KBPS = { mp3: [128, 192, 256, 320], m4a: [128, 192, 256, 320], opus: [64, 96, 128, 192, 256] };
const KBPS_DEFAULT = { mp3: 256, m4a: 256, opus: 128 };
const BITS = { wav: [16, 24, 32], aiff: [16, 24], flac: [16, 24] };
const bitsOptions = (f) => BITS[f].map((v) => ({ value: v, label: v === 32 ? "32 bit float" : `${v} bit` }));
const AUDIO_HINTS = {
  wav: "WAV: 無圧縮。どのソフトでも読めます。",
  aiff: "AIFF: 無圧縮。Mac の音楽ソフトで、よく使われます。",
  flac: "FLAC: 音は変えずに、ファイルを小さくします(可逆圧縮)。",
  mp3: "MP3: 小さくなりますが、音は少し変わります(非可逆圧縮)。曲名などのタグは付きません。",
  m4a: "M4A(AAC): iPhone や iTunes で、そのまま使えます。非可逆圧縮です。曲名などのタグは付きません。",
  opus: "Opus: 低いビットレートでも、音がよい形式です(非可逆圧縮)。古い再生ソフトでは、開けないことがあります。",
};
const audioBatch = createBatch({
  panel: document.getElementById("cv-audio"),
  accept: isAudioFile,
  getSettings: () => audio,
  convertOne: convertAudio,
  zipName: "converted-audio.zip",
  thumbs: "audio",
});
{
  document.querySelector("#cv-audio .cv-input").accept = AUDIO_ACCEPT;
  const mount = document.querySelector("#cv-audio .cv-settings");
  const changed = () => {
    sync();
    audioBatch.invalidate();
  };
  const format = segField({
    label: "形式",
    columns: 3,
    options: audioFormats.map((k) => ({ value: k, label: AUDIO_FORMATS[k].label })),
    value: audio.format,
    hint: "",
    onChange: (v) => {
      audio.format = v;
      if (KBPS[v] && !KBPS[v].includes(audio.kbps)) audio.kbps = KBPS_DEFAULT[v];
      if (BITS[v] && !BITS[v].includes(audio.bits)) audio.bits = 24;
      changed();
    },
  });
  const kbps = segField({
    label: "ビットレート(kbps)",
    options: [],
    value: audio.kbps,
    hint: "大きいほど、高音質で、ファイルも大きくなります。",
    onChange: (v) => {
      audio.kbps = v;
      changed();
    },
  });
  const bits = segField({
    label: "ビット深度",
    options: bitsOptions("wav"),
    value: audio.bits,
    hint: "元の音より深くしても、音は良くなりません。",
    onChange: (v) => {
      audio.bits = v;
      changed();
    },
  });
  const rate = segField({
    label: "サンプルレート",
    options: [
      { value: "keep", label: "元のまま" },
      { value: 44100, label: "44.1 kHz" },
      { value: 48000, label: "48 kHz" },
    ],
    value: audio.rate,
    onChange: (v) => {
      audio.rate = v;
      changed();
    },
  });
  const channels = segField({
    label: "チャンネル",
    options: [
      { value: "keep", label: "元のまま" },
      { value: "stereo", label: "ステレオ" },
      { value: "mono", label: "モノラル" },
    ],
    value: audio.channels,
    onChange: (v) => {
      audio.channels = v;
      changed();
    },
  });
  const dither = checkField({
    label: "ディザを加える",
    checked: audio.dither,
    hint: "16 bit にするとき、ごく小さなノイズを足して、小さな音のひずみを目立たなくします。",
    onChange: (v) => {
      audio.dither = v;
      changed();
    },
  });
  function sync() {
    const f = audio.format;
    format.setHint(AUDIO_HINTS[f]);
    const lossy = Boolean(KBPS[f]);
    kbps.show(lossy);
    if (lossy) kbps.setOptions(KBPS[f].map((v) => ({ value: v, label: String(v) })), audio.kbps);
    bits.show(!lossy);
    if (!lossy) bits.setOptions(bitsOptions(f), audio.bits);
    dither.show(!lossy && audio.bits === 16);
    rate.setHint(f === "opus" ? "Opus は、48 kHz で作ります。" : "");
  }
  mount.append(format.root, kbps.root, bits.root, rate.root, channels.root, dither.root);
  sync();
}

// --- 画像 ---
const formats = availableFormats();
const image = { format: "png", quality: 90, resize: "keep", longSide: 1920, shrinkOnly: true, background: "#ffffff", dither: true };
const imageBatch = createBatch({
  panel: document.getElementById("cv-image"),
  accept: isImageFile,
  getSettings: () => image,
  convertOne: convertImage,
  zipName: "converted-images.zip",
  thumbs: "image",
});
const IMAGE_HINTS = {
  png: "PNG: 劣化なし。透明も使えます。",
  jpeg: "JPG: 写真向き。透明は使えません。",
  webp: "WebP: 小さくなります。透明も使えます。",
  avif: "AVIF: さらに小さくなります。読み込める環境は、まだ限られます。",
  bmp: "BMP: 無圧縮。大きくなります。透明は使えません。",
  gif: "GIF: 256 色に減らします。透明は、有り・無しだけです。動きは付きません。",
  ico: "ICO: アイコン用。16〜256 px の6つのサイズを、1つのファイルにまとめます。",
  tiff: "TIFF: 無圧縮。印刷・制作向き。透明も使えます。",
  tga: "TGA: 無圧縮。ゲーム・3D 向き。透明も使えます。",
};
{
  document.querySelector("#cv-image .cv-input").accept = IMAGE_ACCEPT;
  const mount = document.querySelector("#cv-image .cv-settings");
  const changed = () => {
    sync();
    imageBatch.invalidate();
  };
  const format = segField({
    label: "形式",
    columns: 3,
    options: formats.map((k) => ({ value: k, label: FORMATS[k].label })),
    value: image.format,
    hint: "",
    onChange: (v) => {
      image.format = v;
      changed();
    },
  });
  const quality = rangeField({
    label: "画質",
    min: 30,
    max: 100,
    value: image.quality,
    format: (n) => String(n),
    hint: "大きいほど、きれいで、ファイルも大きくなります。",
    onChange: (v) => {
      image.quality = v;
      changed();
    },
  });
  const dither = checkField({
    label: "ディザを加える",
    checked: image.dither,
    hint: "色を減らしたときの、色の段差を、目立たなくします(ファイルは大きくなります)。",
    onChange: (v) => {
      image.dither = v;
      changed();
    },
  });
  const resize = segField({
    label: "サイズ",
    options: [
      { value: "keep", label: "元のまま" },
      { value: "long", label: "長辺を指定" },
    ],
    value: image.resize,
    onChange: (v) => {
      image.resize = v;
      changed();
    },
  });
  const longSide = numberField({
    label: "長辺(縦横の長い方)",
    min: 16,
    max: 16000,
    value: image.longSide,
    unit: "px",
    presets: [640, 1280, 1920, 3000],
    onChange: (v) => {
      image.longSide = v;
      changed();
    },
  });
  const shrinkOnly = checkField({
    label: "縮小だけにする",
    checked: image.shrinkOnly,
    hint: "指定より小さい画像は、そのままにします(拡大しません)。",
    onChange: (v) => {
      image.shrinkOnly = v;
      changed();
    },
  });
  const background = colorField({
    label: "透明な部分の色",
    value: image.background,
    hint: "JPG と BMP は、透明を持てないので、この色で塗ります。",
    onChange: (v) => {
      image.background = v;
      changed();
    },
  });
  function sync() {
    const f = image.format;
    format.setHint(IMAGE_HINTS[f]);
    quality.show(f === "jpeg" || f === "webp" || f === "avif");
    dither.show(f === "gif");
    const sizable = f !== "ico"; // ICO は、決まったサイズを作る
    resize.show(sizable);
    longSide.show(sizable && image.resize === "long");
    shrinkOnly.show(sizable && image.resize === "long");
    background.show(f === "jpeg" || f === "bmp");
  }
  mount.append(format.root, quality.root, dither.root, resize.root, longSide.root, shrinkOnly.root, background.root);
  sync();
}
