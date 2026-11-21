// 画面の部品(設定の項目、サイズ・時間の表示)

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export function fmtDuration(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function baseName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function field(label, hint) {
  const root = el("div", "cv-field");
  const head = el("span", "cv-label", label);
  root.appendChild(head);
  const hintEl = el("p", "cv-hint", hint || "");
  return { root, hintEl, setHint: (t) => (hintEl.textContent = t || "") };
}

/** 選択肢のボタンが並んだ項目。options: [{ value, label }] */
export function segField({ label, options, value, onChange, hint, columns }) {
  const f = field(label, hint);
  const group = el("div", columns ? "cv-seg cv-seg-grid" : "cv-seg");
  if (columns) group.style.setProperty("--cols", String(columns));
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  f.root.appendChild(group);
  f.root.appendChild(f.hintEl);
  let current = value;
  const render = (opts) => {
    group.replaceChildren();
    for (const o of opts) {
      const b = el("button", "cv-seg-btn", o.label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(o.value === current));
      b.addEventListener("click", () => {
        if (current === o.value) return;
        current = o.value;
        render(opts);
        onChange(current);
      });
      group.appendChild(b);
    }
  };
  render(options);
  return {
    root: f.root,
    setHint: f.setHint,
    setOptions(opts, v) {
      current = v;
      render(opts);
    },
    set(v) {
      current = v;
      render(options);
    },
    show(on) {
      f.root.hidden = !on;
    },
  };
}

export function checkField({ label, checked, onChange, hint }) {
  const f = field("", hint);
  f.root.removeChild(f.root.firstChild);
  const lab = el("label", "cv-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  lab.append(input, el("span", "", label));
  f.root.append(lab, f.hintEl);
  return { root: f.root, show: (on) => (f.root.hidden = !on) };
}

export function rangeField({ label, min, max, value, onChange, hint, format }) {
  const f = field(label, hint);
  const row = el("div", "cv-range");
  const input = el("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = String(value);
  input.setAttribute("aria-label", label);
  const out = el("output", "cv-range-value", format(value));
  input.addEventListener("input", () => {
    out.textContent = format(Number(input.value));
  });
  input.addEventListener("change", () => onChange(Number(input.value)));
  row.append(input, out);
  f.root.append(row, f.hintEl);
  return { root: f.root, show: (on) => (f.root.hidden = !on) };
}

/** 数字の入力と、よく使う値のボタン */
export function numberField({ label, min, max, value, presets, unit, onChange, hint }) {
  const f = field(label, hint);
  const row = el("div", "cv-num-row");
  const box = el("label", "cv-num");
  const input = el("input");
  input.type = "number";
  input.inputMode = "numeric";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  box.append(input, el("span", "", unit));
  row.appendChild(box);
  const apply = (n) => {
    const v = Math.min(max, Math.max(min, Math.round(n) || min));
    input.value = String(v);
    onChange(v);
  };
  input.addEventListener("change", () => apply(Number(input.value)));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  for (const p of presets || []) {
    const b = el("button", "cv-chip", String(p));
    b.type = "button";
    b.addEventListener("click", () => apply(p));
    row.appendChild(b);
  }
  f.root.append(row, f.hintEl);
  return { root: f.root, show: (on) => (f.root.hidden = !on) };
}

export function colorField({ label, value, onChange, hint }) {
  const f = field(label, hint);
  const row = el("label", "cv-color");
  const input = el("input");
  input.type = "color";
  input.value = value;
  input.setAttribute("aria-label", label);
  const code = el("span", "cv-color-code", value.toUpperCase());
  input.addEventListener("input", () => {
    code.textContent = input.value.toUpperCase();
  });
  input.addEventListener("change", () => onChange(input.value));
  row.append(input, code);
  f.root.append(row, f.hintEl);
  return { root: f.root, show: (on) => (f.root.hidden = !on) };
}
