#!/usr/bin/env python3
# MV の BPM を、スプレッドシート(Numbers・Excel など)でまとめて入力する(標準ライブラリのみ)
# 使い方: python3 bpm_sheet.py                 一覧を書き出す → 開く → 保存したら取り込む、までを順に行う(ふつうはこれ)
#         python3 bpm_sheet.py export           一覧(bpm-key.csv)を書き出すだけ
#         python3 bpm_sheet.py import           bpm-key.csv の BPM を、作品の info.txt に取り込むだけ
#         python3 bpm_sheet.py --from 2022      対象にする最初の年(初めからの設定は 2022。それ以降の MV がすべて対象)
#         python3 bpm_sheet.py --from 2018 --to 2021   年の範囲を指定
# 一覧の列: フォルダ名(変えないでください)・日付・曲名・BPM。BPM の列だけ、入力します。
# 取り込むのは、入力した行だけです(空の行は何もしません。入力済みの値を消したいときは、その作品の info.txt を直接直してください)。
# 以前の一覧にあった Key の列は、読み飛ばします(Key は、サイトに表示しません)。
# BPM は 30〜300 の数字だけ有効です。何度でも書き出し・取り込みを繰り返せます(書き出しは、入力済みの値も入れ直します)。
import csv
import subprocess
import sys

import build
import import_works as iw

CSV_PATH = iw.ROOT / "bpm-key.csv"
BACKUP = iw.ROOT / "bpm-key.前回.csv"
HEAD = ["フォルダ名", "日付", "曲名", "BPM"]


def mv_rows(y_from, y_to):
    """対象の MV(type: video)の行。新しい順"""
    rows = []
    for info in iw.WORKS.glob("*/info.txt"):
        f = build.parse_info(info.read_text(encoding="utf-8"))[0]
        if build.truthy(f.get("draft")):
            continue
        t = f.get("type", "").strip()
        t = build.TYPE_ALIAS.get(t, build.TYPE_ALIAS.get(t.lower(), t.lower()))
        d = build.parse_date(f.get("date")) or build.parse_date(info.parent.name)
        if t != "video" or not d or not (y_from <= d.year <= y_to):
            continue
        rows.append((d, info.parent.name, f.get("title", info.parent.name), f.get("bpm", "")))
    rows.sort(key=lambda r: (r[0], r[1]), reverse=True)
    return rows


def export(y_from, y_to):
    rows = mv_rows(y_from, y_to)
    if CSV_PATH.exists():  # 前回の一覧に、まだ取り込んでいない入力があっても消えないように、1つ前を残す
        CSV_PATH.replace(BACKUP)
        print("前回の一覧は、%s に残しました。" % BACKUP.name)
    # 先頭に BOM を付けると、Numbers・Excel でも日本語が文字化けしない
    with open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(HEAD)
        for d, slug, title, bpm in rows:
            w.writerow([slug, d.strftime("%Y-%m-%d"), title, bpm])
    filled = sum(1 for r in rows if r[3])
    print("%d 本の MV(%d〜%d 年)を %s に書き出しました(入力済み %d 本)。" % (len(rows), y_from, y_to, CSV_PATH.name, filled))
    return len(rows)


def read_csv():
    raw = CSV_PATH.read_bytes()
    for enc in ("utf-8-sig", "cp932"):  # Windows の Excel は Shift-JIS で保存することがある
        try:
            return list(csv.reader(raw.decode(enc).splitlines()))
        except UnicodeDecodeError:
            continue
    raise ValueError("文字コードを読み取れませんでした(UTF-8 の CSV で保存してください)")


def import_csv():
    if not CSV_PATH.exists():
        print("%s がありません。先に、書き出してください(python3 bpm_sheet.py export)。" % CSV_PATH.name)
        return 0
    table = read_csv()
    if not table:
        print("%s が空です。" % CSV_PATH.name)
        return 0
    head = [h.strip().lower() for h in table[0]]
    try:
        i_slug, i_bpm = head.index("フォルダ名"), head.index("bpm")
    except ValueError:
        print("見出し行(フォルダ名・日付・曲名・BPM)が見つかりません。1行目は、書き出したままにしてください。")
        return 0
    changed, bad, missing = 0, [], []
    for row in table[1:]:
        if len(row) <= max(i_slug, i_bpm):
            row = row + [""] * (max(i_slug, i_bpm) + 1 - len(row))
        slug, bpm_raw = row[i_slug].strip(), row[i_bpm].strip()
        if not slug or not bpm_raw:
            continue
        info = iw.WORKS / slug / "info.txt"
        if not info.exists():
            missing.append(slug)
            continue
        f = build.parse_info(info.read_text(encoding="utf-8"))[0]
        title = f.get("title", slug)
        updates = {}
        x = build.parse_bpm(bpm_raw)
        if not x:
            bad.append((title, bpm_raw))
        elif build.fmt_bpm(x) != f.get("bpm", ""):
            updates["bpm"] = build.fmt_bpm(x)
        if updates:
            iw.rewrite_info(info, updates)
            changed += 1
            print("  + %s  BPM %s" % (title[:30], updates["bpm"]))
    print("\n%d 本に、BPM を書き込みました。" % changed)
    if bad:
        print("BPM を読み取れなかったものがあります(30〜300 の数字で入力してください):")
        for title, raw in bad:
            print("  ! %s: %s" % (title, raw))
    if missing:
        print("フォルダが見つからなかった行があります(フォルダ名の列は、変えないでください): %s" % ", ".join(missing[:5]))
    return changed


def main():
    argv = sys.argv[1:]
    y_from, y_to = 2022, 9999
    for opt in ("--from", "--to"):
        if opt in argv:
            i = argv.index(opt)
            try:
                v = int(argv[i + 1])
            except (IndexError, ValueError):
                print("%s には、年(例: 2022)を指定してください。" % opt)
                return 1
            del argv[i:i + 2]
            if opt == "--from":
                y_from = v
            else:
                y_to = v
    mode = argv[0] if argv else "all"
    if mode == "export":
        export(y_from, y_to)
        return 0
    if mode == "import":
        import_csv()
        return 0
    if not sys.stdin.isatty():
        print("対話の環境でないため、export / import を指定してください。")
        return 1
    if not export(y_from, y_to):
        print("対象の MV がありませんでした。")
        return 1
    subprocess.run(["open", str(CSV_PATH)], check=False)  # 標準のアプリ(Numbers・Excel など)で開く
    print("\nBPM の列に入力して、保存してください(形式は CSV のままで構いません)。")
    print("入力しない行は、何もしません。途中までの入力でも、取り込めます。")
    input("保存できたら、Enter を押してください(取り込みます): ")
    changed = import_csv()
    if changed and input("\nサイトを作り直して、表示を確認しますか? [Y/n]: ").strip().lower() in ("", "y", "yes"):
        build.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
