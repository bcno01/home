// MP3 のエンコード。実際の変換は、別スレッド(mp3-worker.js)で行う。
export const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

/** MP3 で使えるサンプルレートのうち、いちばん近いもの(同じ近さなら、高い方) */
export function nearestMp3Rate(rate) {
  return MP3_RATES.reduce((best, x) => {
    const d = Math.abs(x - rate);
    const bd = Math.abs(best - rate);
    return d < bd || (d === bd && x > best) ? x : best;
  });
}

/** @param {Int16Array[]} channels  1 か 2 チャンネル */
export function encodeMp3(channels, rate, kbps, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mp3-worker.js", import.meta.url));
    const fail = (msg) => {
      worker.terminate();
      reject(new Error(msg));
    };
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.blob) {
        worker.terminate();
        resolve(d.blob);
      } else if (d.error) fail(`MP3 にできませんでした(${d.error})`);
      else if (onProgress) onProgress(d.progress);
    };
    worker.onerror = () => fail("MP3 にできませんでした。");
    worker.postMessage({ channels, rate, kbps }, channels.map((c) => c.buffer));
  });
}
