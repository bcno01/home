// ITU-R BS.1770-4準拠のIntegrated LUFSと、EBU Tech 3342準拠のLRA(Loudness Range)を
// デコード済みの音声データ全体から一括計算する。
//
// アルゴリズムはVST版(LufsNormalizer/Source/LufsMeter.cpp)と同一(libebur128準拠)で、
// Momentary/Short-termのリアルタイム値だけは使わないため省いている:
//   - Kウェイティング = プレフィルタ(ハイシェルフ)+ RLBフィルタ(ハイパス)の2段バイクアッド。
//     係数はサンプルレートに応じてバイリニア変換で毎回計算する
//   - 100msサブブロック単位でエネルギー(2乗和)を積算し、400ms窓を100msごとにスライドさせて
//     絶対ゲート(-70LUFS)を通過したブロックをIntegrated用に蓄積、その平均から相対ゲート(-10LU)を
//     計算し直して2パス目の平均からLUFSを求める
//   - LRAは3000ms窓のShort-term値を1000msごとにサンプリングし、絶対ゲート(-70LUFS)通過分の
//     分布から相対ゲート(-20LU)を計算、残った分布の10/95パーセンタイルの差をLUで求める

const SILENCE_FLOOR_LUFS = -100;
const ABSOLUTE_GATE_ENERGY = Math.pow(10, (-70 + 0.691) / 10);
const RELATIVE_GATE_FACTOR = 0.1; // Integrated: 相対ゲート -10 LU
const LRA_RELATIVE_GATE_FACTOR = 0.01; // LRA: 相対ゲート -20 LU(Integratedとは異なる)

const SHORT_TERM_SUB_BLOCKS = 30; // 3000ms / 100ms
const MOMENTARY_SUB_BLOCKS = 4; // 400ms / 100ms

// 処理を分割してUIスレッドに制御を返す間隔(サンプル数)
const YIELD_EVERY_SAMPLES = 200000;

function makeBiquad() {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 };
}

function processSample(bq, x) {
  const y = bq.b0 * x + bq.z1;
  bq.z1 = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2 = bq.b2 * x - bq.a2 * y;
  return y;
}

// BS.1770-4の48kHz用係数(アナログプロトタイプから逆算した値、libebur128準拠)を
// バイリニア変換で任意のサンプルレート向けに再計算する
function makeKWeightingFilters(sampleRate) {
  const f0Pre = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q1 = 0.7071752369554196;

  const k1 = Math.tan((Math.PI * f0Pre) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0Pre = 1 + k1 / q1 + k1 * k1;

  const pre = makeBiquad();
  pre.b0 = (vh + (vb * k1) / q1 + k1 * k1) / a0Pre;
  pre.b1 = (2 * (k1 * k1 - vh)) / a0Pre;
  pre.b2 = (vh - (vb * k1) / q1 + k1 * k1) / a0Pre;
  pre.a1 = (2 * (k1 * k1 - 1)) / a0Pre;
  pre.a2 = (1 - k1 / q1 + k1 * k1) / a0Pre;

  const f0Rlb = 38.13547087602444;
  const q2 = 0.5003270373238773;
  const k2 = Math.tan((Math.PI * f0Rlb) / sampleRate);
  const a0Rlb = 1 + k2 / q2 + k2 * k2;

  const rlb = makeBiquad();
  rlb.b0 = 1;
  rlb.b1 = -2;
  rlb.b2 = 1;
  rlb.a1 = (2 * (k2 * k2 - 1)) / a0Rlb;
  rlb.a2 = (1 - k2 / q2 + k2 * k2) / a0Rlb;

  return { pre, rlb };
}

function energyToLoudness(energy) {
  if (energy <= 0) return SILENCE_FLOOR_LUFS;
  return 10 * Math.log10(energy) - 0.691;
}

// (N-1)*p + 0.5 を切り捨てて添字にする(libebur128準拠のパーセンタイル計算)
function percentileIndex(startIndex, n, p) {
  return startIndex + Math.floor((n - 1) * p + 0.5);
}

/**
 * @param {Float32Array[]} channelData チャンネルごとの全サンプル(AudioBuffer.getChannelData())
 * @param {number} sampleRate
 * @param {(ratio: number) => void} [onProgress] 0〜1の進捗を随時通知(UIを固めないためawaitで刻む)
 * @returns {Promise<{ integratedLufs: number, loudnessRangeLu: number, samplePeakLinear: number }>}
 */
export async function analyzeLoudness(channelData, sampleRate, onProgress) {
  const numChannels = channelData.length;
  const numSamples = numChannels > 0 ? channelData[0].length : 0;
  const samplesPer100ms = Math.max(1, Math.round(sampleRate / 10));

  const filters = [];
  for (let ch = 0; ch < numChannels; ch++) filters.push(makeKWeightingFilters(sampleRate));

  const subBlockRing = new Float64Array(SHORT_TERM_SUB_BLOCKS);
  let subBlockRingPos = 0;
  let subBlocksFilled = 0;

  const gatedBlockEnergies = [];
  const lraShortTermEnergies = [];
  let lraSubBlockCounter = 10; // 10から始め、最初のShort-term安定(3000ms)時点で即サンプリングされるようにする

  let currentSubBlockSum = 0;
  let currentSubBlockSampleCount = 0;
  let samplePeakLinear = 0;
  let sinceYield = 0;

  function sumLastN(n) {
    let sum = 0;
    let idx = subBlockRingPos;
    for (let i = 0; i < n; i++) {
      idx = (idx - 1 + SHORT_TERM_SUB_BLOCKS) % SHORT_TERM_SUB_BLOCKS;
      sum += subBlockRing[idx];
    }
    return sum;
  }

  for (let i = 0; i < numSamples; i++) {
    let sampleEnergy = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const x = channelData[ch][i];
      const ax = x < 0 ? -x : x;
      if (ax > samplePeakLinear) samplePeakLinear = ax;

      let y = processSample(filters[ch].pre, x);
      y = processSample(filters[ch].rlb, y);
      sampleEnergy += y * y; // L/Rはチャンネル重み1.0(BS.1770-4)
    }

    currentSubBlockSum += sampleEnergy;

    if (++currentSubBlockSampleCount >= samplesPer100ms) {
      subBlockRing[subBlockRingPos] = currentSubBlockSum;
      subBlockRingPos = (subBlockRingPos + 1) % SHORT_TERM_SUB_BLOCKS;
      subBlocksFilled = Math.min(subBlocksFilled + 1, SHORT_TERM_SUB_BLOCKS);
      currentSubBlockSum = 0;
      currentSubBlockSampleCount = 0;

      if (subBlocksFilled >= MOMENTARY_SUB_BLOCKS) {
        const energy = sumLastN(MOMENTARY_SUB_BLOCKS) / (MOMENTARY_SUB_BLOCKS * samplesPer100ms);
        if (energy >= ABSOLUTE_GATE_ENERGY) gatedBlockEnergies.push(energy);
      }

      if (subBlocksFilled >= SHORT_TERM_SUB_BLOCKS) {
        const energy = sumLastN(SHORT_TERM_SUB_BLOCKS) / (SHORT_TERM_SUB_BLOCKS * samplesPer100ms);
        if (++lraSubBlockCounter >= 10) {
          lraSubBlockCounter = 0;
          if (energy >= ABSOLUTE_GATE_ENERGY) lraShortTermEnergies.push(energy);
        }
      }
    }

    if (++sinceYield >= YIELD_EVERY_SAMPLES) {
      sinceYield = 0;
      if (onProgress) onProgress(i / numSamples);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(1);

  let integratedLufs = SILENCE_FLOOR_LUFS;
  if (gatedBlockEnergies.length > 0) {
    let sum = 0;
    for (const e of gatedBlockEnergies) sum += e;
    const relativeThreshold = (sum / gatedBlockEnergies.length) * RELATIVE_GATE_FACTOR;

    let gatedSum = 0;
    let count = 0;
    for (const e of gatedBlockEnergies) {
      if (e >= relativeThreshold) {
        gatedSum += e;
        count++;
      }
    }
    integratedLufs = count > 0 ? energyToLoudness(gatedSum / count) : SILENCE_FLOOR_LUFS;
  }

  let loudnessRangeLu = 0;
  if (lraShortTermEnergies.length > 0) {
    const sorted = [...lraShortTermEnergies].sort((a, b) => a - b);
    let sum = 0;
    for (const e of sorted) sum += e;
    const relativeThreshold = (sum / sorted.length) * LRA_RELATIVE_GATE_FACTOR;

    let startIndex = 0;
    while (startIndex < sorted.length && sorted[startIndex] < relativeThreshold) startIndex++;

    const n = sorted.length - startIndex;
    if (n > 0) {
      const lowEnergy = sorted[percentileIndex(startIndex, n, 0.1)];
      const highEnergy = sorted[percentileIndex(startIndex, n, 0.95)];
      loudnessRangeLu = energyToLoudness(highEnergy) - energyToLoudness(lowEnergy);
    }
  }

  return { integratedLufs, loudnessRangeLu, samplePeakLinear };
}

export { SILENCE_FLOOR_LUFS };
