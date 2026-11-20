// ステージ全幅に広がるLUFSスケール。縦のグリッド、計測値の針(巨大な数値が乗る)、目標値の線、
// 2つの間隔(=補正ゲイン)を示す帯で構成する。針が動くのは、結果表示時のスイープと、原音/ノーマライズ後の切り替え時のみ。

const MINUS = "−";

export function formatLufs(value) {
  return value.toFixed(1).replace("-", MINUS);
}

function minus(text) {
  return String(text).replace("-", MINUS);
}

export function createRuler(root, { min, max, marks = [], notes = [], unit = "LUFS" }) {
  const range = max - min;
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const pos = (v) => ((clamp(v) - min) / range) * 100;

  let gridHtml = "";
  let tickHtml = "";
  let labelHtml = "";
  for (let v = Math.ceil(min); v <= max; v++) {
    const kind = v % 10 === 0 ? "major" : v % 5 === 0 ? "mid" : "minor";
    tickHtml += `<i class="tick ${kind}" style="left:${pos(v)}%"></i>`;
    if (kind !== "minor") {
      gridHtml += `<i class="grid-line ${kind}" style="left:${pos(v)}%"></i>`;
      labelHtml += `<span class="scale-label ${kind === "major" ? "l10" : "l5"}" style="left:${pos(v)}%">${minus(v)}</span>`;
    }
  }
  const markHtml = marks.map((v) => `<i class="mark" style="left:${pos(v)}%"></i>`).join("");

  // 目標値の注釈(ドロップ前の画面用)。重なりを避けるため、左のものほど長い引き出し線にして段をずらす
  const noteHtml = [...notes]
    .sort((a, b) => a.lufs - b.lufs)
    .map(
      (n, i) => `
      <div class="ruler-note" style="left:${pos(n.lufs)}%; --lvl:${6 + i * 20}px">
        <span class="note-label"><b>${minus(n.lufs)}</b><span class="note-long">${n.label}</span><span class="note-short">${n.short || n.label}</span></span>
      </div>`
    )
    .join("");

  root.classList.add("ruler");
  root.innerHTML = `
    <div class="ruler-plot">
      <div class="ruler-grid">${gridHtml}</div>
      <i class="ruler-gap"></i>
      <div class="ruler-gain"><i class="gain-line"></i><span class="gain-label"><b></b><small>dB</small></span></div>
      <div class="ruler-strip">
        <i class="ruler-gap-strip"></i>
        ${tickHtml}
        ${markHtml}
        <i class="ruler-ghost"></i>
      </div>
      <div class="ruler-labels">${labelHtml}</div>
      <div class="ruler-notes">${noteHtml}</div>
      <div class="ruler-target"><i class="stem"></i><span class="flag"></span></div>
      <div class="ruler-needle">
        <i class="stem"></i>
        <div class="flag">
          <div class="flag-line"><span class="flag-value"></span><span class="flag-unit">${unit}</span></div>
          <span class="flag-label"></span>
        </div>
      </div>
    </div>
  `;

  const plot = root.querySelector(".ruler-plot");
  const gap = root.querySelector(".ruler-gap");
  const gapStrip = root.querySelector(".ruler-gap-strip");
  const gainEl = root.querySelector(".ruler-gain");
  const gainText = gainEl.querySelector("b");
  const ghost = root.querySelector(".ruler-ghost");
  const needle = root.querySelector(".ruler-needle");
  const flag = needle.querySelector(".flag");
  const flagValue = needle.querySelector(".flag-value");
  const flagLabel = needle.querySelector(".flag-label");
  const target = root.querySelector(".ruler-target");
  const targetFlag = target.querySelector(".flag");

  let playingPos = null;

  // 数値の塊は針の右側に置く。収まらなければ左側へ回し、どちらにも収まらない時は余白の広い側に寄せて
  // ステージの内側に収める
  function placeFlag() {
    if (playingPos === null) return;
    const style = getComputedStyle(plot);
    const plotW = plot.clientWidth;
    const x = (playingPos / 100) * plotW;
    const w = flag.offsetWidth;
    const offset = 16;
    const margin = 8;
    const roomRight = plotW + (parseFloat(style.right) || 0) - margin - (x + offset);
    const roomLeft = x + (parseFloat(style.left) || 0) - margin - offset;

    const flip = w > roomRight && roomLeft > roomRight;
    const room = flip ? roomLeft : roomRight;
    const overflow = Math.max(0, w - room);
    flag.classList.toggle("flip", flip);
    // 右置きの基準位置は +offset、左置きは -(w + offset)。はみ出し分だけ内側へ戻す
    const shift = flip ? -(w + offset * 2) + overflow : -overflow;
    flag.style.transform = shift ? `translateX(${shift}px)` : "";
  }

  // gainText: 補正ゲインの文字(例「+3.2」)。2つの針の間に、寸法線と一緒に出る
  function update({ measured = null, playing = null, targetLufs = null, targetName = "", playingLabel = "", gainText: gainLabel = "" }, { sweep = false } = {}) {
    const hasNeedle = playing !== null;
    const hasTarget = targetLufs !== null;
    const hasGap = measured !== null && hasTarget;

    if (sweep && hasNeedle) {
      needle.style.transition = "none";
      flag.style.transition = "none";
      needle.style.left = "0%";
      flag.style.transform = "";
      gap.style.opacity = "0";
      gapStrip.style.opacity = "0";
      gainEl.style.opacity = "0";
      needle.getBoundingClientRect();
      needle.style.transition = "";
      flag.style.transition = "";
      gap.style.opacity = "";
      gapStrip.style.opacity = "";
      gainEl.style.opacity = "";
    }

    needle.classList.toggle("is-hidden", !hasNeedle);
    playingPos = hasNeedle ? pos(playing) : null;
    if (hasNeedle) {
      needle.style.left = `${playingPos}%`;
      flagValue.textContent = formatLufs(playing);
      flagLabel.textContent = playingLabel;
      placeFlag();
    }

    target.classList.toggle("is-hidden", !hasTarget);
    if (hasTarget) {
      target.style.left = `${pos(targetLufs)}%`;
      targetFlag.textContent = `${targetName ? targetName + " " : ""}${formatLufs(targetLufs)}`;
    }

    gap.classList.toggle("is-hidden", !hasGap);
    gapStrip.classList.toggle("is-hidden", !hasGap);
    if (hasGap) {
      const a = pos(measured);
      const b = pos(targetLufs);
      for (const el of [gap, gapStrip, gainEl]) {
        el.style.left = `${Math.min(a, b)}%`;
        el.style.width = `${Math.abs(a - b)}%`;
      }
      gainEl.classList.toggle("to-left", b < a); // 矢じりは、目標の側(下げるときは左)に付く
      gainText.textContent = gainLabel;
    }
    gainEl.classList.toggle("is-hidden", !hasGap || !gainLabel);

    const showGhost = measured !== null && hasNeedle && Math.abs(playing - measured) > 0.05;
    ghost.classList.toggle("is-hidden", !showGhost);
    if (showGhost) ghost.style.left = `${pos(measured)}%`;

    if (hasNeedle && hasTarget) {
      root.setAttribute("role", "img");
      root.setAttribute("aria-label", `${playingLabel} ${formatLufs(playing)} LUFS、目標 ${formatLufs(targetLufs)} LUFS${gainLabel ? `、補正ゲイン ${gainLabel} dB` : ""}`);
    } else {
      root.setAttribute("role", "presentation");
      root.removeAttribute("aria-label");
    }
  }

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(placeFlag).observe(plot);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeFlag);

  update({});
  return { update };
}
