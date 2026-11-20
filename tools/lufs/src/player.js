// 原音/ノーマライズ後をワンクリック切り替えられるA/Bプレビュー再生。
// VST版と同様、同じ音声を止めずにGainNodeの値だけをランプ切り替えすることでクリックノイズを防ぐ。

const GAIN_RAMP_SECONDS = 0.08;

export class AbPlayer {
  constructor(audioBuffer) {
    this.audioBuffer = audioBuffer;
    this.ctx = null;
    this.source = null;
    this.gainNode = null;
    this.normalizeGainLinear = 1;
    this.normalized = false;
    this.startedAtContextTime = 0;
    this.startedAtOffset = 0;
    this.playing = false;
    this.onEnded = null;
  }

  setNormalizeGainDb(db) {
    this.normalizeGainLinear = Math.pow(10, db / 20);
    if (this.gainNode && this.normalized) this._rampTo(this.normalizeGainLinear);
  }

  setNormalized(normalized) {
    this.normalized = normalized;
    if (this.gainNode) this._rampTo(normalized ? this.normalizeGainLinear : 1);
  }

  _ensureContext() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return this.ctx;
  }

  _rampTo(value) {
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
    this.gainNode.gain.linearRampToValueAtTime(value, now + GAIN_RAMP_SECONDS);
  }

  play(offsetSeconds = 0) {
    const ctx = this._ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    this.stop();

    const source = ctx.createBufferSource();
    source.buffer = this.audioBuffer;
    const gainNode = ctx.createGain();
    gainNode.gain.value = this.normalized ? this.normalizeGainLinear : 1;
    source.connect(gainNode).connect(ctx.destination);
    source.onended = () => {
      if (this.source === source) {
        this.playing = false;
        if (this.onEnded) this.onEnded();
      }
    };

    const clampedOffset = Math.max(0, Math.min(offsetSeconds, this.audioBuffer.duration));
    source.start(0, clampedOffset);
    this.source = source;
    this.gainNode = gainNode;
    this.startedAtContextTime = ctx.currentTime;
    this.startedAtOffset = clampedOffset;
    this.playing = true;
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch (e) {
        /* すでに停止済みの場合は無視 */
      }
      this.source = null;
    }
    this.playing = false;
  }

  getCurrentOffset() {
    if (!this.playing || !this.ctx) return this.startedAtOffset;
    return this.startedAtOffset + (this.ctx.currentTime - this.startedAtContextTime);
  }
}
