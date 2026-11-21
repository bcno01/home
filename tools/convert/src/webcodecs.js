// ブラウザの音声エンコーダ(WebCodecs)で、Opus や AAC に圧縮する。包み(ogg.js / mp4.js)は、このあと別に作る。
const tick = () => new Promise((r) => setTimeout(r, 0));

/** この設定で、ブラウザが書き出せるか */
export async function canEncode(config) {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return false;
  try {
    return !!(await AudioEncoder.isConfigSupported(config)).supported;
  } catch {
    return false;
  }
}

/**
 * @param {object} config  AudioEncoder の設定(codec / sampleRate / numberOfChannels / bitrate など)
 * @param {Float32Array[]} channels
 * @returns {Promise<{packets: {data: Uint8Array, samples: number}[], description: Uint8Array|null}>}
 */
export async function encodePackets(config, channels, onProgress) {
  const rate = config.sampleRate;
  const total = channels[0].length;
  const packets = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, samples: Math.round((chunk.duration * rate) / 1e6) });
      if (!description && meta?.decoderConfig?.description) description = new Uint8Array(meta.decoderConfig.description);
    },
    error: (e) => {
      failure = e;
    },
  });
  encoder.configure(config);
  const STEP = rate; // 1 秒ぶんずつ
  for (let start = 0; start < total && !failure; start += STEP) {
    const n = Math.min(STEP, total - start);
    const planar = new Float32Array(n * channels.length);
    channels.forEach((ch, c) => planar.set(ch.subarray(start, start + n), c * n));
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: rate,
      numberOfFrames: n,
      numberOfChannels: channels.length,
      timestamp: Math.round((start * 1e6) / rate),
      data: planar,
    });
    encoder.encode(data);
    data.close();
    while (encoder.encodeQueueSize > 4 && !failure) await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
    if (onProgress) onProgress(Math.min(1, (start + n) / total));
    await tick();
  }
  if (!failure) await encoder.flush();
  encoder.close();
  if (failure) throw new Error(`圧縮できませんでした(${failure.message || failure})`);
  return { packets, description };
}
