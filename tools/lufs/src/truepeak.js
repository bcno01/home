// True Peak（ITU-R BS.1770 Annex 2 相当）: 4倍オーバーサンプリングのポリフェーズFIR。
// 129タップ（4相×約32タップ）のKaiser窓つきsinc。位相0は元サンプルそのもの（中心タップ=1）。
// 規格の48タップより長くしているのは、96kHzなどナイキスト付近まで成分があるノイズ状の信号で
// 過小評価（最大0.3dB程度）が出るため。ffmpeg(192kHzへのリサンプル)との差を小さくする。

const FACTOR = 4;
const HALF = 32; // 総タップ数 = 4*HALF+1 = 129
const KAISER_BETA = 9.0;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-18 * sum) break;
  }
  return sum;
}

/** 4相の係数 [[...], ...] を返す。各相は DC ゲイン 1 に正規化。 */
export function designPhases(half = HALF, beta = KAISER_BETA) {
  const taps = FACTOR * half + 1;
  const c = (taps - 1) / 2;
  const h = new Float64Array(taps);
  const i0b = besselI0(beta);
  for (let j = 0; j < taps; j++) {
    const m = j - c;
    const x = m / FACTOR;
    const sinc = m === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = m / c;
    const win = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[j] = sinc * win;
  }
  const phases = [];
  for (let p = 0; p < FACTOR; p++) {
    const coef = [];
    for (let j = p; j < taps; j += FACTOR) coef.push(h[j]);
    const s = coef.reduce((a, b) => a + b, 0);
    phases.push(Float64Array.from(coef.map((v) => v / s)));
  }
  return phases;
}

export class TruePeakMeter {
  constructor() {
    this.phases = designPhases();
    this.taps = Math.max(...this.phases.map((p) => p.length));
    // この係数での最大L1ノルム。これ以下の入力ならピークを更新し得ないので計算を省ける
    this.gain = Math.max(...this.phases.map((p) => p.reduce((a, b) => a + Math.abs(b), 0)));
    this.hist = new Float64Array(this.taps - 1);
    this.work = new Float64Array(0);
    this.peak = 0; // 線形
  }

  process(x, n = x.length) {
    const T = this.taps;
    const need = n + T - 1;
    if (this.work.length < need) this.work = new Float64Array(need);
    const w = this.work;
    w.set(this.hist, 0);
    for (let i = 0; i < n; i++) w[T - 1 + i] = x[i];

    const SEG = 64;
    const [p0, p1, p2, p3] = this.phases;
    const n0 = p0.length, n1 = p1.length, n2 = p2.length, n3 = p3.length;
    let peak = this.peak;
    const g = this.gain;

    for (let s = 0; s < n; s += SEG) {
      const e = Math.min(n, s + SEG);
      // この区間の出力に影響する入力の最大絶対値（履歴T-1サンプル分を含む）
      let m = 0;
      for (let i = s; i < e + T - 1; i++) {
        const a = Math.abs(w[i]);
        if (a > m) m = a;
      }
      if (m * g <= peak) continue;
      for (let i = s; i < e; i++) {
        const base = T - 1 + i;
        let y0 = 0, y1 = 0, y2 = 0, y3 = 0;
        for (let k = 0; k < n0; k++) y0 += p0[k] * w[base - k];
        for (let k = 0; k < n1; k++) y1 += p1[k] * w[base - k];
        for (let k = 0; k < n2; k++) y2 += p2[k] * w[base - k];
        for (let k = 0; k < n3; k++) y3 += p3[k] * w[base - k];
        const a0 = Math.abs(y0), a1 = Math.abs(y1), a2 = Math.abs(y2), a3 = Math.abs(y3);
        if (a0 > peak) peak = a0;
        if (a1 > peak) peak = a1;
        if (a2 > peak) peak = a2;
        if (a3 > peak) peak = a3;
      }
    }
    this.peak = peak;
    this.hist.set(w.subarray(n, n + T - 1));
  }

  /** 末尾の補間を出すためにゼロを流してから、線形値のピークを返す。 */
  finish() {
    this.process(new Float64Array(this.taps), this.taps);
    return this.peak;
  }
}
