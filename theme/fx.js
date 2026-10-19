// サイト全体の演出。
//  - ページ遷移のフェード(「視差効果を減らす」設定では無効)
//  - 効果音の ON/OFF ボタン(初期は無音。ON にすると背景動画の音も小さく流れる)
//  - 背景動画のレンズ・ジャケットの傾き(マウスのある端末だけ。スマホでは無効)
(function () {
  var fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  var calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var TARGET = 'a, button';

  // ---- 背景動画(PCだけ読み込む)。作品の bg.mp4 クリップをシャッフルして順に再生。クリップがなければ YouTube ----
  var YT = 'https://www.youtube-nocookie.com';
  var VIDEO_VOLUME = 12; // 効果音 ON のときの動画の音量(0〜100)
  var bg = document.querySelector('.bgvideo');
  var frame = null; // YouTube の iframe
  var vids = null;  // 自前クリップの <video> 2本(交互に使ってクロスフェードする)
  var curVid = 0;

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
  // 効果音が ON のときだけ動画の音を小さく流す(OFF なら無音)
  function applyVideoSound() {
    if (vids) {
      vids.forEach(function (v) { v.volume = VIDEO_VOLUME / 100; v.muted = !soundOn; });
      var cv = vids[curVid];
      if (soundOn && cv.paused) {
        cv.play().catch(function () { cv.muted = true; cv.play().catch(function () {}); }); // 音つきの再生をブラウザが止めたとき
      }
      return;
    }
    if (!frame) return;
    if (soundOn) {
      ytCommand('setVolume', [VIDEO_VOLUME]);
      ytCommand('unMute');
    } else {
      ytCommand('mute');
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
    function ramp(v, from, to) { // 音量をなめらかに変える(クロスフェード中に2本が重なって聞こえないように)
      var n = 0, steps = 10;
      var timer = setInterval(function () {
        n++;
        v.volume = Math.max(0, Math.min(1, from + (to - from) * n / steps));
        if (n >= steps) clearInterval(timer);
      }, FADE * 100);
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
      if (soundOn) { inc.volume = 0; ramp(inc, 0, VIDEO_VOLUME / 100); ramp(out, VIDEO_VOLUME / 100, 0); }
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
      v.addEventListener('error', function () { // 読み込めないクリップは飛ばす
        load(v);
        if (v === vids[curVid]) v.play().catch(function () {});
      });
    });
    // 実際のモザイク: 動画を小さな canvas に縮小して描く(同じサイトの動画なので読み取れる)。レンズの中だけ、元の映像が見える
    function startMosaic() {
      var cell = parseInt(getComputedStyle(bg).getPropertyValue('--cell'), 10) || 14;
      var cv = document.createElement('canvas');
      var mid = document.createElement('canvas'); // いったん4倍の大きさに描いてから縮めると、平均に近い色になる
      cv.className = 'mosaic';
      bg.appendChild(cv);
      bg.classList.add('px');
      var ctx = cv.getContext('2d'), mctx = mid.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      mctx.imageSmoothingQuality = 'high';
      function size() {
        cv.width = Math.max(8, Math.ceil(innerWidth / cell));
        cv.height = Math.max(8, Math.ceil(innerHeight / cell));
        mid.width = cv.width * 4;
        mid.height = cv.height * 4;
      }
      size();
      window.addEventListener('resize', size);
      function draw(v, alpha) {
        if (!v.videoWidth || v.readyState < 2) return;
        var s = Math.max(mid.width / v.videoWidth, mid.height / v.videoHeight); // object-fit: cover と同じ切り取り
        var sw = mid.width / s, sh = mid.height / s;
        mctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, mid.width, mid.height);
        ctx.globalAlpha = alpha;
        ctx.drawImage(mid, 0, 0, cv.width, cv.height);
      }
      var lastT = 0;
      (function tick(t) {
        requestAnimationFrame(tick);
        if (document.hidden || t - lastT < 33) return; // 30fps で十分
        lastT = t;
        if (xf && t - xf.t0 < FADE * 1000) {
          var k = Math.max(0, (t - xf.t0) / (FADE * 1000));
          draw(xf.out, 1);
          draw(xf.inc, k);
        } else {
          xf = null;
          draw(vids[curVid], 1);
        }
      })(0);
    }
    if (bg.dataset.mosaic === 'pixel') startMosaic();

    a.addEventListener('playing', function once() {
      a.removeEventListener('playing', once);
      a.classList.add('front');
      showBackground();
      applyVideoSound();
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
      setTimeout(applyVideoSound, 2500);
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
        applyVideoSound();
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
    var start = panelEls[hashName] ? hashName : (saved === 'none' ? '' : (panelEls[saved] ? saved : 'works'));
    openPanel(start);
    pLinks.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        openPanel(document.body.dataset.panel === a.dataset.panel ? '' : a.dataset.panel);
      });
    });
  }

  // ---- 依頼受付フォーム: 入力内容をメールの下書きにする(送信はメールアプリで) ----
  var reqForm = document.querySelector('form.req');
  if (reqForm) {
    var kindSel = reqForm.elements['種類'];
    var mixbox = reqForm.querySelector('.mixbox');
    var est = reqForm.querySelector('.est');
    var yen = function (n) { return '\u00a5' + n.toLocaleString('ja-JP'); };
    var mixOn = function () { // 「MIX・Mastering」が選ばれているか
      var o = kindSel.selectedIndex >= 0 ? kindSel.options[kindSel.selectedIndex] : null;
      return !!(o && o.dataset.mix);
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
      if (base === '') return { plan: planOpt.value, options: names, total: null, text: 'プランの料金は、内容を確認のうえ、ご相談になります。' };
      var total = Number(base);
      opts.forEach(function (o) { if (o.dataset.price !== '') total += Number(o.dataset.price); });
      return { plan: planOpt.value, options: names, total: total,
        text: 'お見積りの目安(税込): ' + yen(total) + '  ※人数などで変わることがあります。正式なお見積りは、内容を確認してご連絡します。' };
    };
    var refresh = function () {
      if (!est) return;
      var q = quote();
      est.hidden = !q;
      if (q) est.textContent = q.text;
    };
    reqForm.addEventListener('change', function (e) {
      if (e.target === kindSel) syncMix(); else refresh();
    });
    syncMix();

    var mailtoFor = function () {
      var f = reqForm.elements;
      var q = quote();
      var lines = ['お名前: ' + f['お名前'].value, '返信先: ' + f['返信先'].value, 'ご依頼の内容: ' + kindSel.value];
      if (mixOn()) {
        lines.push('ご依頼のプラン: ' + (q ? q.plan : '(未選択)'));
        lines.push('オプション: ' + (q && q.options.length ? q.options.join('、') : 'なし'));
        lines.push('お見積りの目安: ' + (q ? (q.total === null ? '要相談' : yen(q.total) + '(税込・目安)') : '-'));
      }
      lines.push('ご希望の納期: ' + (f['納期'].value || '(未記入)'));
      var body = lines.join('\n') + '\n\n【詳細・ご要望】\n' + f['内容'].value + '\n';
      var short = q ? 'MIX・Mastering(' + q.plan.split(' / ').pop() + ')' : kindSel.value;
      return 'mailto:' + reqForm.dataset.to + '?subject=' +
        encodeURIComponent('【依頼】' + short + ' / ' + f['お名前'].value) + '&body=' + encodeURIComponent(body);
    };
    reqForm.mailtoFor = mailtoFor; // (確認用に公開しておく)
    reqForm.addEventListener('submit', function (e) {
      e.preventDefault();
      location.href = mailtoFor();
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
      document.body.classList.add('leaving');
      setTimeout(function () { location.href = u.href; }, 250);
    });
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) document.body.classList.remove('leaving');
    });
  }

  // ---- 効果音(Web Audio で合成。音源ファイルは不要) ----
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null;
  var soundOn = false;
  try { soundOn = localStorage.getItem('sound') === 'on'; } catch (err) {}

  function ready(fn) {
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'running') { fn(ctx); return; }
    ctx.resume().then(function () { fn(ctx); }).catch(function () {});
  }

  function blip(freq, to, dur, type, vol, delay) {
    ready(function (c) {
      var t = c.currentTime + (delay || 0);
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + dur + 0.03);
    });
  }

  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sound';
  btn.setAttribute('aria-label', '効果音の切り替え');
  function render() {
    btn.textContent = '♪ ' + (soundOn ? 'ON' : 'OFF');
    btn.setAttribute('aria-pressed', soundOn);
  }
  render();
  document.body.appendChild(btn);

  btn.addEventListener('click', function () {
    soundOn = !soundOn;
    try { localStorage.setItem('sound', soundOn ? 'on' : 'off'); } catch (err) {}
    render();
    applyVideoSound();
    if (soundOn) {
      [523.25, 659.25, 783.99].forEach(function (f, i) { blip(f, f * 1.01, 0.22, 'sine', 0.06, i * 0.09); });
    }
  });

  // 前のページで ON にしていた場合、最初の操作で動画の音を有効にする(ブラウザの自動再生制限のため)
  document.addEventListener('pointerdown', function () { if (soundOn) applyVideoSound(); }, { once: true });

  document.addEventListener('click', function (e) {
    if (!soundOn || e.target.closest('.sound') || !e.target.closest(TARGET)) return;
    blip(330, 170, 0.11, 'triangle', 0.09);
  });

  if (fine) {
    var NOTES = [523.25, 587.33, 659.25, 783.99, 880];
    var last = null, lastT = 0;
    document.addEventListener('pointerover', function (e) {
      if (!soundOn) return;
      var t = e.target.closest(TARGET);
      if (!t || t === last || t === btn) return;
      last = t;
      var now = performance.now();
      if (now - lastT < 60) return;
      lastT = now;
      var f = NOTES[Math.floor(Math.random() * NOTES.length)];
      blip(f, f * 1.02, 0.16, 'sine', 0.05);
    });
    document.addEventListener('pointerout', function (e) {
      if (last && !last.contains(e.relatedTarget)) last = null;
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

  // ---- 背景動画のレンズ(マウスのある端末だけ) ----
  if (!fine || calm) return;

  // 背景動画が表示されているときだけ、カーソルの周りのモザイクが消えて映像がクリアに見える(レンズ)。
  // 文字そのもの(READING)の上ではレンズを閉じて、視認性を守る。文字の横の余白ではレンズが開く。
  var LENS_R = 100;
  var READING = '.logo, .tagline, .nav a, .sns a, .rpanel.open, .about, .sound, .top, .work, .foot';
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
    var RIPPLE_MS = 1100; // 波が消えるまでの時間(確認用に、.bgvideo の data-ripple-ms で変えられる)
    var RIPPLE_R = 560;    // 波が広がる半径(px)
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
        var ro = RIPPLE_R * easeOut(t);  // 波の先端。円の内側は、広がっている間ずっとモザイクが外れたまま
        var fade = Math.max(0, (t - 0.65) / 0.35); // 終わり際だけ、円全体がいっせいに元のモザイクへ戻る(内側から外へ追いかける動きはしない)
        bg.style.setProperty('--p' + i + 's', (1 - fade * fade * (3 - 2 * fade)).toFixed(3));
        bg.style.setProperty('--p' + i + 'o', ro.toFixed(1) + 'px');
        rp.el.style.width = rp.el.style.height = (ro * 2).toFixed(1) + 'px';
        rp.el.style.opacity = (0.9 * Math.pow(1 - t, 1.3)).toFixed(3);
      });
      if (any) requestAnimationFrame(rippleTick); else rRunning = false;
    }
    document.addEventListener('pointerdown', function (e) {
      if (e.button || !lensActive()) return;
      if (e.target.closest('a, button, input, select, textarea, label, iframe, summary')) return; // 操作する部品の上では出さない
      var i = rIdx;
      rIdx = (rIdx + 1) % ripples.length;
      clearRipple(i);
      var el = document.createElement('div');
      el.className = 'ripple';
      el.style.left = e.clientX + 'px';
      el.style.top = e.clientY + 'px';
      el.style.transform = 'translate(-50%, -50%)';
      bg.appendChild(el);
      ripples[i] = { t0: performance.now(), el: el, ms: parseInt(bg.dataset.rippleMs, 10) || RIPPLE_MS };
      bg.style.setProperty('--p' + i + 'x', e.clientX + 'px');
      bg.style.setProperty('--p' + i + 'y', e.clientY + 'px');
      bg.style.setProperty('--p' + i + 's', '1');
      bg.style.setProperty('--p' + i + 'o', '0px');
      if (!rRunning) { rRunning = true; requestAnimationFrame(rippleTick); }
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
