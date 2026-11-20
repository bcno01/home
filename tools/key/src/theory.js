// キー・コード・移調の、音楽理論の部分(画面とは分けてある)。
// 音名は、「文字(C D E F G A B)+ 変化記号」で持つので、E♯ や C♭ も正しく綴れる(♯と♭の混在を避ける)。

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11];
const ACC = { "-2": "𝄫", "-1": "♭", "0": "", "1": "♯", "2": "𝄪" };

export function noteName(letterIndex, acc) {
  return LETTERS[letterIndex] + (ACC[String(acc)] ?? "");
}

// 主音の綴り(0〜11 の音高ごと)。よく使われる綴りに固定(長調は ♭ 側に D♭・A♭、短調は C♯・G♯)
const TONICS = {
  major: [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]],
  minor: [[0, 0], [0, 1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [6, -1], [6, 0]],
};

// コードの種類ごとの、根音からの半音(鳴らすときに使う)
const TRIAD_SEMIS = { "": [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6] };
const SEVENTH_SEMIS = { maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], "7": [0, 4, 7, 10], "m7♭5": [0, 3, 6, 10] };

const MODES = {
  major: {
    label: "長調",
    semis: [0, 2, 4, 5, 7, 9, 11],
    triad: ["", "m", "m", "", "", "m", "dim"],
    seventh: ["maj7", "m7", "m7", "maj7", "7", "m7", "m7♭5"],
    roman: ["I", "ii", "iii", "IV", "V", "vi", "vii°"],
    func: ["T", "SD", "T", "SD", "D", "T", "D"],
  },
  minor: {
    label: "短調",
    semis: [0, 2, 3, 5, 7, 8, 10],
    triad: ["m", "dim", "", "m", "m", "", ""],
    seventh: ["m7", "m7♭5", "maj7", "m7", "m7", "maj7", "7"],
    roman: ["i", "ii°", "♭III", "iv", "v", "♭VI", "♭VII"],
    func: ["T", "SD", "T", "SD", "D", "SD", "D"],
  },
};

export const FUNCTION_LABEL = { T: "トニック", SD: "サブドミナント", D: "ドミナント" };

export function modeLabel(mode) {
  return MODES[mode].label;
}

/** 主音(0〜11)と調(major / minor)から、音階とコードの一覧を作る */
export function buildKey(pc, mode) {
  const [tl, ta] = TONICS[mode][pc];
  return buildKeyFromSpelling(tl, ta, mode);
}

/** 主音の綴り(文字の番号と変化記号)から作る。平行調のように、綴りが決まっているときに使う */
export function buildKeyFromSpelling(tl, ta, mode) {
  const m = MODES[mode];
  const tonicPc = (NATURAL_PC[tl] + ta + 12) % 12;
  const notes = m.semis.map((semi, d) => {
    const letter = (tl + d) % 7;
    const notePc = (tonicPc + semi) % 12;
    const acc = ((notePc - NATURAL_PC[letter] + 18) % 12) - 6; // −6〜5 に収める(通常は −2〜2)
    return { letter, acc, pc: notePc, name: noteName(letter, acc) };
  });
  const chords = notes.map((n, d) => ({
    degree: d,
    root: n.name,
    triad: n.name + m.triad[d],
    seventh: n.name + m.seventh[d],
    rootPc: n.pc,
    triadSemis: TRIAD_SEMIS[m.triad[d]],
    seventhSemis: SEVENTH_SEMIS[m.seventh[d]],
    roman: m.roman[d],
    func: m.func[d],
  }));
  // 調号: 変化記号の数(♯ は +、♭ は −)
  const sig = notes.reduce((sum, n) => sum + n.acc, 0);
  return {
    pc: tonicPc,
    mode,
    modeLabel: m.label,
    tonic: notes[0].name,
    name: `${notes[0].name} ${m.label}`,
    notes,
    chords,
    signature: sig,
    signatureText: sig === 0 ? "なし" : sig > 0 ? `♯ ${sig}つ` : `♭ ${-sig}つ`,
  };
}

/** 平行調。長調の6番目の音を主音にした短調、短調の3番目の音を主音にした長調(綴りは、音階から取る: F♯ 長調 → D♯ 短調) */
export function relativeKey(key) {
  if (key.mode === "major") {
    const n = key.notes[5];
    return buildKeyFromSpelling(n.letter, n.acc, "minor");
  }
  const n = key.notes[2];
  return buildKeyFromSpelling(n.letter, n.acc, "major");
}

/** 半音 shift だけ移調したキー */
export function transposeKey(key, shift) {
  return buildKey((((key.pc + shift) % 12) + 12) % 12, key.mode);
}

// ギターのカポ: 開放弦のコードで弾きやすい「形」のキー
const OPEN_SHAPES = { major: [0, 2, 4, 7, 9], minor: [2, 4, 9] }; // C D E G A / Dm Em Am

/** 移調後のキーを、カポで弾くときの候補(カポの位置 0〜7 と、そのときのコードの形) */
export function capoOptions(key) {
  const out = [];
  for (let capo = 0; capo <= 7; capo++) {
    const shapePc = (((key.pc - capo) % 12) + 12) % 12;
    if (OPEN_SHAPES[key.mode].includes(shapePc)) {
      const shape = buildKey(shapePc, key.mode);
      out.push({ capo, shape: shape.tonic + (key.mode === "minor" ? "m" : "") });
    }
  }
  return out;
}

/** 移調の差を、わかりやすい言い方にする(+2 → 「全音上げ」など) */
export function shiftText(shift) {
  if (shift === 0) return "そのまま";
  const dir = shift > 0 ? "上げ" : "下げ";
  const n = Math.abs(shift);
  return n === 2 ? `全音${dir}` : n === 1 ? `半音${dir}` : `半音 ${n} つ${dir}`;
}

export const KEY_CHOICES = (mode) => TONICS[mode].map((_, pc) => buildKey(pc, mode));
