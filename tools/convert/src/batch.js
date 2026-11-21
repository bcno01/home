// ファイルの一覧(追加・削除・変換・保存)。音声と画像で、同じ仕組みを使う。
import { el, fmtSize } from "./ui.js";
import { makeZip } from "./zip.js";

const UNSUPPORTED = "読み込めない形式のファイルは、追加しませんでした";

/**
 * @param {object} o
 * @param {HTMLElement} o.panel  .cv-drop / .cv-list / .cv-run / .cv-zip / .cv-clear / .cv-summary を含む要素
 * @param {(f:File)=>boolean} o.accept
 * @param {()=>object} o.getSettings  変換を始めるときの、設定
 * @param {(file:File, settings:object, onProgress:(p:number)=>void)=>Promise<{blob:Blob,name:string,info:string,note?:string}>} o.convertOne
 * @param {string} o.zipName
 * @param {"image"|"audio"} [o.thumbs]  行の左の、正方形(画像: 変換後の画像、音声: 変換後の波形)
 */
export function createBatch({ panel, accept, getSettings, convertOne, zipName, thumbs }) {
  const $ = (s) => panel.querySelector(s);
  const input = $(".cv-input");
  const list = $(".cv-list");
  const runBtn = $(".cv-run");
  const zipBtn = $(".cv-zip");
  const clearBtn = $(".cv-clear");
  const summary = $(".cv-summary");
  const items = [];
  let running = false;
  let notice = "";

  const todoCount = () => items.filter((i) => i.state !== "done").length;
  const doneItems = () => items.filter((i) => i.state === "done");

  function buildRow(item) {
    const li = el("li", "cv-row");
    if (thumbs) {
      const box = el("div", `cv-thumb cv-thumb-${thumbs}`);
      item.thumb = el("img");
      item.thumb.alt = "";
      box.appendChild(item.thumb);
      li.appendChild(box);
    }
    const main = el("div", "cv-main");
    item.nameEl = el("p", "cv-name", item.file.name);
    item.metaEl = el("p", "cv-meta");
    const bar = el("div", "cv-bar");
    item.barEl = el("i");
    bar.appendChild(item.barEl);
    main.append(item.nameEl, item.metaEl, bar);
    const side = el("div", "cv-side");
    item.saveEl = el("a", "cv-btn cv-save", "保存");
    item.removeEl = el("button", "cv-x", "×");
    item.removeEl.type = "button";
    item.removeEl.setAttribute("aria-label", `${item.file.name} をリストから外す`);
    item.removeEl.addEventListener("click", () => remove(item));
    side.append(item.saveEl, item.removeEl);
    li.append(main, side);
    item.li = li;
    return li;
  }

  function paint(item) {
    item.li.dataset.state = item.state;
    const meta = item.metaEl;
    meta.classList.remove("is-error");
    if (item.state === "wait") meta.textContent = fmtSize(item.file.size);
    else if (item.state === "busy") meta.textContent = `変換中… ${Math.round(item.progress * 100)}%`;
    else if (item.state === "error") {
      meta.textContent = item.error;
      meta.classList.add("is-error");
    } else {
      const r = item.result;
      meta.textContent = `${r.info} · ${fmtSize(item.file.size)} → ${fmtSize(r.blob.size)}${r.note ? ` · ${r.note}` : ""}`;
    }
    item.barEl.style.transform = `scaleX(${item.state === "busy" ? Math.max(0.03, item.progress) : 0})`;
    const done = item.state === "done";
    item.saveEl.hidden = !done;
    if (done) {
      item.saveEl.href = item.result.url;
      item.saveEl.download = item.result.name;
      item.saveEl.setAttribute("aria-label", `${item.result.name} を保存`);
      item.nameEl.textContent = item.result.name;
      if (item.thumb) item.thumb.src = item.result.thumb || item.result.url;
    } else {
      item.nameEl.textContent = item.file.name;
      if (item.thumb) item.thumb.removeAttribute("src");
    }
    item.li.querySelector(".cv-thumb")?.classList.toggle("has-img", done);
    item.removeEl.disabled = item.state === "busy";
  }

  function refresh() {
    panel.classList.toggle("has-files", items.length > 0);
    const todo = todoCount();
    const done = doneItems().length;
    runBtn.disabled = running || todo === 0;
    runBtn.textContent = running ? "変換中…" : todo > 0 ? `変換する(${todo} 件)` : "変換する";
    zipBtn.hidden = done < 2 || running;
    clearBtn.hidden = items.length === 0 || running;
    clearBtn.disabled = running;
    if (running) return;
    const failed = items.filter((i) => i.state === "error").length;
    let text = "";
    if (items.length && todo === 0) text = `${done} 件の変換が終わりました。`;
    else if (done > 0 || failed > 0) text = `${done} 件が変換済みです${failed ? `(${failed} 件は、変換できませんでした)` : ""}。`;
    summary.textContent = [text, notice].filter(Boolean).join(" ");
  }

  function revoke(item) {
    if (item.result?.url) URL.revokeObjectURL(item.result.url);
    item.result = null;
  }

  function remove(item) {
    if (item.state === "busy") return;
    revoke(item);
    items.splice(items.indexOf(item), 1);
    item.li.remove();
    notice = "";
    refresh();
  }

  function addFiles(files) {
    const picked = Array.from(files);
    const ok = picked.filter(accept);
    notice = ok.length < picked.length ? `${picked.length - ok.length} 件: ${UNSUPPORTED}。` : "";
    for (const file of ok) {
      const item = { file, state: "wait", progress: 0, result: null, error: "" };
      items.push(item);
      list.appendChild(buildRow(item));
      paint(item);
    }
    refresh();
  }

  async function run() {
    if (running) return;
    const todo = items.filter((i) => i.state !== "done");
    if (!todo.length) return;
    const settings = { ...getSettings() };
    running = true;
    notice = "";
    panel.classList.add("is-running");
    refresh();
    for (const item of todo) {
      item.state = "busy";
      item.progress = 0;
      paint(item);
      try {
        const r = await convertOne(item.file, settings, (p) => {
          item.progress = p;
          item.metaEl.textContent = `変換中… ${Math.round(p * 100)}%`;
          item.barEl.style.transform = `scaleX(${Math.max(0.03, p)})`;
        });
        r.url = URL.createObjectURL(r.blob);
        item.result = r;
        item.state = "done";
      } catch (e) {
        item.state = "error";
        item.error = e?.message || "変換できませんでした。";
      }
      paint(item);
    }
    running = false;
    panel.classList.remove("is-running");
    refresh();
  }

  /** 設定を変えたら、変換済みのものを、「変換前」に戻す(古い設定のままの結果を、残さない) */
  function invalidate() {
    if (running) return;
    for (const item of items) {
      if (item.state === "done" || item.state === "error") {
        revoke(item);
        item.state = "wait";
        paint(item);
      }
    }
    notice = "";
    refresh();
  }

  async function saveZip() {
    const done = doneItems();
    if (done.length < 2) return;
    zipBtn.disabled = true;
    const label = zipBtn.textContent;
    zipBtn.textContent = "まとめています…";
    try {
      const blob = await makeZip(done.map((i) => ({ name: i.result.name, blob: i.result.blob })));
      const url = URL.createObjectURL(blob);
      const a = el("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } finally {
      zipBtn.textContent = label;
      zipBtn.disabled = false;
    }
  }

  // --- 操作 ---
  panel.querySelector(".cv-browse").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });
  runBtn.addEventListener("click", run);
  zipBtn.addEventListener("click", saveZip);
  clearBtn.addEventListener("click", () => {
    if (running) return;
    for (const item of items) revoke(item);
    items.length = 0;
    list.replaceChildren();
    notice = "";
    refresh();
  });
  let depth = 0;
  panel.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth++;
    panel.classList.add("is-over");
  });
  panel.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) panel.classList.remove("is-over");
  });
  panel.addEventListener("dragover", (e) => e.preventDefault());
  panel.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    panel.classList.remove("is-over");
    if (!running && e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  refresh();
  return { invalidate };
}
