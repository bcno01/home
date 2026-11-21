// MP3 への変換(別スレッド)。lamejs(vendor/lame.min.js)を使う。画面を止めないために、Worker で動かす。
importScripts("vendor/lame.min.js");

const BLOCK = 1152 * 16;

self.onmessage = (e) => {
  try {
    const { channels, rate, kbps } = e.data; // channels: Int16Array の配列(1 か 2)
    const enc = new lamejs.Mp3Encoder(channels.length, rate, kbps);
    const total = channels[0].length;
    const parts = [];
    let blocks = 0;
    for (let i = 0; i < total; i += BLOCK) {
      const l = channels[0].subarray(i, i + BLOCK);
      const buf = channels.length === 2 ? enc.encodeBuffer(l, channels[1].subarray(i, i + BLOCK)) : enc.encodeBuffer(l);
      if (buf.length) parts.push(buf);
      if (++blocks % 8 === 0) self.postMessage({ progress: i / total });
    }
    const tail = enc.flush();
    if (tail.length) parts.push(tail);
    self.postMessage({ blob: new Blob(parts, { type: "audio/mpeg" }) });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
