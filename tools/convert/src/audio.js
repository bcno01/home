// 音声 → 音声。ブラウザの音声の読み込み(decodeAudioData)で読んで、WAV / AIFF / FLAC / MP3 / M4A(AAC)/ Opus に書き出す。
import { encodeFlac } from "./flac.js";
import { encodeMp3, nearestMp3Rate } from "./mp3.js";
import { muxM4a } from "./mp4.js";
import { muxOggOpus } from "./ogg.js";
import { encodeAiff, encodeWav, quantizeChannel } from "./pcm.js";
import { sniffSampleRate } from "./sniff.js";
import { canEncode, encodePackets } from "./webcodecs.js";
import { baseName, fmtDuration } from "./ui.js";

const AUDIO_EXT = /\.(wav|wave|mp3|m4a|aac|flac|ogg|oga|opus|aif|aiff|aifc|caf|weba)$/i;
export const AUDIO_ACCEPT = "audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.aif,.aiff,.caf";

export function isAudioFile(file) {
  return file.type.startsWith("audio/") || AUDIO_EXT.test(file.name);
}

function mixChannels(audio, mode) {
  const n = audio.numberOfChannels;
  const len = audio.length;
  const raw = Array.from({ length: n }, (_, i) => audio.getChannelData(i));
  if (mode === "keep" || (mode === "mono" && n === 1) || (mode === "stereo" && n === 2)) return raw;
  if (mode === "mono") {
    const out = new Float32Array(len);
    for (const ch of raw) for (let i = 0; i < len; i++) out[i] += ch[i] / n;
    return [out];
  }
  if (n === 1) return [raw[0], raw[0]];
  // 3 チャンネル以上 → ステレオ: 偶数番を左、奇数番を右にまとめる(平均)
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const nl = Math.ceil(n / 2);
  const nr = Math.floor(n / 2);
  raw.forEach((ch, c) => {
    const dst = c % 2 === 0 ? L : R;
    const k = c % 2 === 0 ? nl : nr;
    for (let i = 0; i < len; i++) dst[i] += ch[i] / k;
  });
  return [L, R];
}


export const AUDIO_FORMATS = {
  wav: { label: "WAV", ext: "wav" },
  aiff: { label: "AIFF", ext: "aiff" },
  flac: { label: "FLAC", ext: "flac" },
  mp3: { label: "MP3", ext: "mp3" },
  m4a: { label: "M4A", ext: "m4a" },
  opus: { label: "Opus", ext: "opus" },
};

/** AAC で、ブラウザが書き出せるサンプルレート(上限は 48 kHz) */
const AAC_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
const aacConfig = (rate, ch = 2, kbps = 128) => ({ codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: ch, bitrate: kbps * 1000, aac: { format: "aac" } });
const opusConfig = (ch = 2, kbps = 128) => ({ codec: "opus", sampleRate: 48000, numberOfChannels: ch, bitrate: kbps * 1000 });

/** このブラウザで書き出せる形式(M4A と Opus は、ブラウザの音声エンコーダ次第) */
export async function availableAudioFormats() {
  const out = ["wav", "aiff", "flac", "mp3"];
  if (await canEncode(aacConfig(44100))) out.push("m4a");
  if (await canEncode(opusConfig())) out.push("opus");
  return out;
}

async function nearestAacRate(rate) {
  const ok = [];
  for (const r of AAC_RATES) if (await canEncode(aacConfig(r))) ok.push(r);
  if (!ok.length) return rate;
  return ok.reduce((best, x) => (Math.abs(x - rate) < Math.abs(best - rate) || (Math.abs(x - rate) === Math.abs(best - rate) && x > best) ? x : best));
}

const ASC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** ブラウザが AudioSpecificConfig を返さないときの、代わり(AAC-LC) */
function makeAsc(rate, ch) {
  const idx = ASC_RATES.indexOf(rate);
  return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)]);
}

/** 変換後の波形を、小さな画像にする(行の左の、正方形に出す。色は、出力を表すピンク) */
function waveformThumb(chans) {
  const size = 112;
  const bars = 28;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  const len = chans[0].length;
  const step = Math.max(1, Math.floor(len / bars));
  const peaks = [];
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    const from = b * step;
    const to = Math.min(len, from + step);
    const skip = Math.max(1, Math.floor((to - from) / 400)); // 長い曲でも、間引いて、速く
    for (const ch of chans) for (let i = from; i < to; i += skip) peak = Math.max(peak, Math.abs(ch[i]));
    peaks.push(peak);
  }
  const top = Math.max(...peaks, 1e-6); // そのファイルの、いちばん大きい音を、いっぱいの高さにする(小さい音量の曲でも、形が見える)
  x.fillStyle = "#ff4d8d";
  peaks.forEach((peak, b) => {
    const h = Math.max(4, Math.round((peak / top) * size * 0.8));
    x.fillRect(b * 4, Math.round((size - h) / 2), 3, h);
  });
  return c.toDataURL("image/png");
}

const LOSSY = new Set(["mp3", "m4a", "opus"]);
const rateText = (r) => `${r / 1000} kHz`;
const bitsText = (b) => (b === 32 ? "32-bit float" : `${b}-bit`);
const chText = (n) => (n === 1 ? "モノラル" : n === 2 ? "ステレオ" : `${n}ch`);

/**
 * @param {File} file
 * @param {{format:"wav"|"aiff"|"flac"|"mp3"|"m4a"|"opus", kbps:number, bits:16|24|32, rate:"keep"|number, channels:"keep"|"mono"|"stereo", dither:boolean}} s
 * @param {(p:number)=>void} onProgress  0〜1
 */
export async function convertAudio(file, s, onProgress) {
  const buf = await file.arrayBuffer();
  const sniffed = sniffSampleRate(buf);
  let rate = s.rate === "keep" ? sniffed || 48000 : s.rate;
  let rateNote = "";
  const fixRate = (r, why) => {
    if (r !== rate) rateNote = `${why} では ${rate / 1000} kHz を使えないので、${r / 1000} kHz にしました`;
    rate = r;
  };
  if (s.format === "mp3") fixRate(nearestMp3Rate(rate), "MP3"); // 使えないサンプルレートは、近いものにする
  else if (s.format === "opus") fixRate(48000, "Opus");
  else if (s.format === "m4a") fixRate(await nearestAacRate(rate), "AAC");
  let audio;
  try {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    audio = await new Ctx(1, 1, rate).decodeAudioData(buf);
  } catch {
    throw new Error("読み込めませんでした。対応していない形式か、ファイルが壊れているかもしれません。");
  }
  onProgress(0.12);
  let chans = mixChannels(audio, s.channels);
  if (LOSSY.has(s.format) && chans.length > 2) chans = mixChannels(audio, "stereo"); // MP3・M4A・Opus は、2 チャンネルまで
  const bits = s.format === "flac" || s.format === "aiff" ? Math.min(24, s.bits) : s.bits;
  const dither = s.dither && bits === 16;
  let blob;
  if (s.format === "mp3") {
    const ints = [];
    for (let c = 0; c < chans.length; c++) {
      ints.push(await quantizeChannel(chans[c], 16, false, (p) => onProgress(0.12 + (0.2 * (c + p)) / chans.length), Int16Array));
    }
    blob = await encodeMp3(ints, rate, s.kbps, (p) => onProgress(0.32 + 0.68 * p));
  } else if (s.format === "opus") {
    const { packets, description } = await encodePackets(opusConfig(chans.length, s.kbps), chans, (p) => onProgress(0.12 + 0.88 * p));
    const preSkip = description && description.length >= 12 ? description[10] | (description[11] << 8) : 312;
    blob = muxOggOpus(packets, chans.length, chans[0].length, sniffed || rate, preSkip);
  } else if (s.format === "m4a") {
    const { packets, description } = await encodePackets(aacConfig(rate, chans.length, s.kbps), chans, (p) => onProgress(0.12 + 0.88 * p));
    blob = muxM4a(packets, description || makeAsc(rate, chans.length), rate, chans.length, chans[0].length, s.kbps * 1000);
  } else if (s.format === "aiff") {
    blob = await encodeAiff(chans, rate, bits, dither, (p) => onProgress(0.12 + 0.88 * p));
  } else if (s.format === "wav") {
    blob = await encodeWav(chans, rate, bits, dither, (p) => onProgress(0.12 + 0.88 * p));
  } else {
    const ints = [];
    for (let c = 0; c < chans.length; c++) {
      ints.push(await quantizeChannel(chans[c], bits, dither, (p) => onProgress(0.12 + (0.28 * (c + p)) / chans.length)));
    }
    blob = await encodeFlac(ints, rate, bits, (p) => onProgress(0.4 + 0.6 * p));
  }
  return {
    blob,
    thumb: waveformThumb(chans),
    name: `${baseName(file.name)}.${AUDIO_FORMATS[s.format].ext}`,
    info: [rateText(rate), LOSSY.has(s.format) ? `${s.kbps} kbps` : bitsText(bits), chText(chans.length), fmtDuration(audio.duration)].join(" · "),
    note: rateNote || (s.rate === "keep" && !sniffed ? "元のサンプルレートが分からなかったので、48 kHz にしました" : ""),
  };
}
