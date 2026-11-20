// コードの音を、その場で合成して鳴らす(音源のファイルは使わない)。
// 柔らかい電子ピアノのような音: 三角波 + 1オクターブ上の正弦波を、ローパスに通して、指数的に減衰させる。
// scheduleChord は、OfflineAudioContext でも使える(音量の確認ができる)。

const A4 = 440;
const ROOT_BASE_MIDI = 48; // 根音は C3〜B3 の範囲に置く
const midiToHz = (m) => A4 * Math.pow(2, (m - 69) / 12);

/** 根音(0〜11)と半音の並びから、鳴らす音の高さ(MIDI)にする。低い根音(ベース)を、1オクターブ下に足す */
export function chordMidi(rootPc, semis) {
  const root = ROOT_BASE_MIDI + (((rootPc % 12) + 12) % 12);
  return [root - 12, ...semis.map((s) => root + s)];
}

/**
 * @returns {{ stop: (fade?: number) => void, end: number }}
 */
export function scheduleChord(ctx, destination, rootPc, semis, when = ctx.currentTime) {
  const midi = chordMidi(rootPc, semis);
  const out = ctx.createGain();
  out.gain.value = 1;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2600;
  lp.Q.value = 0.3;
  lp.connect(out);
  out.connect(destination);

  const DUR = 2.2;
  const oscs = [];
  midi.forEach((m, i) => {
    const t0 = when + i * 0.014; // 少しずつずらして、ストラムのように
    const f = midiToHz(m);
    const peak = (i === 0 ? 0.42 : 0.3) / Math.sqrt(midi.length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + DUR);
    env.connect(lp);
    for (const [type, mult, level] of [["triangle", 1, 1], ["sine", 2, 0.28]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g);
      g.connect(env);
      o.start(t0);
      o.stop(t0 + DUR + 0.05);
      oscs.push(o);
    }
  });

  return {
    end: when + DUR + 0.1,
    // 次のコードを鳴らすとき、いまの音を、短く消す
    stop(fade = 0.09) {
      const t = ctx.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setValueAtTime(out.gain.value, t);
      out.gain.linearRampToValueAtTime(0, t + fade);
      for (const o of oscs) {
        try {
          o.stop(t + fade + 0.02);
        } catch (e) {
          /* すでに止まっている */
        }
      }
    },
  };
}

let ctx = null;
let master = null;
let current = null;

function getContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createDynamicsCompressor(); // 重なっても、割れにくく
    master.threshold.value = -14;
    master.ratio.value = 4;
    const vol = ctx.createGain();
    vol.gain.value = 0.9;
    master.connect(vol);
    vol.connect(ctx.destination);
  }
  return ctx;
}

/** コードを鳴らす。押された瞬間(ユーザーの操作の中)で呼ぶこと。鳴らせたら true */
export function playChord(rootPc, semis) {
  const c = getContext();
  if (!c) return false;
  if (c.state === "suspended") c.resume();
  if (current) current.stop();
  current = scheduleChord(c, master, rootPc, semis);
  return true;
}
