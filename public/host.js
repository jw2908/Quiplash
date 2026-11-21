(() => {
  const $ = id => document.getElementById(id);
  const socket = io();
  const scenes = ['connecting', 'lobby', 'intro', 'answering', 'duel', 'finalAnswering', 'finalBoard', 'scores', 'gameover'];
  let state = null;
  let session = JSON.parse(sessionStorage.getItem('pb_host') || 'null');
  let timerEnd = null;
  let lastPhaseKey = null;

  // ---------- fit the 1920x1080 stage to any screen ----------
  function fit() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    $('stage').style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  window.addEventListener('resize', fit);
  fit();

  // ---------- keep the TV awake where supported ----------
  async function wake() {
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (_) { /* not supported */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  wake();

  // ---------- tiny synth sounds (no audio files needed) ----------
  let audio = null;
  function unlockAudio() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
    if (audio && audio.state === 'suspended') audio.resume();
  }
  function tone(freq, dur = 0.15, type = 'square', when = 0, vol = 0.08) {
    if (!audio || audio.state !== 'running') return;
    const t = audio.currentTime + when;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  const sfx = {
    join: () => { tone(660, 0.1); tone(990, 0.12, 'square', 0.08); },
    intro: () => [392, 523, 659, 784].forEach((f, i) => tone(f, 0.18, 'triangle', i * 0.12, 0.12)),
    reveal: () => { tone(220, 0.08, 'sawtooth'); tone(330, 0.2, 'square', 0.08); },
    knockout: () => [880, 660, 440, 220].forEach((f, i) => tone(f, 0.2, 'sawtooth', i * 0.09, 0.1)),
    tick: () => tone(1200, 0.04, 'square', 0, 0.04),
    win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', i * 0.14, 0.12)),
  };
  document.addEventListener('click', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  // ---------- room setup ----------
  function create() {
    socket.emit('host:create', null, res => {
      session = res;
      sessionStorage.setItem('pb_host', JSON.stringify(res));
    });
  }
  socket.on('connect', () => {
    if (session) {
      socket.emit('host:rejoin', session, res => { if (!res || res.error) { session = null; create(); } });
    } else create();
  });
  socket.on('disconnect', () => { $('connecting-msg').textContent = 'Reconnecting…'; show('connecting'); });

  fetch('/info').then(r => r.json()).then(info => {
    let url = info.publicUrl || location.origin;
    if (!info.publicUrl && /^(localhost|127\.)/.test(location.hostname) && info.lan.length) {
      url = `http://${info.lan[0]}:${info.port}`;
    }
    $('join-url').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }).catch(() => { $('join-url').textContent = location.host; });

  // ---------- controls ----------
  $('start-btn').addEventListener('click', () => { unlockAudio(); socket.emit('game:start'); });
  $('again-btn').addEventListener('click', () => socket.emit('game:lobby'));
  $('new-room-btn').addEventListener('click', () => { sessionStorage.removeItem('pb_host'); location.reload(); });
  document.querySelectorAll('[data-skip]').forEach(b => b.addEventListener('click', () => socket.emit('game:skip')));

  // ---------- helpers ----------
  function show(name) {
    for (const s of scenes) $(s).classList.toggle('hidden', s !== name);
    // Give the remote something sensible to land on.
    const focusable = $(name).querySelector('button.tv-focus:not([disabled])');
    if (focusable && document.activeElement !== focusable && !$(name).contains(document.activeElement)) focusable.focus();
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function sticker(name, color, cls) {
    const s = el('span', 'sticker' + (cls ? ' ' + cls : ''), name);
    s.style.background = color;
    return s;
  }
  function statusRow(target, s) {
    const box = $(target);
    box.innerHTML = '';
    const waiting = new Set(s.waitingOn || []);
    for (const p of s.players) {
      if (!p.connected) continue;
      box.appendChild(sticker((waiting.has(p.id) ? '… ' : '✓ ') + p.name, p.color, waiting.has(p.id) ? 'waiting' : 'done'));
    }
  }
  function roundLabel(s) { return s.round ? `${s.round.title}${s.round.mult > 1 ? ` · ×${s.round.mult}` : ''}` : ''; }

  function renderScores(target, s) {
    const list = $(target);
    list.innerHTML = '';
    const sorted = s.players.slice().sort((a, b) => b.score - a.score);
    const max = Math.max(1, ...sorted.map(p => p.score));
    sorted.forEach((p, i) => {
      const row = el('div', 'bar-row');
      row.appendChild(el('div', 'rank', `${i + 1}.`));
      const name = el('div', 'name', p.name);
      name.style.color = p.color;
      row.appendChild(name);
      const wrap = el('div');
      const bar = el('div', 'bar');
      bar.style.background = p.color;
      bar.style.width = '0%';
      wrap.appendChild(bar);
      row.appendChild(wrap);
      row.appendChild(el('div', 'score', p.score.toLocaleString()));
      list.appendChild(row);
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${Math.max(2, (p.score / max) * 100)}%`; }));
    });
  }

  // ---------- render ----------
  socket.on('state', s => {
    const prev = state;
    state = s;
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    const phaseKey = `${s.phase}:${s.round ? s.round.index : -1}:${s.matchupNumber || 0}`;
    const fresh = phaseKey !== lastPhaseKey;
    lastPhaseKey = phaseKey;

    if (s.phase === 'lobby') {
      $('room-code').textContent = s.code;
      $('lobby-count').textContent = `${s.players.length} / ${s.maxPlayers}`;
      const roster = $('roster');
      roster.innerHTML = '';
      for (let i = 0; i < s.maxPlayers; i++) {
        const p = s.players[i];
        if (p) {
          const seat = el('div', 'seat filled' + (p.connected ? '' : ' off'));
          seat.style.background = p.color;
          if (p.id === s.vipId) seat.appendChild(el('span', 'crown', '👑'));
          seat.appendChild(document.createTextNode(p.name));
          roster.appendChild(seat);
        } else {
          roster.appendChild(el('div', 'seat', i < s.minPlayers ? 'waiting…' : 'open seat'));
        }
      }
      const enough = s.players.length >= s.minPlayers;
      $('start-btn').disabled = !enough;
      $('lobby-note').textContent = enough ? '👑 can also start from their phone' : `Need ${s.minPlayers - s.players.length} more`;
      if (prev && prev.phase === 'lobby' && s.players.length > prev.players.length) sfx.join();
      show('lobby');
      if (enough && document.activeElement !== $('start-btn')) $('start-btn').focus();
      return;
    }

    if (s.phase === 'intro') {
      $('intro-title').textContent = s.round.title;
      $('intro-sub').textContent = s.round.subtitle;
      $('intro-mult').textContent = s.round.mult > 1 ? `×${s.round.mult} POINTS` : 'GET READY';
      if (fresh) sfx.intro();
      show('intro');
      return;
    }

    if (s.phase === 'answering') {
      $('answering-round').textContent = roundLabel(s);
      statusRow('answering-status', s);
      show('answering');
      return;
    }

    if (s.phase === 'voting' || s.phase === 'reveal') {
      const m = s.matchup;
      $('duel-round').textContent = `${roundLabel(s)} · ${s.matchupNumber}/${s.matchupCount}`;
      $('duel-prompt').textContent = m.prompt;
      const reveal = s.phase === 'reveal';
      if (fresh) {
        [0, 1].forEach(i => {
          const box = $(i ? 'duel-b' : 'duel-a');
          box.innerHTML = '';
          box.classList.remove('loser');
          box.appendChild(el('div', '', m.answers[i] == null ? '🦗 (no answer)' : m.answers[i]));
          // restart the pop animation
          box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
          if (reveal && m.result) {
            const r = m.result;
            if (r.winner != null && r.winner !== i) box.classList.add('loser');
            box.appendChild(el('span', 'sticker pts', `+${r.points[i]}`));
            const voters = el('div', 'voters');
            (m.voters ? m.voters[i] : []).forEach(v => voters.appendChild(sticker(v.name, v.color)));
            box.appendChild(voters);
            box.appendChild(sticker(m.authors[i].name, m.authors[i].color, 'author'));
          }
        });
        const stamp = $('duel-stamp');
        stamp.innerHTML = '';
        if (reveal && m.result) {
          const o = m.result.outcome;
          const word = { knockout: 'KNOCKOUT!', jinx: 'JINX!', forfeit: 'FORFEIT', tie: 'DEAD EVEN' }[o];
          if (word) stamp.appendChild(el('div', 'stamp', word));
          (o === 'knockout' ? sfx.knockout : sfx.reveal)();
        }
      }
      if (reveal) {
        const o = m.result && m.result.outcome;
        $('duel-foot').textContent =
          o === 'jinx' ? 'Same answer twice! Nobody gets points.' :
          o === 'knockout' ? 'Every single vote! Bonus points.' :
          o === 'forfeit' ? 'Somebody didn\'t answer. Free points for the other one.' : '';
      } else {
        const left = (s.waitingOn || []).length;
        $('duel-foot').textContent = `Vote on your phone! ${left ? `Waiting on ${left}…` : ''}`;
      }
      show('duel');
      return;
    }

    if (s.phase === 'finalAnswering') {
      $('final-prompt-a').textContent = s.final.prompt;
      statusRow('final-status', s);
      show('finalAnswering');
      return;
    }

    if (s.phase === 'finalVoting' || s.phase === 'finalReveal') {
      const f = s.final;
      const reveal = s.phase === 'finalReveal';
      $('final-prompt-b').textContent = f.prompt;
      if (fresh) {
        const grid = $('final-grid');
        grid.innerHTML = '';
        grid.classList.toggle('two', f.answers.length <= 4);
        const top = reveal && f.result ? Math.max(...f.result.counts) : -1;
        f.answers.forEach((a, i) => {
          const card = el('div', 'card fanswer');
          card.style.animationDelay = `${i * 0.08}s`;
          card.appendChild(el('div', '', a));
          if (reveal && f.result) {
            if (top > 0 && f.result.counts[i] === top) card.classList.add('top');
            card.appendChild(el('span', 'sticker pts', `${f.result.counts[i]} 🗳 · +${f.result.points[i]}`));
            card.appendChild(sticker(f.authors[i].name, f.authors[i].color, 'author'));
          }
          grid.appendChild(card);
        });
        if (reveal) sfx.reveal();
      }
      $('final-foot').textContent = reveal ? '' : 'Hand out 3 votes on your phone. Stack them if you love one!';
      show('finalBoard');
      return;
    }

    if (s.phase === 'scores') {
      $('scores-title').textContent = s.round ? s.round.title : 'Scores';
      $('scores-heading').textContent = `After ${s.round ? s.round.title : 'that'}`;
      if (fresh) renderScores('scores-list', s);
      show('scores');
      return;
    }

    if (s.phase === 'gameover') {
      const sorted = s.players.slice().sort((a, b) => b.score - a.score);
      const best = sorted[0];
      const tied = sorted.filter(p => p.score === best.score);
      $('winner-name').textContent = tied.map(p => p.name).join(' & ');
      $('winner-name').style.color = best.color;
      if (fresh) { renderScores('final-scores', s); sfx.win(); }
      show('gameover');
    }
  });

  // ---------- countdown ----------
  let lastSecs = null;
  setInterval(() => {
    if (!state) return;
    const secs = timerEnd ? Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000)) : null;
    const timed = ['answering', 'voting', 'finalAnswering', 'finalVoting'].includes(state.phase);
    for (const id of ['answering-timer', 'duel-timer', 'finalAnswering-timer', 'finalBoard-timer']) {
      const t = $(id);
      t.textContent = timed && secs != null ? `⏱ ${secs}` : '';
      t.classList.toggle('hidden', !timed);
      t.classList.toggle('low', timed && secs != null && secs <= 10);
    }
    if (timed && secs != null && secs <= 5 && secs > 0 && secs !== lastSecs) sfx.tick();
    lastSecs = secs;
  }, 200);
})();
