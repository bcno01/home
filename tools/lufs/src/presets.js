// ノーマライズ目標プリセット(LUFS)。足すときは、ここに1行足す(画面の選択肢も、目盛りの印も、自動で増える)。
// custom: true は、数値を自分で入れる枠(lufs は使わない)。目盛りの印は、固定の基準(lufs が数値のもの)だけに付く。
export const TARGET_PRESETS = [
  { id: "spotify-youtube", label: "Spotify / YouTube", short: "Spotify", lufs: -14 },
  { id: "apple-music", label: "Apple Music", lufs: -16 },
  { id: "custom", label: "カスタム", lufs: null, custom: true },
];

// カスタムの目標の、初期値と範囲(LUFS)。範囲は、目盛りの端(−40〜0)と同じ
export const CUSTOM_DEFAULT_LUFS = -14;
export const CUSTOM_MIN_LUFS = -40;
export const CUSTOM_MAX_LUFS = 0;

// 非現実的な大ゲインを避けるための上下限
export const GAIN_CLAMP_DB = 24;
