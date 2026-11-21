// End-to-end smoke test: boots the server, opens a host and N fake phones,
// and plays complete games. Run with `npm test`.
process.env.TIME_SCALE = process.env.TIME_SCALE || '0.02';
process.env.PORT = process.env.PORT || '3999';
const assert = require('assert');
const { io } = require('socket.io-client');
const { server } = require('../server');

const URL = `http://localhost:${process.env.PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise(r => s.emit(ev, data, r));

async function playGame(numPlayers, { dropOne = false } = {}) {
  const host = io(URL, { forceNew: true });
  let hostState = null;
  const phases = [];
  host.on('state', s => { hostState = s; if (phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
  await new Promise(r => host.on('connect', r));
  const { code } = await emit(host, 'host:create');
  assert.match(code, /^[A-Z]{4}$/);

  const players = [];
  for (let i = 0; i < numPlayers; i++) {
    const sock = io(URL, { forceNew: true });
    await new Promise(r => sock.on('connect', r));
    const p = { sock, name: `BOT${i}`, state: null };
    sock.on('state', s => {
      p.state = s;
      act(p).catch(e => { console.error(e); process.exit(1); });
    });
    const res = await emit(sock, 'player:join', { code, name: p.name });
    assert.ok(res.playerId, `join failed: ${JSON.stringify(res)}`);
    p.id = res.playerId;
    players.push(p);
  }

  // Duplicate names and bad codes are refused.
  const extra = io(URL, { forceNew: true });
  assert.ok((await emit(extra, 'player:join', { code, name: 'bot0' })).error);
  assert.ok((await emit(extra, 'player:join', { code: 'ZZZZ', name: 'x' })).error);
  extra.close();

  await wait(50);
  assert.equal(hostState.players.length, numPlayers);

  // Non-VIP cannot start; VIP can.
  const notVip = players.find(p => p.id !== hostState.vipId);
  assert.ok((await emit(notVip.sock, 'game:start')).error);
  const vip = players.find(p => p.id === hostState.vipId);
  assert.ok((await emit(vip.sock, 'game:start')).ok);

  if (dropOne) {
    // One player vanishes mid-game and comes back later with their saved id.
    const quitter = players[numPlayers - 1];
    setTimeout(() => quitter.sock.disconnect(), 30);
    setTimeout(() => {
      const sock = io(URL, { forceNew: true });
      sock.on('state', s => { quitter.state = s; act(quitter).catch(e => { console.error(e); process.exit(1); }); });
      sock.on('connect', () => sock.emit('player:join', { code, playerId: quitter.id }, () => {}));
      quitter.sock = sock;
    }, 900);
  }

  const deadline = Date.now() + 30000;
  while (hostState.phase !== 'gameover') {
    if (Date.now() > deadline) throw new Error('Game did not finish. Stuck in ' + hostState.phase);
    await wait(20);
  }

  for (const want of ['intro', 'answering', 'voting', 'reveal', 'scores', 'finalAnswering', 'finalVoting', 'finalReveal', 'gameover']) {
    assert.ok(phases.includes(want), `never reached phase ${want}; saw ${phases.join(',')}`);
  }
  const total = hostState.players.reduce((a, p) => a + p.score, 0);
  assert.ok(total > 0, 'nobody scored');
  console.log(`  ✓ ${numPlayers}-player game${dropOne ? ' (with a dropout)' : ''} finished. Scores: ` +
    hostState.players.map(p => `${p.name}=${p.score}`).join(', '));

  // Play again returns to lobby with scores reset.
  await emit(vip.sock, 'game:lobby');
  await wait(50);
  assert.equal(hostState.phase, 'lobby');
  assert.ok(hostState.players.every(p => p.score === 0));

  host.close();
  players.forEach(p => p.sock.close());
}

const acted = new WeakMap();
async function act(p) {
  const s = p.state;
  const t = s.task;
  if (!t) return;
  const key = `${s.phase}:${t.kind}:${t.prompt}:${t.matchup}`;
  if (acted.get(p) === key) return;
  acted.set(p, key);
  await wait(Math.random() * 15);
  if (t.kind === 'answer') {
    const res = await emit(p.sock, 'answer', { matchup: t.matchup, text: `${p.name} says ${Math.random().toString(36).slice(2, 7)}` });
    if (res && res.error && !/Not taking|Already/.test(res.error)) throw new Error(res.error);
  } else if (t.kind === 'vote') {
    await emit(p.sock, 'vote', { choice: Math.random() < 0.5 ? 0 : 1 });
  } else if (t.kind === 'finalVote') {
    const options = t.answers.map((a, i) => (a.mine ? -1 : i)).filter(i => i >= 0);
    // Voting for yourself must be refused.
    const mine = t.answers.findIndex(a => a.mine);
    if (mine >= 0) assert.ok((await emit(p.sock, 'vote', { choice: [mine, mine, mine] })).error);
    const picks = [0, 1, 2].map(() => options[Math.floor(Math.random() * options.length)]);
    await emit(p.sock, 'vote', { choice: picks });
  }
}

(async () => {
  await new Promise(r => server.listening ? r() : server.on('listening', r));
  console.log('Running Punch Bowl simulations…');
  await playGame(3);
  await playGame(5);
  await playGame(8);
  await playGame(4, { dropOne: true });
  console.log('All simulations passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
