// サイト全体の演出。
//  - ページ遷移のフェード(「視差効果を減らす」設定では無効)
//  - 背景動画のレンズ・クリックの波紋・カーソル近くの細かいモザイク・ジャケットの傾き(マウスのある端末だけ。スマホでは無効)
//  - ページを移るときの波紋(マウスのある端末だけ)
(function () {
  var fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- 背景動画(PCだけ読み込む)。作品の bg.mp4 クリップをシャッフルして順に再生。クリップがなければ YouTube ----
  var YT = 'https://www.youtube-nocookie.com';
  var bg = document.querySelector('.bgvideo');
  var frame = null; // YouTube の iframe
  var vids = null;  // 自前クリップの <video> 2本(交互に使ってクロスフェードする)
  var curVid = 0;
  var fineOn = false;  // カーソルの近くの細かいモザイクを描くか(レンズが開いているとき)

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function showBackground() { // 読み込めたらゆっくり表示し、文字を白に(style.css の bg-on)
    setTimeout(function () {
      bg.classList.add('on');
      document.body.classList.add('bg-on');
    }, 1200);
  }

  function ytCommand(func, args) {
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), YT);
    }
  }
  // クリップを「ランダムな順で、一巡したらシャッフルし直して、ずっと」流す。
  // video を2本重ね、再生中のクリップの終わり際に、次のクリップ(先に読み込んでおく)へクロスフェードするので途切れない。
  function startClips() {
    var all = bg.dataset.clips.split(',').filter(Boolean);
    var FADE = 1; // クロスフェードの秒数(style.css の transition と合わせる)
    var a = bg.querySelector('video');
    var order = [], pos = 0, last = '';
    var xf = null; // クロスフェード中の {out, inc, t0}(モザイクの描画で使う)
    var fails = 0; // 続けて読み込みに失敗した回数(再生に成功すると 0 に戻る)
    vids = [a];
    if (all.length > 1) {
      var b = a.cloneNode(false);
      bg.appendChild(b);
      vids.push(b);
    } else {
      a.loop = true;
    }

    function pick() {
      if (pos >= order.length) {
        order = shuffle(all.slice());
        if (all.length > 1 && order[0] === last) { // 一巡の切れ目で同じクリップが続かないように
          var t = order[0]; order[0] = order[order.length - 1]; order[order.length - 1] = t;
        }
        pos = 0;
      }
      last = order[pos++];
      return last;
    }
    function load(v) {
      v._swapping = false;
      v.src = pick();
      v.load();
    }
    function swap() {
      var out = vids[curVid];
      curVid = 1 - curVid;
      var inc = vids[curVid];
      xf = { out: out, inc: inc, t0: performance.now() };
      inc.currentTime = 0;
      inc.play().catch(function () {});
      inc.classList.add('front');
      out.classList.remove('front');
      setTimeout(function () { out.pause(); load(out); }, FADE * 1000 + 300); // 古い方に、次のクリップを先読みしておく
    }

    vids.forEach(function (v) {
      v.addEventListener('timeupdate', function () {
        if (all.length < 2 || v !== vids[curVid] || v._swapping) return;
        if (v.duration && v.duration - v.currentTime < FADE + 0.2) { v._swapping = true; swap(); }
      });
      v.addEventListener('ended', function () { // timeupdate が間に合わなかったとき
        if (all.length > 1 && v === vids[curVid] && !v._swapping) { v._swapping = true; swap(); }
      });
      v.addEventListener('playing', function () { fails = 0; });
      v.addEventListener('error', function () { // 読み込めないクリップは飛ばす。ネットが切れているときなど、続けて失敗するときは、6回で止める(止めないと、延々と再取得を繰り返す)
        if (++fails > 6) return;
        load(v);
        if (v === vids[curVid]) v.play().catch(function () {});
      });
    });
    // 実際のモザイク: 動画を小さな canvas に縮小して描く(同じサイトの動画なので読み取れる)。レンズの中だけ、元の映像が見える
    function startMosaic() {
      var cell = parseInt(getComputedStyle(bg).getPropertyValue('--cell'), 10) || 14;
      // 層は2枚: ふだんのモザイクと、カーソルの近くだけに重ねる細かいモザイク(大きさは3分の1)
      function layer(c, cls) {
        var L = { c: c, cv: document.createElement('canvas'), mid: document.createElement('canvas') }; // mid: いったん4倍の大きさに描いてから縮めると、平均に近い色になる
        L.cv.className = 'mosaic' + cls;
        bg.appendChild(L.cv);
        L.ctx = L.cv.getContext('2d');
        L.mctx = L.mid.getContext('2d');
        L.ctx.imageSmoothingQuality = 'high';
        L.mctx.imageSmoothingQuality = 'high';
        return L;
      }
      var base = layer(cell, ''), fine = layer(Math.max(4, Math.round(cell / 3)), ' fine');
      bg.classList.add('px');
      function size() {
        [base, fine].forEach(function (L) {
          L.cv.width = Math.max(8, Math.ceil(innerWidth / L.c));
          L.cv.height = Math.max(8, Math.ceil(innerHeight / L.c));
          L.mid.width = L.cv.width * 4;
          L.mid.height = L.cv.height * 4;
        });
      }
      size();
      window.addEventListener('resize', size);
      function draw(L, v, alpha) {
        if (!v.videoWidth || v.readyState < 2) return;
        var s = Math.max(L.mid.width / v.videoWidth, L.mid.height / v.videoHeight); // object-fit: cover と同じ切り取り
        var sw = L.mid.width / s, sh = L.mid.height / s;
        L.mctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, L.mid.width, L.mid.height);
        L.ctx.globalAlpha = alpha;
        L.ctx.drawImage(L.mid, 0, 0, L.cv.width, L.cv.height);
      }
      var lastT = 0;
      (function tick(t) {
        requestAnimationFrame(tick);
        if (document.hidden || t - lastT < 33) return; // 30fps で十分
        lastT = t;
        var layers = fineOn ? [base, fine] : [base]; // 細かい層は、レンズが開いている間だけ描く
        var fading = xf && t - xf.t0 < FADE * 1000;
        if (!fading) xf = null;
        layers.forEach(function (L) {
          if (fading) {
            draw(L, xf.out, 1);
            draw(L, xf.inc, Math.max(0, (t - xf.t0) / (FADE * 1000)));
          } else {
            draw(L, vids[curVid], 1);
          }
        });
      })(0);
    }
    if (bg.dataset.mosaic === 'pixel') startMosaic();

    a.addEventListener('playing', function once() {
      a.removeEventListener('playing', once);
      a.classList.add('front');
      showBackground();
      if (vids[1]) load(vids[1]); // 2本目を先読み
    });
    document.addEventListener('visibilitychange', function () {
      var cv = vids[curVid];
      if (document.hidden) cv.pause(); else cv.play().catch(function () {});
    });
    load(a);
    a.play().catch(function () {});
  }

  function startYouTube() {
    frame = bg.querySelector('iframe');
    var ids = shuffle(bg.dataset.videos.split(',').filter(Boolean));
    var idx = 0;
    // 再生リストにすると前へ/次へのアイコンが出るので、1本ずつ再生し、終わったら次の動画に切り替える
    function nextVideo() {
      if (ids.length < 2) return;
      idx = (idx + 1) % ids.length;
      ytCommand('loadVideoById', [ids[idx]]);
    }
    frame.addEventListener('load', function () {
      frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT);
      showBackground();
    });
    window.addEventListener('message', function (e) {
      if (e.origin !== YT || typeof e.data !== 'string') return;
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      var ended = d.event === 'onStateChange' && d.info === 0;
      var errored = d.event === 'onError';
      var ended2 = d.event === 'infoDelivery' && d.info && d.info.playerState === 0;
      if (ended || ended2 || errored) nextVideo();
      if (d.event === 'onReady') {
        ytCommand('unloadModule', ['captions']); // 自動字幕が出ていたら消す
        ytCommand('unloadModule', ['cc']);
      }
    });
    frame.src = YT + '/embed/' + ids[0] + '?autoplay=1&mute=1&controls=0' +
      (ids.length < 2 ? '&loop=1&playlist=' + ids[0] : '') +
      '&playsinline=1&modestbranding=1&rel=0&disablekb=1&iv_load_policy=3&cc_load_policy=0&fs=0&enablejsapi=1&origin=' +
      encodeURIComponent(location.origin);
  }

  if (bg && fine && !calm) {
    if (bg.dataset.clips) startClips(); else startYouTube();
  }

  // ---- 右側のパネル(Works / Events / Contact): メニューの項目で開閉。1つ開くとほかは閉じ、開いているものをもう一度押すと全部閉じる ----
  var pLinks = [].slice.call(document.querySelectorAll('.nav a.pn'));
  if (pLinks.length) {
    var panelEls = {};
    [].forEach.call(document.querySelectorAll('.rpanel'), function (p) { panelEls[p.id] = p; });
    var openPanel = function (name) { // name が空なら、全部閉じる
      Object.keys(panelEls).forEach(function (k) { panelEls[k].classList.toggle('open', k === name); });
      pLinks.forEach(function (a) {
        var on = a.dataset.panel === name;
        a.classList.add('pn-on');
        a.classList.toggle('is-open', on);
        a.setAttribute('aria-expanded', on);
      });
      document.body.dataset.panel = name;
      try { localStorage.setItem('panel', name || 'none'); } catch (err) {}
    };
    var saved = null;
    try { saved = localStorage.getItem('panel'); } catch (err) {}
    var hashName = location.hash.replace('#', '');
    // 新しくページを開いたとき(URL を開く・リンクを押す)は、Works を開く。再読み込みと「戻る」だけは、前に開いていたパネルを引き継ぐ。#contact のようなURLなら、そのパネル
    var navType = '';
    try { navType = performance.getEntriesByType('navigation')[0].type; } catch (err) {}
    var fresh = navType === 'navigate';
    var start = panelEls[hashName] ? hashName : (fresh ? 'works' : (saved === 'none' ? '' : (panelEls[saved] ? saved : 'works')));
    openPanel(start);
    // スマホ(「MENU」ボタンが出ている幅)では、メニューを開閉式にする。パネルを選んだら、メニューを閉じて、そのパネルまでスクロールする
    var menuEl = document.querySelector('.menu'), toggleBtn = document.querySelector('.menu-toggle');
    var isMobileMenu = function () { return toggleBtn && getComputedStyle(toggleBtn).display !== 'none'; };
    var setMenu = function (open) {
      if (!menuEl || !toggleBtn) return;
      menuEl.classList.toggle('open', open);
      toggleBtn.setAttribute('aria-expanded', open);
    };
    if (toggleBtn) toggleBtn.addEventListener('click', function () { setMenu(!menuEl.classList.contains('open')); });
    pLinks.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var name = document.body.dataset.panel === a.dataset.panel ? '' : a.dataset.panel;
        openPanel(name);
        if (isMobileMenu()) {
          setMenu(false);
          if (name) setTimeout(function () { panelEls[name].scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' }); }, 60);
        }
      });
    });
  }

  // ---- 依頼受付フォーム: 入力内容をメールの下書きにする(送信はメールアプリで) ----
  var reqForm = document.querySelector('form.req');
  if (reqForm) {
    var kindSel = reqForm.elements['種類'];
    var tbd = reqForm.elements['納期未定'];
    var mixbox = reqForm.querySelector('.mixbox');
    var est = reqForm.querySelector('.est');
    var yen = function (n) { return '\u00a5' + n.toLocaleString('ja-JP'); };
    var mixOn = function () { // 「MIX・Mastering」が選ばれているか
      var o = kindSel.selectedIndex >= 0 ? kindSel.options[kindSel.selectedIndex] : null;
      return !!(o && o.dataset.mix);
    };
    // オプションは、選んだプランで選べるものだけを出す(pricing.txt の「対象」)。プランが未選択のあいだは出さない
    var allows = function (rule, group) {
      var toks = rule.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      var inc = toks.filter(function (t) { return t.charAt(0) !== '-'; });
      var exc = toks.filter(function (t) { return t.charAt(0) === '-'; }).map(function (t) { return t.slice(1); });
      if (exc.some(function (t) { return group.indexOf(t) >= 0; })) return false;
      return !inc.length || inc.some(function (t) { return group.indexOf(t) >= 0; });
    };
    var optFs = reqForm.querySelector('.opts');
    var syncOptions = function () {
      if (!optFs) return;
      var sel = reqForm.elements['プラン'];
      var po = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      var group = po && po.value ? po.dataset.group : null;
      var any = false;
      [].forEach.call(optFs.querySelectorAll('.chk'), function (lab) {
        var ok = group !== null && allows(lab.dataset.for || '', group);
        var box = lab.querySelector('input');
        lab.hidden = !ok;
        box.disabled = !ok || sel.disabled;
        if (!ok) box.checked = false;
        if (ok) any = true;
      });
      optFs.hidden = !any;
    };
    // MIX・Mastering のときだけ、プラン・オプション・料金表・見積りの目安を出す(隠している間は入力チェックの対象にもしない)
    var syncMix = function () {
      if (!mixbox) return;
      var on = mixOn();
      mixbox.hidden = !on;
      [].forEach.call(mixbox.querySelectorAll('select, input'), function (el) { el.disabled = !on; });
      refresh();
    };
    // 選ばれたプランとオプションから、お見積りの目安(確定ではありません)を作る
    var quote = function () {
      if (!mixbox || !mixOn()) return null;
      var sel = reqForm.elements['プラン'];
      var planOpt = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      if (!planOpt || !planOpt.value) return null;
      var opts = [].slice.call(reqForm.querySelectorAll('input[name="オプション"]:checked'));
      var names = opts.map(function (o) { return o.value; });
      var base = planOpt.dataset.price;
      var pl = { plan: planOpt.value, options: names };
      if (base === '') { pl.total = null; pl.text = 'プランの料金は、内容を確認のうえ、ご相談になります。'; return pl; }
      var total = Number(base);
      opts.forEach(function (o) { if (o.dataset.price !== '') total += Number(o.dataset.price); });
      pl.total = total;
      pl.text = 'お見積りの目安(税込): ' + yen(total) + '  ※人数などで変わることがあります。正式なお見積りは、内容を確認してご連絡します。';
      return pl;
    };
    // お見積りの目安: 大きな金額で見せて、プランを変えると数字がカウントするように切り替わる
    var estAmt = null, estShown = null, estRaf = 0;
    if (est) {
      est.innerHTML = '<span class="lbl">' + 'お見積りの目安(税込): ' + '</span><span class="amt"></span><span class="sub"></span>';
      estAmt = est.querySelector('.amt');
    }
    var showAmount = function (total) {
      if (total === null) { cancelAnimationFrame(estRaf); estAmt.textContent = '要相談'; estShown = null; return; }
      cancelAnimationFrame(estRaf);
      var from = estShown === null ? total : estShown, t0 = null;
      if (calm || from === total) { estAmt.textContent = yen(total); estShown = total; return; }
      var step = function (t) {
        if (t0 === null) t0 = t;
        var k = Math.min(1, (t - t0) / 550), e = 1 - Math.pow(1 - k, 3);
        estShown = Math.round(from + (total - from) * e);
        estAmt.textContent = yen(estShown);
        if (k < 1) estRaf = requestAnimationFrame(step);
      };
      estRaf = requestAnimationFrame(step);
    };
    // 入力の進み具合: 必須項目のうち、入力が済んだ数(日付は「未定」にチェックでも済み)
    var progEl = reqForm.querySelector('.prog');
    var progress = function () {
      if (!progEl) return;
      var total = 0, done = 0;
      [].forEach.call(reqForm.elements, function (el) {
        if (!el.required || el.disabled) return;
        total++;
        if (el.checkValidity()) done++;
      });
      if (tbd && tbd.checked) { total++; done++; }
      var pct = total ? Math.round(done / total * 100) : 0;
      progEl.querySelector('i').style.width = pct + '%';
      progEl.setAttribute('aria-valuenow', pct);
      progEl.classList.toggle('done', total > 0 && done === total);
      progEl.querySelector('.pt').textContent = done === total ? '入力がそろいました。送信できます' :
        '入力 ' + done + ' / ' + total + '(あと ' + (total - done) + ' 項目)';
    };
    var refresh = function () {
      syncOptions();
      if (est) {
        var q = quote();
        est.hidden = !q;
        if (q) {
          showAmount(q.total);
          est.querySelector('.sub').textContent = q.total === null ?
            'プランの料金は、内容を確認のうえ、ご相談になります。' :
            '※人数などで変わることがあります。正式なお見積りは、内容を確認してご連絡します。';
        }
      }
      progress();
    };
    reqForm.addEventListener('change', function (e) {
      if (e.target === kindSel) syncMix(); else refresh();
    });
    reqForm.addEventListener('input', progress);
    reqForm.addEventListener('reset', function () { setTimeout(function () { syncMix(); refresh(); }, 0); });
    syncMix();
    refresh();

    // 入力内容から、件名・本文などを作る(直接送信にも、メールの下書きにも使う)
    var compose = function () {
      var f = reqForm.elements;
      var q = quote();
      var lines = ['お名前: ' + f['お名前'].value, '返信先: ' + f['返信先'].value, 'ご依頼の内容: ' + kindSel.value];
      if (mixOn()) {
        lines.push('ご依頼のプラン: ' + (q ? q.plan : '(未選択)'));
        lines.push('オプション: ' + (q && q.options.length ? q.options.join('、') : 'なし'));
        lines.push('お見積りの目安: ' + (q ? (q.total === null ? '要相談' : yen(q.total) + '(税込・目安)') : '-'));
      }
      var dv = f['納期'].value;
      var deadline = (f['納期未定'] && f['納期未定'].checked) ? '未定・相談したい' :
        (dv ? dv.replace(/^(\d+)-0?(\d+)-0?(\d+)$/, '$1年$2月$3日') : '(未記入)');
      lines.push('ご希望の納期: ' + deadline);
      var body = lines.join('\n') + '\n\n【詳細・ご要望】\n' + f['内容'].value + '\n';
      var short = q ? 'MIX・Mastering(' + q.plan.split(' / ').pop() + ')' : kindSel.value;
      return { name: f['お名前'].value, email: f['返信先'].value, subject: '【依頼】' + short + ' / ' + f['お名前'].value, body: body };
    };
    var mailtoFor = function () {
      var c = compose();
      return 'mailto:' + reqForm.dataset.to + '?subject=' + encodeURIComponent(c.subject) + '&body=' + encodeURIComponent(c.body);
    };
    reqForm.mailtoFor = mailtoFor; // (確認用に公開しておく)

    // 希望納期: カレンダーで選ぶ(今日より前は選べない)。日付が未定のときは「未定・相談したい」にチェック
    var dateEl = reqForm.elements['納期'];
    if (dateEl && dateEl.type === 'date') {
      var d0 = new Date();
      dateEl.min = d0.getFullYear() + '-' + ('0' + (d0.getMonth() + 1)).slice(-2) + '-' + ('0' + d0.getDate()).slice(-2);
      if (tbd) tbd.addEventListener('change', function () {
        dateEl.disabled = tbd.checked; // 無効にした欄は、入力チェックの対象にならない
        dateEl.required = !tbd.checked;
        if (tbd.checked) dateEl.value = '';
      });
    }

    // 送信: site.txt の form-key があれば、フォームから直接送る(Web3Forms)。なければ、メールの下書きを作る。
    // 直接送れなかったときも、「メールアプリで下書きを作る」で送れる
    var sendBtn = reqForm.querySelector('button.send'), draftBtn = reqForm.querySelector('button.draft');
    var statusEl = reqForm.querySelector('.status');
    var say = function (msg, kind) {
      if (!statusEl) return;
      statusEl.hidden = !msg;
      statusEl.textContent = msg || '';
      statusEl.className = 'status ' + (kind || '');
    };
    // 送信完了: 入力欄がふわっと消えて、「Thank you」を見せる。内容は、消えたあとにリセットする
    var fieldsEl = reqForm.querySelector('.fields'), thanksEl = reqForm.querySelector('.thanks');
    var thanks = function (c) {
      var summary = c.body;
      if (!fieldsEl || !thanksEl) { reqForm.reset(); return; }
      fieldsEl.classList.add('out');
      setTimeout(function () {
        reqForm.reset();
        if (tbd) tbd.dispatchEvent(new Event('change'));
        fieldsEl.hidden = true;
        var pre = thanksEl.querySelector('pre');
        if (pre) pre.textContent = summary || '';
        var cp = thanksEl.querySelector('.copy');
        if (cp) cp.href = 'mailto:' + encodeURIComponent(c.email).replace(/%40/g, '@') + '?subject=' + encodeURIComponent('【控え】' + c.subject) + '&body=' + encodeURIComponent('BCNO への依頼内容の控えです。\n\n' + c.body);
        thanksEl.hidden = false;
        thanksEl.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
      }, calm ? 0 : 450);
    };
    var again = reqForm.querySelector('.thanks .again');
    if (again) again.addEventListener('click', function () {
      thanksEl.hidden = true;
      fieldsEl.hidden = false;
      fieldsEl.classList.remove('out');
      refresh();
    });
    if (draftBtn) draftBtn.addEventListener('click', function () { location.href = mailtoFor(); });
    reqForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var endpoint = reqForm.dataset.endpoint, key = reqForm.dataset.key;
      if (!endpoint || !key) { location.href = mailtoFor(); return; }
      var c = compose();
      var hp = reqForm.elements['botcheck'];
      sendBtn.disabled = true;
      say('送信しています…', 'info');
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ access_key: key, subject: c.subject, from_name: c.name, name: c.name, email: c.email,
                               message: c.body, botcheck: !!(hp && hp.checked) })
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok && j.success, msg: j.message }; });
      }).then(function (res) {
        if (!res.ok) throw new Error(res.msg || 'send failed');
        say('');
        thanks(c);
      }).catch(function () {
        say('送信できませんでした。通信状況をご確認のうえ、もう一度お試しいただくか、「メールアプリで下書きを作る」からお送りください。', 'err');
      }).then(function () { sendBtn.disabled = false; });
    });
  }

  // ---- ページ遷移のフェード ----
  if (!calm) {
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      var u = new URL(a.href, location.href);
      if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search)) return;
      e.preventDefault();
      if (fine && e.detail > 0) { // マウスで押したとき: 押した場所から、次のページの背景色の円が波紋のように広がってから移る
        var cx = e.clientX, cy = e.clientY;
        var R = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 40;
        var w = document.createElement('div');
        w.className = 'wipe';
        w.style.cssText = 'left:' + cx + 'px;top:' + cy + 'px;width:' + (R * 2) + 'px;height:' + (R * 2) + 'px;margin:' + (-R) + 'px 0 0 ' + (-R) + 'px';
        document.body.appendChild(w);
        w.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 560, easing: 'cubic-bezier(.5, 0, .15, 1)', fill: 'forwards' });
        setTimeout(function () { location.href = u.href; }, 580);
        return;
      }
      document.body.classList.add('leaving');
      setTimeout(function () { location.href = u.href; }, 250);
    });
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      document.body.classList.remove('leaving');
      [].forEach.call(document.querySelectorAll('.wipe'), function (w) { w.remove(); });
    });
  }

  // ---- Works の行にカーソルを乗せるとジャケットが出る ----
  if (fine) {
    var peek = document.createElement('div');
    var peekImg = document.createElement('img');
    peek.className = 'peek';
    peekImg.alt = '';
    peek.appendChild(peekImg);
    document.body.appendChild(peek);
    document.addEventListener('pointermove', function (e) {
      var row = e.target.closest('.row');
      var src = row && row.dataset.cover;
      if (!src) { peek.classList.remove('on'); return; }
      if (peekImg.getAttribute('src') !== src) peekImg.src = src;
      // リストの右隣に出す(縦位置だけカーソルに追従)。右に余白がなければカーソルの横に出す
      var listRight = row.closest('.works-list').getBoundingClientRect().right;
      var x = listRight + 20 + 160 <= innerWidth ? listRight + 20 : Math.min(e.clientX + 24, innerWidth - 170);
      var y = Math.max(8, Math.min(e.clientY - 80, innerHeight - 170));
      peek.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      peek.classList.add('on');
    });
    document.documentElement.addEventListener('pointerleave', function () { peek.classList.remove('on'); });
  }

  // ---- Streaming のジャケットを押すと、CD ケースの3D表示(ドラッグで回転・「ケースを開く」で表紙が開いてディスクが見える・「裏返す」で表裏。ESC・外側・×で閉じる) ----
  (function () {
    var cover = document.querySelector('.work-cover[data-cd]');
    var img = cover && cover.querySelector('img');
    if (!cover || !img) return;
    var data;
    try { data = JSON.parse(cover.dataset.cd); } catch (e) { return; }
    var overlay = null;
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function open() {
      if (overlay) return;
      var tracks = data.tracks || [];
      var shortNames = (data.short && data.short.length === tracks.length) ? data.short : tracks; // 裏面は、(feat. ○○)などを除いた短い曲名(一覧には、そのままの曲名)
      overlay = el('div', 'cd-overlay');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'CDケース: ' + data.title);
      var close = el('button', 'cd-close', '\u00d7');
      close.type = 'button';
      close.setAttribute('aria-label', '閉じる');
      var stage = el('div', 'cd-stage');
      var cd = el('div', 'cd');
      var src = img.currentSrc || img.src;
      // 表紙(ドア): 外側 = ジャケット、内側 = ブックレットの表紙の裏
      var door = el('div', 'cd-door');
      var front = el('div', 'cd-f cd-front');
      var fi = el('img');
      fi.src = src;
      fi.alt = '';
      front.appendChild(fi);
      var din = el('div', 'cd-f cd-doorin');
      din.appendChild(el('h3', '', data.title));
      if (data.artist) din.appendChild(el('p', '', data.artist));
      // Apple Music の情報(あるものだけ): ジャンル・曲数と合計の再生時間・℗ の表記
      var facts = [];
      if (data.genre) facts.push(['GENRE', data.genre]);
      if (tracks.length || data.time) facts.push(['TRACKS', (tracks.length ? tracks.length + '曲' : '') + (tracks.length && data.time ? ' \u00b7 ' : '') + (data.time || '')]);
      if (facts.length) {
        var dl = el('dl', 'cd-facts');
        facts.forEach(function (kv) { dl.appendChild(el('dt', '', kv[0])); dl.appendChild(el('dd', '', kv[1])); });
        din.appendChild(dl);
      }
      if (data.copyright) din.appendChild(el('small', '', data.copyright));
      door.appendChild(front); door.appendChild(din);
      // トレイとディスク(ジャケットを丸く切り抜いたレーベル面)
      var tray = el('div', 'cd-f cd-tray');
      var disc = el('div', 'disc');
      var label = el('div', 'disc-label');
      label.style.backgroundImage = 'url("' + src.replace(/"/g, '%22') + '")';
      disc.appendChild(label);
      tray.appendChild(disc);
      // 裏面: 作品名・名義・収録曲・発売日
      var back = el('div', 'cd-f cd-back');
      back.appendChild(el('h3', '', data.title));
      if (data.artist) back.appendChild(el('p', '', data.artist));
      var ol = el('ol');
      tracks.slice(0, 36).forEach(function (t, i) {
        var li = el('li');
        var sp = el('span', '', shortNames[i]);
        sp.title = t;
        li.appendChild(sp);
        ol.appendChild(li);
      });
      back.appendChild(ol);
      back.appendChild(el('small', '', 'RELEASE ' + data.date));
      var spine = el('div', 'cd-f cd-spine');
      spine.appendChild(el('span', '', data.title));
      cd.appendChild(tray); cd.appendChild(back); cd.appendChild(spine); cd.appendChild(door);
      ['cd-right', 'cd-top', 'cd-bottom'].forEach(function (c) { cd.appendChild(el('div', 'cd-f ' + c)); });
      stage.appendChild(cd);

      var bar = el('div', 'cd-bar');
      var openBtn = el('button', 'cd-btn', 'ケースを開く');
      var flip = el('button', 'cd-btn', '裏返す');
      var listBtn = el('button', 'cd-btn', '収録曲を見る');
      [openBtn, flip, listBtn].forEach(function (b) { b.type = 'button'; bar.appendChild(b); });
      listBtn.hidden = true;
      var hint = el('p', 'cd-hint', 'ドラッグで回転');
      // 収録曲の一覧(ふつうの文字。裏面で見切れるときに使う)
      var panel = el('div', 'cd-list');
      panel.hidden = true;
      var head = el('div', 'cd-list-head');
      var ht = el('div');
      ht.appendChild(el('h3', '', data.title));
      ht.appendChild(el('p', '', (data.artist ? data.artist + ' \u00b7 ' : '') + tracks.length + '曲'));
      var listX = el('button', 'cd-btn', '閉じる');
      listX.type = 'button';
      head.appendChild(ht); head.appendChild(listX);
      panel.appendChild(head);
      var pol = el('ol');
      tracks.forEach(function (t) { pol.appendChild(el('li', '', t)); });
      panel.appendChild(pol);
      [close, stage, bar, hint, panel].forEach(function (n) { overlay.appendChild(n); });
      document.body.appendChild(overlay);
      document.documentElement.style.overflow = 'hidden';
      requestAnimationFrame(function () { overlay.classList.add('on'); });
      close.focus();

      // 曲が多いときの裏面: 1列・2列・3列を、それぞれ「はみ出さなくなるまで文字を小さく」して試し、曲名が切れる数がいちばん少ない並びを選ぶ。
      // (切れる数が同じなら、文字が大きい並びを選ぶ)それでも切れる曲名があるとき(や、曲が多いとき)は、「収録曲を見る」(ふつうの文字の一覧)を出す
      function fit() {
        var over = function () { return ol.scrollHeight > ol.clientHeight + 1 || ol.scrollWidth > ol.clientWidth + 1; };
        var cuts = function () { return [].filter.call(ol.querySelectorAll('span'), function (sp) { return sp.scrollWidth > sp.clientWidth + 1; }).length; };
        function trial(cls) {
          ol.className = cls;
          ol.style.removeProperty('--tf');
          var size = parseFloat(getComputedStyle(ol.firstChild || ol).fontSize) || 10, n = 0;
          while (over() && size > 6.5 && n++ < 40) { size -= 0.3; ol.style.setProperty('--tf', size.toFixed(1) + 'px'); }
          return { cls: cls, size: size, over: over(), cut: cuts() };
        }
        var cands = tracks.length <= 8 ? [''] : ['', 'two', 'three'];
        var best = null;
        cands.forEach(function (c) { var t = trial(c); if (!t.over && (!best || t.cut < best.cut || (t.cut === best.cut && t.size > best.size + 0.05))) best = t; });
        if (!best) best = trial(cands[cands.length - 1]);
        ol.className = best.cls;
        ol.style.setProperty('--tf', best.size.toFixed(1) + 'px');
        listBtn.hidden = !(best.over || best.cut || tracks.length > 12);
      }
      fit();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (overlay) fit(); });

      // 回転: ドラッグで ry(左右)・rx(上下)が変わる。離したあとは、勢いが少し残る。何もしないでいると、ゆっくり回る
      var rx = -10, ry = calm ? -24 : -70, vx = 0, vy = 0, drag = false, lx = 0, ly = 0, idle = !calm, target = null, raf = 0, opened = false;
      function apply() { cd.style.transform = 'rotateX(' + rx.toFixed(2) + 'deg) rotateY(' + ry.toFixed(2) + 'deg)'; }
      function toward(angle) { target = Math.round(ry / 360) * 360 + angle; } // いまの向きにいちばん近い、目標の向き
      function tick() {
        if (!overlay) return;
        if (target !== null) { // 目標の角度へ、なめらかに近づく
          ry += (target - ry) * 0.12;
          rx += (-10 - rx) * 0.12;
          if (Math.abs(target - ry) < 0.3) { ry = target; target = null; }
        } else if (!drag) {
          ry += vy; rx += vx;
          vy *= 0.94; vx *= 0.94;
          if (idle && !opened && Math.abs(vy) < 0.05) ry += 0.22; // ゆっくり回る(ケースを開いているときは、回らない)
        }
        rx = Math.max(-55, Math.min(55, rx));
        if (opened && target === null) { var base = Math.round(ry / 360) * 360; ry = Math.max(base - 80, Math.min(base + 80, ry)); } // 開いているあいだは、表側から±80度までしか回らない(裏側からは見せない)
        apply();
        raf = requestAnimationFrame(tick);
      }
      if (!calm) toward(-24); // 開くときに、少し回りながら現れる
      apply();
      raf = requestAnimationFrame(tick);
      stage.addEventListener('pointerdown', function (e) {
        drag = true; idle = false; target = null; lx = e.clientX; ly = e.clientY; vx = vy = 0;
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener('pointermove', function (e) {
        if (!drag) return;
        var dx = e.clientX - lx, dy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        ry += dx * 0.6; rx -= dy * 0.4;
        vy = dx * 0.25; vx = -dy * 0.15;
      });
      function up() { drag = false; }
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
      function turn() { if (opened) return; idle = false; vy = vx = 0; target = Math.round(ry / 180) * 180 + 180; } // 裏返すのは、ケースを閉じているときだけ
      flip.addEventListener('click', turn);
      stage.addEventListener('dblclick', turn);
      openBtn.addEventListener('click', function () { // 表紙を開く(中のディスクが見える向きに、ケースを少し回す)/ 閉じる
        opened = !opened;
        idle = false; vy = vx = 0;
        flip.disabled = opened;
        overlay.classList.toggle('open', opened);
        openBtn.textContent = opened ? 'ケースを閉じる' : 'ケースを開く';
        toward(opened ? -14 : -24);
      });
      listBtn.addEventListener('click', function () { panel.hidden = !panel.hidden; listBtn.textContent = panel.hidden ? '収録曲を見る' : '収録曲を閉じる'; if (!panel.hidden) listX.focus(); });
      listX.addEventListener('click', function () { listBtn.click(); listBtn.focus(); });
      var buttons = [close, openBtn, flip, listBtn, listX];
      function shut() {
        if (!overlay) return;
        var o = overlay;
        overlay = null;
        cancelAnimationFrame(raf);
        o.classList.remove('on');
        document.removeEventListener('keydown', onKey);
        document.documentElement.style.overflow = '';
        setTimeout(function () { o.remove(); }, 320);
        cover.focus();
      }
      function onKey(e) {
        if (e.key === 'Escape') { if (!panel.hidden) { listBtn.click(); } else { shut(); } }
        else if (e.key === 'Tab') { // フォーカスを、表示の中に閉じ込める
          e.preventDefault();
          var vis = buttons.filter(function (b) { return !b.hidden && !b.disabled && b.offsetParent !== null; });
          var i = vis.indexOf(document.activeElement);
          vis[(i + (e.shiftKey ? vis.length - 1 : 1)) % vis.length].focus();
        }
        else if (e.key === 'ArrowLeft') { idle = false; ry -= 12; } else if (e.key === 'ArrowRight') { idle = false; ry += 12; }
      }
      document.addEventListener('keydown', onKey);
      close.addEventListener('click', shut);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) shut(); });
    }
    cover.addEventListener('click', open);
    cover.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  })();

  // ---- オフボーカル・歌詞のダウンロードボタンを押したときの確認(「ガイドラインを確認しましたか」)。同意すると、ダウンロードが始まる ----
  // 同じ訪問(タブを閉じるまで)のあいだは、一度同意したら、聞き直さない。JavaScript が使えない環境では、確認なしで、そのままダウンロードされる
  (function () {
    if (!document.querySelector('.downloads, .ov-list')) return;
    var KEY = 'dl-agreed';
    var agreed = function () { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
    var remember = function () { try { sessionStorage.setItem(KEY, '1'); } catch (e) {} };
    function start(a) { // 確認が済んだあと、ダウンロードを始める(押したリンクと同じものを、もう一度押す)
      var go = document.createElement('a');
      go.href = a.href;
      go.setAttribute('download', '');
      if (/^https?:/.test(a.getAttribute('href'))) go.rel = 'noopener';
      go.style.display = 'none';
      document.body.appendChild(go);
      go.click();
      go.remove();
    }
    function ask(a) {
      var modal = document.createElement('div');
      modal.className = 'dl-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', 'dl-title');
      var card = document.createElement('div');
      card.className = 'dl-card';
      var h = document.createElement('h2');
      h.id = 'dl-title';
      h.textContent = 'ダウンロードの前に';
      var p = document.createElement('p');
      p.textContent = 'オフボーカル・歌詞のご利用には、二次利用ガイドラインの確認が必要です。';
      card.appendChild(h);
      card.appendChild(p);
      var holder = a.closest('[data-guideline]');
      var g = holder && holder.dataset.guideline;
      if (g) {
        var link = document.createElement('a');
        link.className = 'dl-read';
        link.href = g;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'ガイドライン全文を読む(note) \u2197';
        card.appendChild(link);
        card.appendChild(document.createElement('br'));
      }
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      label.appendChild(cb);
      label.appendChild(document.createTextNode('ガイドラインを確認し、内容に同意します'));
      card.appendChild(label);
      var acts = document.createElement('div');
      acts.className = 'dl-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'キャンセル';
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'dl-go';
      ok.textContent = 'ダウンロード';
      ok.disabled = true;
      acts.appendChild(cancel);
      acts.appendChild(ok);
      card.appendChild(acts);
      modal.appendChild(card);
      document.body.appendChild(modal);
      requestAnimationFrame(function () { modal.classList.add('on'); });
      cb.focus();
      function shut() {
        document.removeEventListener('keydown', onKey);
        modal.classList.remove('on');
        setTimeout(function () { modal.remove(); }, 220);
        a.focus();
      }
      function onKey(e) {
        if (e.key === 'Escape') shut();
        else if (e.key === 'Tab') { // フォーカスを、ダイアログの中に閉じ込める
          var items = [].filter.call(modal.querySelectorAll('a[href], input, button'), function (n) { return !n.disabled; });
          var i = items.indexOf(document.activeElement);
          e.preventDefault();
          items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
        }
      }
      document.addEventListener('keydown', onKey);
      cb.addEventListener('change', function () { ok.disabled = !cb.checked; });
      cancel.addEventListener('click', shut);
      modal.addEventListener('click', function (e) { if (e.target === modal) shut(); });
      ok.addEventListener('click', function () { remember(); shut(); start(a); });
    }
    document.addEventListener('click', function (e) {
      var a = e.target.closest('.downloads a.btn.dl, .ov-list a.btn.dl');
      if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 通常のクリックだけ(新しいタブで開くなどは、そのまま)
      if (agreed()) return; // この訪問では、すでに同意済み
      e.preventDefault();
      ask(a);
    });
  })();

  // ---- 背景動画のレンズ(マウスのある端末だけ) ----
  if (!fine || calm) return;

  // 背景動画が表示されているときだけ、カーソルの周りのモザイクが消えて映像がクリアに見える(レンズ)。
  // 文字そのもの(READING)の上ではレンズを閉じて、視認性を守る。文字の横の余白ではレンズが開く。
  var LENS_R = 100;
  var READING = '.logo, .tagline, .nav a, .sns a, .rpanel.open, .about, .top, .work, .foot';
  var ring = null; // レンズの縁(背景動画があるページだけ作る)
  var tx = 0, ty = 0, x = 0, y = 0, r = 0, rt = 0, running = false, inside = false;
  if (bg) {
    ring = document.createElement('div');
    ring.className = 'cursor lens';
    document.body.appendChild(ring);
  }

  function lensActive() { return !!ring && bg.classList.contains('on'); }

  function loop() {
    x += (tx - x) * 0.18;
    y += (ty - y) * 0.18;
    r += (rt - r) * 0.14;
    ring.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    bg.style.setProperty('--mx', x.toFixed(1) + 'px');
    bg.style.setProperty('--my', y.toFixed(1) + 'px');
    bg.style.setProperty('--lr', Math.max(r, 0).toFixed(1) + 'px');
    var d = Math.max(r * 2, 14);
    ring.style.width = ring.style.height = d.toFixed(1) + 'px';
    ring.style.margin = (-d / 2).toFixed(1) + 'px 0 0 ' + (-d / 2).toFixed(1) + 'px';
    bg.style.setProperty('--fr', (Math.max(r, 0) * 2.6).toFixed(1) + 'px'); // 細かいモザイクの範囲(レンズの約2.6倍。文字の上でレンズが閉じると、これも閉じる)
    fineOn = inside && r > 6;
    ring.classList.toggle('on', inside && r > 6); // レンズが閉じている(文字・ボタンの上)ときは縁も出さない
    if (Math.abs(tx - x) > 0.1 || Math.abs(ty - y) > 0.1 || Math.abs(rt - r) > 0.3) {
      requestAnimationFrame(loop);
    } else {
      running = false;
    }
  }
  function kick() { if (!running) { running = true; requestAnimationFrame(loop); } }

  if (ring) {
    document.addEventListener('pointermove', function (e) {
      if (!lensActive()) { inside = false; ring.classList.remove('on'); return; }
      if (!inside) { x = tx = e.clientX; y = ty = e.clientY; }
      inside = true;
      tx = e.clientX; ty = e.clientY;
      rt = e.target.closest(READING) ? 0 : LENS_R;
      kick();
    });

    // ---- クリックの波紋: クリックした場所から、レンズが水の波紋のように広がる(同時に3つまで) ----
    var RIPPLE_MS = 1700; // 波が消えるまでの時間(確認用に、.bgvideo の data-ripple-ms で変えられる)
    var RIPPLE_R = 720;    // 波が広がる半径(px)
    var ripples = [null, null, null], rIdx = 0, rRunning = false;
    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function clearRipple(i) {
      var rp = ripples[i];
      if (!rp) return;
      ['x', 'y', 's', 'o'].forEach(function (k) { bg.style.removeProperty('--p' + i + k); });
      rp.el.remove();
      ripples[i] = null;
    }
    function rippleTick(now) {
      var any = false;
      ripples.forEach(function (rp, i) {
        if (!rp) return;
        var t = (now - rp.t0) / rp.ms;
        if (t >= 1) { clearRipple(i); return; }
        any = true;
        var ro = (rp.R || RIPPLE_R) * easeOut(t);  // 波の先端。円の内側は、広がっている間ずっとモザイクが外れたまま
        var fade = Math.max(0, (t - 0.65) / 0.35); // 終わり際だけ、円全体がいっせいに元のモザイクへ戻る(内側から外へ追いかける動きはしない)
        bg.style.setProperty('--p' + i + 's', (1 - fade * fade * (3 - 2 * fade)).toFixed(3));
        bg.style.setProperty('--p' + i + 'o', ro.toFixed(1) + 'px');
        rp.el.style.width = rp.el.style.height = (ro * 2).toFixed(1) + 'px';
        rp.el.style.opacity = (0.9 * Math.pow(1 - t, 1.3)).toFixed(3);
      });
      if (any) requestAnimationFrame(rippleTick); else rRunning = false;
    }
    function startRipple(px, py, ms, maxR) {
      var i = rIdx;
      rIdx = (rIdx + 1) % ripples.length;
      clearRipple(i);
      var el = document.createElement('div');
      el.className = 'ripple';
      el.style.left = px + 'px';
      el.style.top = py + 'px';
      el.style.transform = 'translate(-50%, -50%)';
      bg.appendChild(el);
      ripples[i] = { t0: performance.now(), el: el, ms: ms, R: maxR };
      bg.style.setProperty('--p' + i + 'x', px + 'px');
      bg.style.setProperty('--p' + i + 'y', py + 'px');
      bg.style.setProperty('--p' + i + 's', '1');
      bg.style.setProperty('--p' + i + 'o', '0px');
      if (!rRunning) { rRunning = true; requestAnimationFrame(rippleTick); }
    }
    document.addEventListener('pointerdown', function (e) {
      if (e.button || !lensActive()) return;
      if (e.target.closest('a, button, input, select, textarea, label, iframe, summary')) return; // 操作する部品の上では出さない
      startRipple(e.clientX, e.clientY, parseInt(bg.dataset.rippleMs, 10) || RIPPLE_MS, RIPPLE_R);
    });

    document.documentElement.addEventListener('pointerleave', function () {
      inside = false;
      ring.classList.remove('on');
      rt = 0;
      if (lensActive()) kick();
    });
  }

  // ジャケットがカーソルの方向に傾く
  var MAX = 10;
  document.querySelectorAll('.work-cover').forEach(function (el) {
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = 'perspective(700px) rotateX(' + (-py * MAX).toFixed(2) + 'deg) rotateY(' +
        (px * MAX).toFixed(2) + 'deg) scale(1.04)';
    });
    el.addEventListener('pointerleave', function () { el.style.transform = ''; });
  });
})();
