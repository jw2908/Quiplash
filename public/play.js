(() => {
  const $ = id => document.getElementById(id);
  const socket = io();
  const screens = ['join', 'lobby', 'answer', 'vote', 'final', 'wait'];
  let state = null;
  let session = JSON.parse(localStorage.getItem('pb_session') || 'null'); // {code, playerId, name}
  let answerKey = null;
  let finalKey = null;
  let finalPicks = [];
  let timerEnd = null;

  function show(name) {
    for (const s of screens) $('s-' + s).classList.toggle('hidden', s !== name);
  }

  // ----- join -----
  const params = new URLSearchParams(location.search);
  $('code').value = (params.get('code') || (session && session.code) || '').toUpperCase();
  $('name').value = (session && session.name) || '';
  $('code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

  function join(rejoin) {
    const code = $('code').value.trim().toUpperCase();
    const name = $('name').value.trim();
    if (!rejoin && (code.length !== 4 || !name)) {
      $('join-error').textContent = 'Need a 4-letter code and a name.';
      return;
    }
    const payload = rejoin ? { code: session.code, playerId: session.playerId } : { code, name };
    $('join-btn').disabled = true;
    socket.emit('player:join', payload, res => {
      $('join-btn').disabled = false;
      if (!res || res.error) {
        if (rejoin) { session = null; localStorage.removeItem('pb_session'); show('join'); return; }
        $('join-error').textContent = (res && res.error) || 'Could not join.';
        return;
      }
      session = { code: res.code, playerId: res.playerId, name: rejoin ? session.name : name };
      localStorage.setItem('pb_session', JSON.stringify(session));
      $('join-error').textContent = '';
    });
  }
  $('join-btn').addEventListener('click', () => join(false));
  $('name').addEventListener('keydown', e => { if (e.key === 'Enter') join(false); });

  socket.on('connect', () => {
    if (session && session.playerId) join(true);
  });

  $('leave-btn').addEventListener('click', () => {
    socket.emit('player:leave');
    session = null;
    state = null;
    localStorage.removeItem('pb_session');
    $('me').innerHTML = '';
    show('join');
  });

  // ----- VIP -----
  $('start-btn').addEventListener('click', () => {
    socket.emit('game:start', null, res => {
      $('start-error').textContent = res && res.error ? res.error : '';
    });
  });
  $('skip-btn').addEventListener('click', () => socket.emit('game:skip'));
  $('again-btn').addEventListener('click', () => socket.emit('game:lobby'));

  // ----- answer -----
  $('answer-text').addEventListener('input', e => { $('answer-count').textContent = e.target.value.length; });
  $('answer-text').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendAnswer(); } });
  $('answer-btn').addEventListener('click', sendAnswer);
  function sendAnswer() {
    const t = state && state.task;
    if (!t || t.kind !== 'answer') return;
    const text = $('answer-text').value.trim();
    if (!text) { $('answer-error').textContent = 'Write something first!'; return; }
    $('answer-btn').disabled = true;
    socket.emit('answer', { matchup: t.matchup, text }, res => {
      $('answer-btn').disabled = false;
      $('answer-error').textContent = res && res.error ? res.error : '';
    });
  }

  // ----- vote -----
  [0, 1].forEach(i => $('vote-' + i).addEventListener('click', () => {
    $('vote-0').disabled = $('vote-1').disabled = true;
    socket.emit('vote', { choice: i });
  }));

  // ----- final vote -----
  $('final-reset').addEventListener('click', () => { finalPicks = []; renderFinal(); });
  $('final-send').addEventListener('click', () => {
    $('final-send').disabled = true;
    socket.emit('vote', { choice: finalPicks.slice() }, res => {
      if (res && res.error) { $('final-send').disabled = false; alert(res.error); }
    });
  });
  function renderFinal() {
    const t = state.task;
    $('final-prompt').textContent = t.prompt;
    $('final-left').textContent = t.votes - finalPicks.length;
    const list = $('final-list');
    list.innerHTML = '';
    t.answers.forEach((a, i) => {
      const b = document.createElement('button');
      b.className = 'choice ' + (i % 2 ? 'b' : 'a');
      b.textContent = a.text;
      const n = finalPicks.filter(x => x === i).length;
      if (n) {
        const c = document.createElement('span');
        c.className = 'sticker count';
        c.style.background = 'var(--grape)';
        c.textContent = '×' + n;
        b.appendChild(c);
      }
      if (a.mine) {
        b.disabled = true;
        b.textContent = a.text + '  (yours)';
      } else {
        b.disabled = finalPicks.length >= t.votes;
        b.addEventListener('click', () => { finalPicks.push(i); renderFinal(); });
      }
      list.appendChild(b);
    });
    $('final-send').disabled = finalPicks.length !== t.votes;
  }

  // ----- render -----
  const waitEmoji = { lobby: '🥊', intro: '📣', answering: '⏳', voting: '🗳️', reveal: '👀', scores: '🏆', finalAnswering: '⏳', finalVoting: '🗳️', finalReveal: '👀', gameover: '🎉' };
  const waitMsg = {
    intro: 'Get ready…',
    reveal: 'Eyes on the big screen!',
    scores: 'Checking the scoreboard…',
    finalReveal: 'Eyes on the big screen!',
  };

  socket.on('state', s => {
    state = s;
    if (!s.me) return;
    $('me').innerHTML = '';
    const tag = document.createElement('span');
    tag.className = 'sticker';
    tag.style.background = s.me.color;
    tag.textContent = `${s.me.name} · ${s.me.score}`;
    $('me').appendChild(tag);
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;

    const t = s.task;
    if (s.phase === 'lobby') {
      show('lobby');
      $('vip-box').classList.toggle('hidden', !s.isVip);
      const n = s.players.length;
      $('lobby-count').textContent = n < s.minPlayers ? `${n} in so far. Need at least ${s.minPlayers}.` : `${n} players in.`;
      $('start-btn').disabled = n < s.minPlayers;
      return;
    }
    if (t && t.kind === 'answer') {
      const key = s.phase + ':' + t.matchup + ':' + t.prompt;
      if (key !== answerKey) {
        answerKey = key;
        $('answer-text').value = '';
        $('answer-count').textContent = '0';
        $('answer-error').textContent = '';
      }
      $('answer-step').textContent = t.steps > 1 ? `Prompt ${t.step} of ${t.steps}` : 'Final prompt';
      $('answer-prompt').textContent = t.prompt;
      show('answer');
      return;
    }
    if (t && t.kind === 'vote') {
      $('vote-prompt').textContent = t.prompt;
      $('vote-0').textContent = t.answers[0];
      $('vote-1').textContent = t.answers[1];
      $('vote-0').disabled = $('vote-1').disabled = false;
      show('vote');
      return;
    }
    if (t && t.kind === 'finalVote') {
      if (finalKey !== t.prompt) { finalKey = t.prompt; finalPicks = []; }
      renderFinal();
      show('final');
      return;
    }
    // Everything else: watch the TV.
    $('wait-emoji').textContent = waitEmoji[s.phase] || '📺';
    let msg = (t && t.message) || waitMsg[s.phase] || 'Eyes on the big screen!';
    if (s.phase === 'gameover') {
      const top = s.players.slice().sort((a, b) => b.score - a.score)[0];
      msg = top && top.id === s.me.id ? 'You won! Take a bow.' : 'Game over! Check the big screen.';
    }
    $('wait-msg').textContent = msg;
    const vipTimed = s.isVip && ['answering', 'voting', 'finalAnswering', 'finalVoting'].includes(s.phase);
    $('vip-controls').classList.toggle('hidden', !(vipTimed || (s.isVip && s.phase === 'gameover')));
    $('skip-btn').classList.toggle('hidden', !vipTimed);
    $('again-btn').classList.toggle('hidden', s.phase !== 'gameover');
    show('wait');
  });

  setInterval(() => {
    const el = $('timer');
    if (!timerEnd || !state || state.phase === 'lobby') { el.textContent = ''; return; }
    const secs = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    el.textContent = ['answering', 'voting', 'finalAnswering', 'finalVoting'].includes(state.phase) ? `⏱ ${secs}` : '';
  }, 250);

  show(session ? 'wait' : 'join');
  if (session) $('wait-msg').textContent = 'Reconnecting…';
})();
