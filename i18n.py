# 英語版(/en/)で使う、画面の文言の対応表。キーは日本語版の文言、値が英語版の文言。
# 作品ごとの文(見出し・説明)や、料金表(pricing-en.txt)・Guideline(guideline-en.txt)・Events は、ここではなく別のファイルで管理する。
# 新しい文言を build.py に足したときは、tr("日本語") で包んで、ここに英語を足す(足さなければ、日本語のまま出る)。

EN = {
    # 作品ページ
    "配信リンク": "Streaming links",
    "作品名: ": "Title: ",
    "別名: ": "Also known as: ",
    "、": ", ",
    "収録曲": "Tracks",
    "関連作品": "Related works",
    "ほかの商品は BOOTH で ↗": "More items on BOOTH ↗",
    "関連する商品(BOOTH)": "Related items (BOOTH)",
    "通販・グッズ": "Shop / Goods",
    "その他": "Other",
    # トップ
    "絞り込み": "Filter",
    "まだ作品がありません。works フォルダに作品フォルダを追加してください。": "No works yet.",
    # Events
    "詳細 ↗": "Details ↗",
    "現在、出演予定はありません。": "No upcoming appearances at the moment.",
    "過去の出演": "Past appearances",
    # Guideline
    "ガイドライン全文を読む(note) ↗": "Read the full guideline (note, in Japanese) ↗",
    # 料金表
    "要相談": "Please inquire",
    "ご依頼にあたって": "Before you request",
    "料金表を見る(税込)": "View price list (tax included)",
    # 依頼フォーム
    "依頼受付フォーム": "Request form",
    "お仕事のご依頼・ご相談はこちらから。内容を確認のうえ、ご返信します。": "For work requests and inquiries. We will review your message and reply.",
    "※ オプション以外の項目は、すべて入力が必要です。": "* All fields are required except the options.",
    "表示されないときは別のタブで開く ↗": "Open in a new tab if it does not display ↗",
    "依頼フォームを開く": "Open the request form",
    "選んでください": "Please choose",
    "楽曲制作": "Original composition",
    "MIX・Mastering": "MIX & Mastering",
    "編曲": "Arrangement",
    "イベント出演": "Event appearance",
    "オプション(任意・複数選べます)": "Options (optional, multiple allowed)",
    "ご依頼のプラン": "Plan",
    "お名前": "Name",
    "返信先のメールアドレス": "Email address (for our reply)",
    "ご依頼の内容": "Type of request",
    "ご希望の納期": "Preferred deadline",
    "日付は未定・相談したい": "Date to be decided / let's discuss",
    "詳細・ご要望(曲名・トラック数・参考URLなど)": "Details (song title, number of tracks, reference URLs, etc.)",
    "入力の進み具合": "Form progress",
    "送信完了": "Sent",
    "送信した内容": "What you sent",
    "控えをメールで受け取る": "Get a copy by email",
    "ご入力のメールアドレス宛の下書きが、メールアプリで開きます。送信すると、控えとして手元に残ります。":
        "A draft addressed to your email address opens in your mail app. Send it to keep a copy.",
    "もう一度入力する": "Fill in again",
    "この内容で送信する": "Send",
    "メールの下書きを作る": "Create an email draft",
    "メールアプリで下書きを作る": "Create a draft in your mail app",
    "送信内容は、メール配信サービス(Web3Forms)を経由して、BCNO に届きます。メールアプリで送りたいときは、「メールアプリで下書きを作る」を押してください。":
        "Your message is delivered to BCNO through an email delivery service (Web3Forms). To send it from your own mail app instead, press \"Create a draft in your mail app\".",
    "ボタンを押すと、メールアプリが開いて、入力内容が下書きされます。送信はメールアプリで行ってください。":
        "Pressing the button opens your mail app with your message drafted. Please send it from the mail app.",
}

# 作品の種類
KINDS_EN = {"single": "Single", "ep": "EP", "album": "Album"}
TYPES_EN = {"music": "Streaming", "video": "MV", "project": "Projects", "goods": "Shop / Goods", "other": "Other"}
