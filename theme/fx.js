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
  var vid = null;   // 自前クリップの <video>

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
    if (vid) {
      vid.volume = VIDEO_VOLUME / 100;
      vid.muted = !soundOn;
      if (soundOn && vid.paused) {
        vid.play().catch(function () { vid.muted = true; vid.play().catch(function () {}); }); // 音つきの再生をブラウザが止めたとき
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

  function startClips() {
    var list = shuffle(bg.dataset.clips.split(',').filter(Boolean));
    var i = 0, failed = 0;
    vid = bg.querySelector('video');
    vid.loop = list.length < 2;
    function next() {
      i = (i + 1) % list.length;
      vid.src = list[i];
      vid.play().catch(function () {});
    }
    vid.addEventListener('ended', next);
    vid.addEventListener('error', function () { if (++failed < list.length) next(); });
    vid.addEventListener('playing', function once() {
      vid.removeEventListener('playing', once);
      showBackground();
      applyVideoSound();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) vid.pause(); else vid.play().catch(function () {});
    });
    vid.src = list[0];
    vid.play().catch(function () {});
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
  var READING = '.logo, .tagline, .nav a, .sns a, .works-list .row, .works-list .chip, .about, .sound, .top, .work, .foot';
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
