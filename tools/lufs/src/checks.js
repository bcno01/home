// 配信前チェック。音声全体を調べて、「配信に出す前に確認したい点」を一覧にする。
// 判定の基準は、配信サービスの規格ではなく、制作でよく使われる目安(閾値は、下の定数)。
// 計測(analyzeDelivery)と、判定の文章(evaluateChecks)を分けてある。

import { TruePeakMeter } from "./truepeak.js";

const MINUS = "−";

// --- 目安の値(ここを変えると、判定が変わる) ---
const TRUE_PEAK_LIMIT_DB = -1.0; // これ以下なら OK(dBTP)
const CLIP_LEVEL = 0.9995; // これ以上のサンプルが、
const CLIP_MIN_RUN = 3; // これ以上、続いたら、音割れの1か所と数える
const SILENCE_LEVEL = 0.001; // −60 dBFS 以下を、無音とみなす
const HEAD_SILENCE_MAX_SEC = 1.0; // 頭の無音の目安
const TAIL_SILENCE_MAX_SEC = 4.0; // 尻の無音の目安
const MIN_SAMPLE_RATE = 44100;

const LOSSLESS_EXT = ["wav", "wave", "flac", "aif", "aiff", "alac", "caf"];
const LOSSY_EXT = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wma"];

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

function toDb(linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

function fmtDb(db, digits = 1) {
  if (!Number.isFinite(db)) return `${MINUS}∞`;
  const r = Math.round(db * 10 ** digits) / 10 ** digits;
  return `${r < 0 ? MINUS : ""}${Math.abs(r).toFixed(digits)}`;
}

/**
 * @param {Float32Array[]} channelData デコード済みの各チャンネル
 * @returns {Promise<{truePeakLinear:number, clipEvents:number, headSilenceSec:number, tailSilenceSec:number, silentAll:boolean, correlation:number|null, channels:number, sampleRate:number}>}
 */
export async function analyzeDelivery(channelData, sampleRate) {
  const channels = channelData.length;
  const n = channelData[0].length;

  // 1. 音割れ・頭と尻の無音・左右の相関(1回の走査)
  let clipEvents = 0;
  let firstSound = n;
  let lastSound = -1;
  for (let c = 0; c < channels; c++) {
    const x = channelData[c];
    let run = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a >= CLIP_LEVEL) {
        run++;
        if (run === CLIP_MIN_RUN) clipEvents++;
      } else {
        run = 0;
      }
      if (a > SILENCE_LEVEL) {
        if (first < 0) first = i;
        last = i;
      }
      if ((i & 0x3ffff) === 0x3ffff) await nextFrame();
    }
    if (first >= 0) {
      firstSound = Math.min(firstSound, first);
      lastSound = Math.max(lastSound, last);
    }
  }
  const silentAll = lastSound < 0;

  let correlation = null;
  if (channels >= 2) {
    const l = channelData[0];
    const r = channelData[1];
    let sl = 0;
    let sr = 0;
    let slr = 0;
    for (let i = 0; i < n; i++) {
      sl += l[i] * l[i];
      sr += r[i] * r[i];
      slr += l[i] * r[i];
      if ((i & 0x3ffff) === 0x3ffff) await nextFrame();
    }
    correlation = sl > 0 && sr > 0 ? slr / Math.sqrt(sl * sr) : null;
  }

  // 2. トゥルーピーク(4倍オーバーサンプリング)
  let truePeakLinear = 0;
  const CHUNK = 1 << 16;
  for (let c = 0; c < channels; c++) {
    const meter = new TruePeakMeter();
    const x = channelData[c];
    let k = 0;
    for (let i = 0; i < n; i += CHUNK) {
      meter.process(x.subarray(i, Math.min(n, i + CHUNK)));
      if (++k % 8 === 0) await nextFrame();
    }
    truePeakLinear = Math.max(truePeakLinear, meter.finish());
  }

  return {
    truePeakLinear,
    clipEvents,
    headSilenceSec: silentAll ? 0 : firstSound / sampleRate,
    tailSilenceSec: silentAll ? 0 : (n - 1 - lastSound) / sampleRate,
    silentAll,
    correlation,
    channels,
    sampleRate,
  };
}

/**
 * 計測の結果を、画面に出す行にする。
 * state: "ok"(目安の範囲)/ "warn"(確認したい)/ "info"(判断できない・参考)
 * @returns {{id:string, name:string, value:string, state:string, hint:string}[]}
 */
export function evaluateChecks(r, fileName) {
  const rows = [];

  const tpDb = toDb(r.truePeakLinear);
  rows.push({
    id: "truepeak",
    name: "トゥルーピーク",
    value: `${fmtDb(tpDb)} dBTP`,
    state: tpDb <= TRUE_PEAK_LIMIT_DB ? "ok" : "warn",
    hint:
      tpDb <= TRUE_PEAK_LIMIT_DB
        ? `${MINUS}1 dBTP 以下です。配信サービスの変換でも、割れにくい目安です。`
        : tpDb > 0
          ? "0 dBTP を超えています。変換のあとで、音が割れることがあります。"
          : `${MINUS}1 dBTP を超えています。変換のあとで、割れることがあります(目安は ${MINUS}1 dBTP 以下)。`,
  });

  rows.push({
    id: "clip",
    name: "音割れ",
    value: r.clipEvents === 0 ? "なし" : `${r.clipEvents} か所`,
    state: r.clipEvents === 0 ? "ok" : "warn",
    hint:
      r.clipEvents === 0
        ? "波形が上限に張りついた所は、見つかりませんでした。"
        : "波形が上限に張りついた所です。リミッターのかけすぎか、書き出しの音量が大きい可能性があります。",
  });

  const sec = (v) => `${v.toFixed(1)} 秒`;
  const longHead = r.headSilenceSec > HEAD_SILENCE_MAX_SEC;
  const longTail = r.tailSilenceSec > TAIL_SILENCE_MAX_SEC;
  rows.push({
    id: "silence",
    name: "頭と尻の無音",
    value: r.silentAll ? "ほぼ無音" : `頭 ${sec(r.headSilenceSec)} / 尻 ${sec(r.tailSilenceSec)}`,
    state: r.silentAll || longHead || longTail ? "warn" : "ok",
    hint: r.silentAll
      ? "全体が、ほぼ無音です。書き出しを確認してください。"
      : longHead || longTail
        ? `${longHead ? "頭" : "尻"}の無音が長めです(目安は、頭 ${HEAD_SILENCE_MAX_SEC} 秒・尻 ${TAIL_SILENCE_MAX_SEC} 秒以内)。再生が間延びして聞こえます。`
        : `頭 ${HEAD_SILENCE_MAX_SEC} 秒・尻 ${TAIL_SILENCE_MAX_SEC} 秒以内が目安です。`,
  });

  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const lossless = LOSSLESS_EXT.includes(ext);
  const lossy = LOSSY_EXT.includes(ext);
  rows.push({
    id: "format",
    name: "ファイル形式",
    value: ext ? ext.toUpperCase() : "不明",
    state: lossless ? "ok" : lossy ? "warn" : "info",
    hint: lossless
      ? "劣化のない形式です。"
      : lossy
        ? "圧縮された形式です。配信用の書き出しは、WAV か FLAC が安心です(変換を重ねると、音が劣化します)。"
        : "形式から、圧縮の有無を判断できませんでした。",
  });

  rows.push({
    id: "samplerate",
    name: "サンプルレート",
    value: `${(r.sampleRate / 1000).toFixed(r.sampleRate % 1000 === 0 ? 0 : 1)} kHz`,
    state: r.sampleRate >= MIN_SAMPLE_RATE ? "ok" : "warn",
    hint: r.sampleRate >= MIN_SAMPLE_RATE ? "44.1 kHz 以上です。" : "44.1 kHz より低いです。配信は、44.1 kHz 以上が一般的です。",
  });

  rows.push({
    id: "channels",
    name: "チャンネル",
    value: r.channels === 2 ? "ステレオ" : r.channels === 1 ? "モノラル" : `${r.channels}ch`,
    state: r.channels === 2 ? "ok" : "warn",
    hint:
      r.channels === 2
        ? "ステレオです。"
        : r.channels === 1
          ? "モノラルです。意図したものか、確認してください。"
          : "3ch 以上です。配信は、ステレオに書き出すのが一般的です。",
  });

  if (r.correlation !== null) {
    const c = r.correlation;
    rows.push({
      id: "phase",
      name: "モノにしたとき",
      value: `${c < 0 ? MINUS : "+"}${Math.abs(c).toFixed(2)}`,
      state: c >= 0 ? "ok" : "warn",
      hint:
        c >= 0
          ? "左右の相関は、プラスです。モノで聴いても、音が消えにくい状態です。"
          : "左右が逆相ぎみです。モノで聴くと、音が小さくなったり、消えたりします。",
    });
  }

  return rows;
}
