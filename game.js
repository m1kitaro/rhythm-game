(() => {
  'use strict';

  // ---- 定数 ----
  const W = 480, H = 640;               // 論理サイズ（canvasの描画座標系）
  const LANES = 4;
  const KEYS = ['d', 'f', 'j', 'k'];    // レーン0..3
  const LANE_COLORS = ['#ff5d8f', '#ffb347', '#4cd7a1', '#5db8ff'];
  const JUDGE_Y = 540;                  // 判定ラインのy
  const NOTE_H = 18;
  const FALL_SEC = 1.5;                 // 画面上端から判定ラインまでの落下時間
  const LEAD_IN = 2.0;                  // 開始前の余白（秒）
  const WINDOW = { perfect: 0.045, great: 0.09, good: 0.14 }; // 判定幅（秒）
  const MISS_AFTER = 0.14;              // これを過ぎた未入力ノートはMISS
  const WEIGHT = { perfect: 1, great: 0.7, good: 0.4, miss: 0 };
  const MAX_SCORE = 1000000;
  const JUDGE_TEXT = { perfect: 'PERFECT', great: 'GREAT', good: 'GOOD', miss: 'MISS' };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const screens = { menu: $('screen-menu'), game: $('screen-game'), result: $('screen-result') };
  const canvas = $('game');
  const g = canvas.getContext('2d');
  const judgeEl = $('judge');

  function show(name) {
    for (const k of Object.keys(screens)) screens[k].hidden = k !== name;
  }

  // ---- canvas 初期化（高DPI対応）----
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.style.touchAction = 'none';

  // ---- 状態 ----
  let actx = null;
  let state = null;     // プレイ中の状態
  let rafId = 0;
  let currentChart = null;
  const lit = new Array(LANES).fill(0); // レーンの押下エフェクト残り時間

  function getAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }

  // ---- 音 ----
  function blip(when, freq, dur, vol, type) {
    const o = actx.createOscillator();
    const gn = actx.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, when);
    gn.gain.setValueAtTime(0.0001, when);
    gn.gain.exponentialRampToValueAtTime(vol, when + 0.005);
    gn.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(gn).connect(actx.destination);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  const LANE_FREQ = [523.25, 659.25, 783.99, 987.77]; // C5 E5 G5 B5

  function hitSound(lane, judge) {
    const v = judge === 'perfect' ? 0.22 : 0.16;
    blip(actx.currentTime, LANE_FREQ[lane], 0.12, v, 'triangle');
  }

  function missSound() {
    blip(actx.currentTime, 110, 0.12, 0.08, 'sawtooth');
  }

  // メトロノーム（拍の頭を少し強く）。先読みでスケジュール
  function scheduleClicks(s) {
    const spb = 60 / s.chart.bpm;
    const horizon = actx.currentTime + 0.3;
    while (true) {
      const when = s.start + s.nextBeat * spb;
      if (when > horizon) break;
      if (when >= actx.currentTime - 0.02) {
        const strong = s.nextBeat % 4 === 0;
        blip(Math.max(when, actx.currentTime), strong ? 1500 : 1100, 0.04, strong ? 0.07 : 0.04, 'square');
      }
      s.nextBeat++;
    }
  }

  // ---- メニュー ----
  function buildMenu() {
    const list = $('chart-list');
    list.textContent = '';
    const charts = window.CHARTS;
    if (!Array.isArray(charts) || charts.length === 0) {
      const li = document.createElement('li');
      li.textContent = '譜面が読み込まれていません（charts.js）';
      list.appendChild(li);
      return;
    }
    charts.forEach((c, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-btn';
      const t = document.createElement('span');
      t.className = 'chart-title';
      t.textContent = c.title;
      const m = document.createElement('span');
      m.className = 'chart-meta';
      m.textContent = `BPM ${c.bpm} / ${c.notes.length} notes`;
      b.append(t, m);
      b.addEventListener('click', () => startGame(i));
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  // ---- ゲーム開始 / 終了 ----
  function startGame(index) {
    const chart = window.CHARTS[index];
    if (!chart) return;
    currentChart = index;
    getAudio();

    const notes = chart.notes
      .map((n) => ({ t: n.t, lane: n.lane, state: 'idle' }))
      .sort((a, b) => a.t - b.t);

    state = {
      chart,
      notes,
      start: actx.currentTime + LEAD_IN,   // 譜面時刻0に対応するAudio時刻
      nextBeat: 0,
      score: 0,
      combo: 0,
      maxCombo: 0,
      counts: { perfect: 0, great: 0, good: 0, miss: 0 },
      resolved: 0,
      endAt: 0,
    };
    const last = notes.length ? notes[notes.length - 1].t : 0;
    state.endAt = state.start + (chart.offset || 0) + last + 1.2;

    $('hud-title').textContent = chart.title;
    $('hud-score').textContent = '0';
    $('hud-combo').textContent = '';
    judgeEl.textContent = '';
    lit.fill(0);
    show('game');
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  function stopGame() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    state = null;
  }

  function noteTime(s, n) {
    return s.start + (s.chart.offset || 0) + n.t;
  }

  // ---- 判定 ----
  function showJudge(j) {
    judgeEl.textContent = JUDGE_TEXT[j];
    judgeEl.dataset.judge = j;
    // CSSアニメーション再起動用
    judgeEl.classList.remove('pop');
    void judgeEl.offsetWidth;
    judgeEl.classList.add('pop');
  }

  function resolve(s, note, judge) {
    note.state = judge === 'miss' ? 'miss' : 'hit';
    s.resolved++;
    s.counts[judge]++;
    if (judge === 'miss') {
      s.combo = 0;
    } else {
      s.combo++;
      if (s.combo > s.maxCombo) s.maxCombo = s.combo;
      s.score += (MAX_SCORE / s.notes.length) * WEIGHT[judge];
    }
    $('hud-score').textContent = String(Math.round(s.score));
    $('hud-combo').textContent = s.combo >= 2 ? `${s.combo} COMBO` : '';
    showJudge(judge);
  }

  function press(lane) {
    if (!state) return;
    lit[lane] = 0.12;
    const s = state;
    const now = actx.currentTime;
    // このレーンで最も近い未処理ノートを探す
    let best = null, bestAbs = Infinity;
    for (const n of s.notes) {
      if (n.lane !== lane || n.state !== 'idle') continue;
      const dt = now - noteTime(s, n);
      if (dt < -WINDOW.good) break;         // ソート済みなのでこれ以降は遠い
      const a = Math.abs(dt);
      if (a <= WINDOW.good && a < bestAbs) { best = n; bestAbs = a; }
    }
    if (!best) return;
    const judge = bestAbs <= WINDOW.perfect ? 'perfect' : bestAbs <= WINDOW.great ? 'great' : 'good';
    hitSound(lane, judge);
    resolve(s, best, judge);
  }

  // ---- メインループ ----
  function loop() {
    const s = state;
    if (!s) return;
    const now = actx.currentTime;

    scheduleClicks(s);

    for (const n of s.notes) {
      if (n.state === 'idle' && now - noteTime(s, n) > MISS_AFTER) {
        resolve(s, n, 'miss');
        missSound();
      }
    }

    draw(s, now);

    if (s.resolved >= s.notes.length && now >= s.endAt) {
      finish(s);
      return;
    }
    rafId = requestAnimationFrame(loop);
  }

  // ---- 描画 ----
  function draw(s, now) {
    g.clearRect(0, 0, W, H);
    const laneW = W / LANES;

    g.fillStyle = '#0d0f1a';
    g.fillRect(0, 0, W, H);

    // レーン背景 + 押下エフェクト
    for (let i = 0; i < LANES; i++) {
      const x = i * laneW;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)';
      g.fillRect(x, 0, laneW, H);
      if (lit[i] > 0) {
        const grd = g.createLinearGradient(0, JUDGE_Y - 220, 0, JUDGE_Y);
        grd.addColorStop(0, 'rgba(255,255,255,0)');
        grd.addColorStop(1, hexA(LANE_COLORS[i], 0.45));
        g.fillStyle = grd;
        g.fillRect(x, JUDGE_Y - 220, laneW, 220);
      }
    }
    // レーン区切り
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    for (let i = 1; i < LANES; i++) {
      g.beginPath();
      g.moveTo(i * laneW + 0.5, 0);
      g.lineTo(i * laneW + 0.5, H);
      g.stroke();
    }

    // 判定ライン
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(0, JUDGE_Y - 2, W, 4);

    // ノート
    const travel = JUDGE_Y;
    for (const n of s.notes) {
      if (n.state !== 'idle') continue;
      const remain = noteTime(s, n) - now;
      if (remain > FALL_SEC) break;         // ソート済み
      const y = JUDGE_Y - (remain / FALL_SEC) * travel;
      const x = n.lane * laneW;
      g.fillStyle = LANE_COLORS[n.lane];
      roundRect(x + 6, y - NOTE_H / 2, laneW - 12, NOTE_H, 6);
      g.fill();
    }

    // キー表示
    g.font = 'bold 20px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < LANES; i++) {
      const cx = i * laneW + laneW / 2;
      g.fillStyle = lit[i] > 0 ? LANE_COLORS[i] : 'rgba(255,255,255,0.5)';
      g.fillText(KEYS[i].toUpperCase(), cx, JUDGE_Y + 50);
    }

    // 押下エフェクトの減衰（フレーム単位の近似）
    for (let i = 0; i < LANES; i++) if (lit[i] > 0) lit[i] = Math.max(0, lit[i] - 1 / 60);

    // 開始カウントダウン
    const untilStart = s.start - now;
    if (untilStart > 0) {
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.font = 'bold 56px system-ui, sans-serif';
      g.fillText(String(Math.ceil(untilStart)), W / 2, H / 2 - 60);
    }
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function hexA(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  // ---- リザルト ----
  function rankOf(score) {
    if (score >= 950000) return 'S';
    if (score >= 850000) return 'A';
    if (score >= 700000) return 'B';
    if (score >= 500000) return 'C';
    return 'D';
  }

  function finish(s) {
    stopGame();
    const score = Math.round(s.score);
    $('result-title').textContent = s.chart.title;
    $('result-rank').textContent = `${rankOf(score)}  ${score}`;
    const dl = $('result-stats');
    dl.textContent = '';
    const rows = [
      ['PERFECT', s.counts.perfect],
      ['GREAT', s.counts.great],
      ['GOOD', s.counts.good],
      ['MISS', s.counts.miss],
      ['MAX COMBO', s.maxCombo],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = String(v);
      dl.append(dt, dd);
    }
    show('result');
  }

  // ---- 入力 ----
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const lane = KEYS.indexOf(e.key.toLowerCase());
    if (lane >= 0 && state) {
      e.preventDefault();
      press(lane);
    } else if (e.key === 'Escape' && state) {
      stopGame();
      show('menu');
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const lane = Math.min(LANES - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * LANES)));
    press(lane);
  });

  $('btn-quit').addEventListener('click', () => { stopGame(); show('menu'); });
  $('btn-retry').addEventListener('click', () => { if (currentChart != null) startGame(currentChart); });
  $('btn-menu').addEventListener('click', () => show('menu'));

  // タブが隠れるとAudio時計だけ進んでしまうので、メニューに戻す
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state) { stopGame(); show('menu'); }
  });

  buildMenu();
  show('menu');
})();
