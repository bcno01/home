import { playChord } from "./audio.js";
import { buildKey, relativeKey, transposeKey, capoOptions, shiftText, KEY_CHOICES, FUNCTION_LABEL } from "./theory.js";

const MINUS = "−";
const SHIFT_MAX = 6;

const tonicsEl = document.getElementById("ky-tonics");
const modeEl = document.getElementById("ky-mode");
const summaryEl = document.getElementById("ky-summary");
const pianoEl = document.getElementById("ky-piano");
const chordsEl = document.getElementById("ky-chords");

const shiftEl = document.getElementById("ky-shift");
const downBtn = document.getElementById("ky-down");
const upBtn = document.getElementById("ky-up");
const targetEl = document.getElementById("ky-target");
const moveSummaryEl = document.getElementById("ky-move-summary");
const pianoToEl = document.getElementById("ky-piano-to");
const mapEl = document.getElementById("ky-map");
const capoEl = document.getElementById("ky-capo");

const state = { pc: 0, mode: "major", shift: 0 };

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// --- 鍵盤(C から次の C まで。音階の音に色が付く。主音は濃く) ---
const WHITE = [0, 2, 4, 5, 7, 9, 11, 12];
const BLACK = [
  { pc: 1, after: 0 },
  { pc: 3, after: 1 },
  { pc: 6, after: 3 },
  { pc: 8, after: 4 },
  { pc: 10, after: 5 },
];

function renderPiano(root, key) {
  const names = new Map(key.notes.map((n) => [n.pc, n.name]));
  root.replaceChildren();
  const keyCell = (pc, cls, left, width) => {
    const k = el("span", `ky-key ${cls}`);
    k.style.left = `${left}%`;
    k.style.width = `${width}%`;
    const base = pc % 12;
    if (names.has(base)) {
      k.classList.add("on");
      if (base === key.pc) k.classList.add("root");
      k.appendChild(el("b", "", names.get(base)));
    }
    return k;
  };
  const w = 100 / WHITE.length;
  WHITE.forEach((pc, i) => root.appendChild(keyCell(pc, "white", i * w, w)));
  for (const b of BLACK) root.appendChild(keyCell(b.pc, "black", (b.after + 1) * w - w * 0.3, w * 0.6));
}

// コード名のボタン。押すと、そのコードが鳴る(kind: "triad" = 三和音、"seventh" = 四和音)
function chordButton(cls, chord, kind) {
  const b = el("button", `ky-play ${cls}`, kind === "triad" ? chord.triad : chord.seventh);
  b.type = "button";
  b.setAttribute("aria-label", `${b.textContent} を鳴らす`);
  b.addEventListener("click", () => {
    if (!playChord(chord.rootPc, kind === "triad" ? chord.triadSemis : chord.seventhSemis)) return;
    b.classList.add("is-playing");
    setTimeout(() => b.classList.remove("is-playing"), 650);
  });
  return b;
}

// --- コードの並び(ダイアトニック。ローマ数字・三和音・四和音・働き) ---
function renderChords(root, key) {
  root.replaceChildren();
  for (const c of key.chords) {
    const card = el("div", `ky-chord f-${c.func}`);
    card.appendChild(el("span", "ky-roman", c.roman));
    card.appendChild(chordButton("ky-triad", c, "triad"));
    card.appendChild(chordButton("ky-seventh", c, "seventh"));
    card.appendChild(el("span", "ky-func", FUNCTION_LABEL[c.func]));
    root.appendChild(card);
  }
}

// --- 移調後のコード(元 → 先) ---
function renderMap(from, to) {
  mapEl.replaceChildren();
  from.chords.forEach((c, i) => {
    const d = to.chords[i];
    const card = el("div", `ky-chord f-${c.func}`);
    card.appendChild(el("span", "ky-roman", c.roman));
    card.appendChild(chordButton("ky-from", c, "triad"));
    card.appendChild(el("span", "ky-arrow", "↓"));
    card.appendChild(chordButton("ky-triad", d, "triad"));
    card.appendChild(chordButton("ky-seventh", d, "seventh"));
    mapEl.appendChild(card);
  });
}

function renderCapo(to) {
  const opts = capoOptions(to);
  capoEl.replaceChildren();
  for (const o of opts) {
    const chip = el("span", "ky-capo-chip");
    chip.append(el("b", "", o.capo === 0 ? "カポなし" : `カポ ${o.capo}`), el("span", "", `${o.shape} のフォーム`));
    capoEl.appendChild(chip);
  }
  if (opts.length === 0) capoEl.textContent = "開放弦のコードの形で弾ける位置は、ありません。";
}

function fmtShift(n) {
  return n === 0 ? "0" : `${n > 0 ? "+" : MINUS}${Math.abs(n)}`;
}

function render() {
  const key = buildKey(state.pc, state.mode);
  const rel = relativeKey(key);
  const to = transposeKey(key, state.shift);

  // キー: 主音のボタン(長調と短調で、綴りが変わる: D♭ / C♯)
  tonicsEl.replaceChildren();
  KEY_CHOICES(state.mode).forEach((k, pc) => {
    const b = el("button", "ky-chip", k.tonic);
    b.type = "button";
    b.setAttribute("aria-pressed", String(pc === key.pc));
    b.addEventListener("click", () => {
      state.pc = pc;
      render();
    });
    tonicsEl.appendChild(b);
  });
  for (const b of modeEl.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));

  summaryEl.replaceChildren();
  summaryEl.append(
    el("b", "", key.name),
    el("span", "", `調号 ${key.signatureText}`),
    el("span", "", `平行調 ${rel.name}`),
    el("span", "ky-scale", `音階 ${key.notes.map((n) => n.name).join(" ")}`)
  );
  renderPiano(pianoEl, key);
  renderChords(chordsEl, key);

  // 移調
  shiftEl.textContent = fmtShift(state.shift);
  downBtn.disabled = state.shift <= -SHIFT_MAX;
  upBtn.disabled = state.shift >= SHIFT_MAX;
  targetEl.replaceChildren();
  KEY_CHOICES(state.mode).forEach((k, pc) => {
    const o = el("option", "", k.name);
    o.value = String(pc);
    targetEl.appendChild(o);
  });
  targetEl.value = String(to.pc);

  moveSummaryEl.replaceChildren();
  if (state.shift === 0) {
    moveSummaryEl.append(el("span", "", "移調しません(元のキーのまま)"));
  } else {
    moveSummaryEl.append(el("b", "", `${key.name} → ${to.name}`), el("span", "", `半音 ${fmtShift(state.shift)}(${shiftText(state.shift)})`));
  }
  renderPiano(pianoToEl, to);
  renderMap(key, to);
  renderCapo(to);
}

modeEl.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b || b.dataset.mode === state.mode) return;
  state.mode = b.dataset.mode;
  render();
});
downBtn.addEventListener("click", () => {
  state.shift = Math.max(-SHIFT_MAX, state.shift - 1);
  render();
});
upBtn.addEventListener("click", () => {
  state.shift = Math.min(SHIFT_MAX, state.shift + 1);
  render();
});
// 「移したいキー」を選ぶと、近い方向(−5〜+6)の半音数にする
targetEl.addEventListener("change", () => {
  const targetPc = Number(targetEl.value);
  const from = buildKey(state.pc, state.mode).pc;
  let s = (((targetPc - from) % 12) + 12) % 12;
  if (s > SHIFT_MAX) s -= 12;
  state.shift = s;
  render();
});

render();
