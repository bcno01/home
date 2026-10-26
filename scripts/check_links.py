#!/usr/bin/env python3
# サイトに載せているリンク(作品のボタン・オフボーカル/歌詞のダウンロード・BOOTH・メニュー・SNS・Events・Guideline)が切れていないか調べる(標準ライブラリのみ)
# 使い方: python3 scripts/check_links.py            調べて、結果を表示する(切れているものがあれば、終了コード 1)
# 環境変数 LINKCHECK_REPORT にファイルのパスがあれば、切れているもの・要確認のものを Markdown で書き出す(GitHub Actions が Issue にする)
# 判定:
#   切れている … 404 / 410(ページがない)、YouTube・Spotify の埋め込み用の確認で「見つからない」、ドメインが存在しない
#   要確認     … ボット対策でブロックされた(403 / 429 など)・タイムアウト。実際には見られることが多いので、まず自分のブラウザで開いて確認する
import concurrent.futures
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import build

ROOT = Path(__file__).resolve().parent.parent
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
TIMEOUT = 15


def collect():
    """{URL: [どこで使っているか, ...]}"""
    found = {}

    def add(url, where):
        if url.startswith("http"):
            found.setdefault(url.split("#")[0], [])
            if where not in found[url.split("#")[0]]:
                found[url.split("#")[0]].append(where)

    site = build.load_site()
    for lab, u in list(site["menu"]) + list(site["links"]):
        add(u, "メニュー/リンク: %s" % (lab or u))
    if site["form"]:
        add(site["form"], "依頼フォーム")
    if site.get("featured"):
        add(site["featured"], "トップの動画(featured:)")
    for d in sorted(build.WORKS.iterdir()) if build.WORKS.exists() else []:
        if d.is_dir() and not d.name.startswith((".", "_")):
            w = build.read_work(d)
            if w:
                for lab, u in w["links"]:
                    add(u, "作品: %s(%s)" % (w["title"], lab))
                for x in w["downloads"]:  # info.txt の offvocal: / lyrics: に書いたダウンロードのURL(GitHub の Releases など)
                    if x["url"].startswith("http"):
                        add(x["url"], "ダウンロード: %s(%s)" % (w["title"], x["name"]))
    for i in build.load_booth():
        add(i["url"], "BOOTH: %s" % i["name"])
    g = build.load_guideline()
    if g and g["link"]:
        add(g["link"], "Guideline(全文)")
    for e in build.load_events():
        if e["url"]:
            add(e["url"], "Events: %s" % e["title"])
    return found


def fetch_status(url, method="GET"):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept-Language": "ja,en;q=0.8",
                                                              "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, ""
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.gaierror):
            return 0, "ドメインが見つかりません"
        return -1, str(reason)[:60]
    except Exception as e:  # タイムアウトなど
        return -1, str(e)[:60]


def classify(url):
    """('ok' | 'broken' | 'check', 説明)"""
    host = build.host_of(url)
    probe = url
    # YouTube / Spotify は、ページ自体は消えていても 200 を返すことがあるので、埋め込み用の確認(oEmbed)で調べる
    if build.youtube_id(url):
        probe = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe="")
    elif host == "open.spotify.com":
        probe = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")
    status, why = 0, ""
    for _ in range(2):  # 一時的な失敗に備えて、もう1度だけ試す
        status, why = fetch_status(probe)
        if 0 < status < 400:
            return "ok", ""
        if status in (404, 410):
            break
    if status in (404, 410):
        return "broken", "HTTP %d(ページが見つかりません)" % status
    if status == 0:
        return "broken", why
    if status == -1:
        return "check", "接続できませんでした(%s)" % why
    if probe != url and status in (401, 403):
        return "ok", ""  # 埋め込みが許可されていない動画など。ページは存在する
    return "check", "HTTP %d(ボット対策の可能性があります)" % status


def main():
    found = collect()
    print("%d 件のリンクを確認します…" % len(found))
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(classify, u): u for u in found}
        for f in concurrent.futures.as_completed(futs):
            results[futs[f]] = f.result()
    broken = [(u, r[1]) for u, r in sorted(results.items()) if r[0] == "broken"]
    check = [(u, r[1]) for u, r in sorted(results.items()) if r[0] == "check"]
    print("OK: %d 件 / 切れている: %d 件 / 要確認: %d 件" % (len(found) - len(broken) - len(check), len(broken), len(check)))
    lines = []
    for title, items in (("切れている可能性が高いリンク", broken), ("要確認のリンク(ブラウザで開いて確認してください)", check)):
        if not items:
            continue
        print("\n" + title)
        lines.append("## " + title)
        for u, why in items:
            print("  %s\n    %s  [%s]" % (u, " / ".join(found[u]), why))
            lines.append("- %s — %s(%s)" % (u, " / ".join(found[u]), why))
        lines.append("")
    out = os.environ.get("LINKCHECK_REPORT")
    if out:
        if not broken:
            lines = []  # 「要確認」だけのときは、Issue にしない(ボット対策で、毎回出るサイトがあるため)
        head = ("サイトに載せているリンクを自動で確認しました。\n\n"
                "直すときは、該当する作品の `works/<フォルダ名>/info.txt`(または `設定/site.txt` など)のリンクを直して push してください。"
                "直ったあと、次の確認で問題がなければ、この Issue は自動で閉じられます。\n\n") if lines else ""
        Path(out).write_text(head + "\n".join(lines), encoding="utf-8")
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
