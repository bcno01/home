import { analyzeLoudness } from "./lufsMeter.js";
import { TARGET_PRESETS, GAIN_CLAMP_DB, CUSTOM_DEFAULT_LUFS, CUSTOM_MIN_LUFS, CUSTOM_MAX_LUFS } from "./presets.js";
import { AbPlayer } from "./player.js";
import { createRuler, formatLufs } from "./ruler.js";
import { analyzeDelivery, evaluateChecks } from "./checks.js";

const stage = document.getElementById("stage"); // .lf-stage
const fileInput = document.getElementById("file-input");
const browseButton = document.getElementById("browse-button");

const analyzeFilename = document.getElementById("analyze-filename");
const analyzePercent = document.getElementById("analyze-percent");
const analyzeBar = document.getElementById("analyze-bar");
const analyzeLabel = document.getElementById("analyze-label");

const deck = document.getElementById("app-section");
const checksSection = document.getElementById("checks-section");
const checkListEl = document.getElementById("check-list");
const checksSummaryEl = document.getElementById("checks-summary");
const silentNote = document.getElementById("silent-note");
const fileInfoEl = document.getElementById("file-info");

const lraValueEl = document.getElementById("lra-value");

const targetListEl = document.getElementById("target-list");

const clipWarningEl = document.getElementById("clip-warning");

const abOriginalButton = document.getElementById("ab-original");
const abNormalizedButton = document.getElementById("ab-normalized");
const playButton = document.getElementById("play-button");
const playLabel = document.getElementById("play-label");

const resetButton = document.getElementById("reset-button");

let currentFile = null;
let audioBuffer = null;
let analysis = null; // { integratedLufs, loudnessRangeLu, samplePeakLinear }
let delivery = null; // 配信前チェックの計測結果(checks.js)
let selectedPresetId = TARGET_PRESETS[0].id;
let currentGainDb = 0;
let normalized = false;
let abPlayer = null;

const RULER_MIN = CUSTOM_MIN_LUFS;
const RULER_MAX = CUSTOM_MAX_LUFS;
const presetMarks = TARGET_PRESETS.filter((p) => p.lufs !== null).map((p) => p.lufs);
const presetNotes = TARGET_PRESETS.filter((p) => p.lufs !== null).map((p) => ({ lufs: p.lufs, label: p.label, short: p.short || p.label }));
const stageRuler = createRuler(document.getElementById("stage-ruler"), {
  min: RULER_MIN,
  max: RULER_MAX,
  marks: presetMarks,
  notes: presetNotes,
});


function showView(name) {
  stage.dataset.state = name === "drop" ? "idle" : name === "analyze" ? "analyzing" : "ready";
  deck.classList.toggle("hidden", name !== "app");
  checksSection.classList.toggle("hidden", name !== "app");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSignedDb(db) {
  const rounded = Math.round(db * 10) / 10;
  if (rounded === 0) return "0.0";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)}`;
}

function setPlayState(playing) {
  playButton.classList.toggle("is-playing", playing);
  playLabel.textContent = playing ? "停止" : "再生";
}

function updateRuler(options) {
  const measured = analysis && analysis.integratedLufs > -99 ? analysis.integratedLufs : null;
  silentNote.classList.toggle("hidden", !analysis || measured !== null);
  stageRuler.update(
    {
      measured,
      playing: measured === null ? null : measured + (normalized ? currentGainDb : 0),
      playingLabel: normalized ? "ノーマライズ後" : "Integrated",
      targetLufs: measured === null ? null : getCurrentTargetLufs(),
      targetName: "目標",
      gainText: formatSignedDb(currentGainDb),
    },
    options
  );
}

// --- 1. ファイル読み込み〜解析フェーズ ---

async function handleFile(file) {
  clearSession();
  currentFile = file;

  analyzeFilename.textContent = file.name;
  analyzeLabel.textContent = "読み込み中…";
  analyzeBar.style.width = "0%";
  analyzePercent.textContent = "0";
  showView("analyze");

  try {
    const arrayBuffer = await file.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
    decodeCtx.close();

    analyzeLabel.textContent = "LUFS/LRAを計測中…";

    const channelData = [];
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      channelData.push(audioBuffer.getChannelData(ch));
    }

    analysis = await analyzeLoudness(channelData, audioBuffer.sampleRate, (ratio) => {
      const percent = Math.round(ratio * 100);
      analyzeBar.style.width = `${percent}%`;
      analyzePercent.textContent = String(percent);
    });

    analyzeLabel.textContent = "配信前チェック中…";
    delivery = await analyzeDelivery(channelData, audioBuffer.sampleRate);

    abPlayer = new AbPlayer(audioBuffer);
    renderResult(file);
    showView("app");
  } catch (err) {
    console.error(err);
    alert("音声ファイルとして読み込めませんでした。対応形式か確認してください。");
    showView("drop");
  }
}

// --- 2. 結果表示・ノーマライズ設定 ---

function renderResult(file) {
  fileInfoEl.innerHTML = `
    <span class="name"></span>
    <span class="lf-meta"><span>${formatDuration(audioBuffer.duration)}</span><span>${audioBuffer.sampleRate} Hz</span><span>${audioBuffer.numberOfChannels}ch</span><span>${formatBytes(file.size)}</span></span>
  `;
  // ファイル名は利用者が決めた文字列なので、HTMLとして解釈されないようtextContentで入れる
  fileInfoEl.querySelector(".name").textContent = file.name;

  lraValueEl.textContent = analysis.loudnessRangeLu.toFixed(1);
  renderChecks(file);

  setNormalized(false);
  setPlayState(false);
  updateGain({ sweep: true });
}

// 配信前チェックの一覧。値はすべて、こちらで決めた文字列だが、念のため textContent で入れる
function renderChecks(file) {
  const rows = evaluateChecks(delivery, file.name);
  const warns = rows.filter((r) => r.state === "warn").length;
  checksSummaryEl.textContent = warns === 0 ? "目安の範囲に収まっています" : `確認したい項目が ${warns} 件あります`;
  checksSummaryEl.classList.toggle("is-warn", warns > 0);
  checkListEl.replaceChildren();
  const stateLabel = { ok: "OK", warn: "確認", info: "参考" };
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = `check is-${row.state}`;
    const parts = [
      ["check-state", stateLabel[row.state]],
      ["check-name", row.name],
      ["check-value", row.value],
      ["check-hint", row.hint],
    ];
    for (const [cls, text] of parts) {
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text;
      li.appendChild(span);
    }
    checkListEl.appendChild(li);
  }
}

const targetButtons = new Map();
let customLufs = CUSTOM_DEFAULT_LUFS; // 「カスタム」に入れた、いまの目標(LUFS)

function selectPreset(id) {
  if (selectedPresetId === id) return;
  selectedPresetId = id;
  syncTargetSelection();
  updateGain();
}

// 「カスタム」: 名前のボタンと、数値の入力欄を、ひとつの枠に並べる。どちらを触っても、この枠が選ばれる
function buildCustomSegment(preset) {
  const box = document.createElement("div");
  box.className = "segment segment-custom";

  const label = document.createElement("button");
  label.type = "button";
  label.className = "seg-label";
  label.textContent = preset.label;

  const input = document.createElement("input");
  input.type = "number";
  input.className = "custom-input";
  input.inputMode = "decimal";
  input.min = String(CUSTOM_MIN_LUFS);
  input.max = String(CUSTOM_MAX_LUFS);
  input.step = "0.1";
  input.value = customLufs.toFixed(1);
  input.setAttribute("aria-label", "カスタムの目標ラウドネス(LUFS)");

  const unit = document.createElement("span");
  unit.className = "seg-unit";
  unit.textContent = "LUFS";

  box.append(label, input, unit);

  const inRange = (v) => Number.isFinite(v) && v >= CUSTOM_MIN_LUFS && v <= CUSTOM_MAX_LUFS;
  const setInvalid = (invalid) => {
    box.classList.toggle("is-invalid", invalid);
    input.setAttribute("aria-invalid", String(invalid));
  };

  label.addEventListener("click", () => {
    selectPreset(preset.id);
    input.focus();
    input.select();
  });
  input.addEventListener("focus", () => selectPreset(preset.id));
  // 打っている途中(「−」だけ、など)は、何もしない。範囲に入った数値になったときだけ、すぐ反映する
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    setInvalid(!inRange(v));
    if (inRange(v)) {
      customLufs = v;
      if (selectedPresetId === preset.id) updateGain();
    }
  });
  // 入力を終えたら、範囲に収めて、小数1桁にそろえる(空や範囲外は、直前の有効な値に近づける)
  input.addEventListener("change", () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) v = customLufs;
    v = Math.min(CUSTOM_MAX_LUFS, Math.max(CUSTOM_MIN_LUFS, v));
    customLufs = v;
    input.value = v.toFixed(1);
    setInvalid(false);
    if (selectedPresetId === preset.id) updateGain();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  return box;
}

function buildTargetList() {
  for (const preset of TARGET_PRESETS) {
    let el;
    if (preset.custom) {
      el = buildCustomSegment(preset);
    } else {
      el = document.createElement("button");
      el.type = "button";
      el.className = "segment";
      const label = document.createElement("span");
      label.textContent = preset.label;
      const value = document.createElement("span");
      value.className = "segment-value";
      value.textContent = formatLufs(preset.lufs).replace(".0", "");
      el.append(label, value);
      el.addEventListener("click", () => selectPreset(preset.id));
    }
    targetButtons.set(preset.id, el);
    targetListEl.appendChild(el);
  }
  syncTargetSelection();
}

function syncTargetSelection() {
  for (const [id, el] of targetButtons) {
    const active = id === selectedPresetId;
    el.classList.toggle("active", active);
    const pressable = el.matches("button") ? el : el.querySelector("button");
    if (pressable) pressable.setAttribute("aria-pressed", String(active));
  }
}

buildTargetList();

function getCurrentTargetLufs() {
  const preset = TARGET_PRESETS.find((p) => p.id === selectedPresetId);
  return preset.custom ? customLufs : preset.lufs;
}

function updateGain(rulerOptions) {
  const target = getCurrentTargetLufs();

  // 計測不能なほど無音に近い場合、目標値との差分をそのまま適用すると非現実的な大ゲインになるため
  // ユニティゲイン(0dB)にしておく(VST版と同じ考え方)
  currentGainDb =
    analysis.integratedLufs > -99
      ? Math.max(-GAIN_CLAMP_DB, Math.min(GAIN_CLAMP_DB, target - analysis.integratedLufs))
      : 0;

  if (abPlayer) abPlayer.setNormalizeGainDb(currentGainDb);

  const resultingPeakDb =
    analysis.samplePeakLinear > 0 ? 20 * Math.log10(analysis.samplePeakLinear) + currentGainDb : -Infinity;
  clipWarningEl.classList.toggle("hidden", resultingPeakDb <= 0);
  updateRuler(rulerOptions);
}

// --- 3. A/B試聴 ---

function setNormalized(value) {
  normalized = value;
  abOriginalButton.classList.toggle("active", !normalized);
  abNormalizedButton.classList.toggle("active", normalized);
  abOriginalButton.setAttribute("aria-pressed", String(!normalized));
  abNormalizedButton.setAttribute("aria-pressed", String(normalized));
  if (abPlayer) abPlayer.setNormalized(normalized);
  if (analysis) updateRuler();
}

abOriginalButton.addEventListener("click", () => setNormalized(false));
abNormalizedButton.addEventListener("click", () => setNormalized(true));

playButton.addEventListener("click", () => {
  if (!abPlayer) return;
  if (abPlayer.playing) {
    abPlayer.stop();
    setPlayState(false);
  } else {
    abPlayer.onEnded = () => setPlayState(false);
    abPlayer.play(0);
    setPlayState(true);
  }
});

// --- 4. ドロップ/ファイル選択 ---

browseButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((eventName) => {
  document.body.addEventListener(eventName, (e) => {
    e.preventDefault();
    document.body.classList.add("app-dragover");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  document.body.addEventListener(eventName, (e) => {
    e.preventDefault();
    if (eventName === "drop") {
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    }
    document.body.classList.remove("app-dragover");
  });
});

function clearSession() {
  if (abPlayer) abPlayer.stop();
  currentFile = null;
  audioBuffer = null;
  analysis = null;
  delivery = null;
  abPlayer = null;
  normalized = false;
  setPlayState(false);
  silentNote.classList.add("hidden");
  stageRuler.update({});
}

resetButton.addEventListener("click", () => {
  clearSession();
  showView("drop");
});
