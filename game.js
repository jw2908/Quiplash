// Punch Bowl game logic. One Room per game, driven by a small phase machine.
const { DUEL_PROMPTS, FINAL_PROMPTS } = require('./prompts');

const SCALE = Number(process.env.TIME_SCALE) || 1;
const T = {
  intro: 4500,
  answer: 90000,
  vote: 25000,
  reveal: 7000,
  scores: 9000,
  finalAnswer: 75000,
  finalVote: 35000,
  finalReveal: 14000,
};
for (const k of Object.keys(T)) T[k] = Math.round(T[k] * SCALE);

const ROUNDS = [
  { type: 'duel', mult: 1, title: 'Round 1', subtitle: 'Two players, one prompt. The room picks the funnier answer.' },
  { type: 'duel', mult: 2, title: 'Round 2', subtitle: 'Same thing, but every point counts double.' },
  { type: 'final', mult: 3, title: 'The Last Laugh', subtitle: 'Everyone answers the same prompt. You get 3 votes to hand out. Triple points.' },
];

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MAX_ANSWER = 80;
const COLORS = ['#ff5a36', '#00a99d', '#ffb800', '#7a4cff', '#ff4fa3', '#2f80ff', '#3dbb3d', '#ff8a00', '#00b8d9', '#b5651d'];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}

class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange; // called whenever state changes so the server can broadcast
    this.hostKey = randomId();
    this.players = []; // {id, name, color, score, connected, socketId}
    this.phase = 'lobby';
    this.roundIndex = -1;
    this.duelDeck = shuffle(DUEL_PROMPTS);
    this.finalDeck = shuffle(FINAL_PROMPTS);
    this.timer = null;
    this.deadline = null;
    this.matchups = [];
    this.voteIndex = 0;
    this.final = null;
    this.lastActive = Date.now();
    this.paused = false;
  }

  // ---------- players ----------
  addPlayer(name) {
    name = cleanText(name, 12).toUpperCase();
    if (!name) return { error: 'Please enter a name.' };
    if (this.phase !== 'lobby') return { error: 'That game has already started.' };
    if (this.players.length >= MAX_PLAYERS) return { error: `That room is full (${MAX_PLAYERS} players max).` };
    if (this.players.some(p => p.name === name)) return { error: 'Someone already has that name.' };
    const used = new Set(this.players.map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[0];
    const player = { id: randomId(), name, color, score: 0, connected: true, socketId: null };
    this.players.push(player);
    this.changed();
    return { player };
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  removePlayer(id) {
    if (this.phase !== 'lobby') return;
    this.players = this.players.filter(p => p.id !== id);
    this.changed();
  }

  setConnected(id, connected, socketId) {
    const p = this.getPlayer(id);
    if (!p) return;
    p.connected = connected;
    if (socketId !== undefined) p.socketId = socketId;
    this.changed();
  }

  vipId() {
    const p = this.players.find(p => p.connected) || this.players[0];
    return p ? p.id : null;
  }

  changed() {
    this.lastActive = Date.now();
    if (this.onChange) this.onChange(this);
  }

  // ---------- timing ----------
  setPhase(phase, ms, next) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.deadline = ms ? Date.now() + ms : null;
    this.nextFn = next || null;
    this.timer = ms && next ? setTimeout(() => next.call(this), ms) : null;
    this.changed();
  }

  // Host pressed "skip": run whatever the timer would have run.
  skip() {
    if (!this.timer || !this.nextFn) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextFn.call(this);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- flow ----------
  start() {
    if (this.phase !== 'lobby' && this.phase !== 'gameover') return { error: 'Game already running.' };
    if (this.players.length < MIN_PLAYERS) return { error: `Need at least ${MIN_PLAYERS} players.` };
    for (const p of this.players) p.score = 0;
    this.roundIndex = -1;
    this.nextRound();
    return { ok: true };
  }

  backToLobby() {
    this.stop();
    for (const p of this.players) p.score = 0;
    // Drop players who left so new people can take their place.
    this.players = this.players.filter(p => p.connected);
    this.roundIndex = -1;
    this.matchups = [];
    this.final = null;
    this.setPhase('lobby');
  }

  round() {
    return ROUNDS[this.roundIndex];
  }

  nextRound() {
    this.roundIndex++;
    if (this.roundIndex >= ROUNDS.length) {
      this.setPhase('gameover');
      return;
    }
    this.setPhase('intro', T.intro, this.round().type === 'duel' ? this.startDuelAnswering : this.startFinalAnswering);
  }

  drawDuel() {
    if (!this.duelDeck.length) this.duelDeck = shuffle(DUEL_PROMPTS);
    return this.duelDeck.pop();
  }

  drawFinal() {
    if (!this.finalDeck.length) this.finalDeck = shuffle(FINAL_PROMPTS);
    return this.finalDeck.pop();
  }

  // Every player gets exactly two prompts; every prompt goes to exactly two players.
  startDuelAnswering() {
    const ids = shuffle(this.players.map(p => p.id));
    const n = ids.length;
    this.matchups = ids.map((id, i) => ({
      prompt: this.drawDuel(),
      players: [id, ids[(i + 1) % n]],
      answers: [null, null],
      votes: {}, // voterId -> 0|1
      result: null,
    }));
    this.voteIndex = 0;
    this.setPhase('answering', T.answer, this.endDuelAnswering);
  }

  promptsFor(playerId) {
    const out = [];
    this.matchups.forEach((m, i) => {
      const side = m.players.indexOf(playerId);
      if (side !== -1) out.push({ matchup: i, side, text: m.prompt, answered: m.answers[side] !== null });
    });
    return out;
  }

  submitAnswer(playerId, matchupIdx, text) {
    if (this.phase === 'finalAnswering') return this.submitFinalAnswer(playerId, text);
    if (this.phase !== 'answering') return { error: 'Not taking answers right now.' };
    const m = this.matchups[matchupIdx];
    if (!m) return { error: 'Unknown prompt.' };
    const side = m.players.indexOf(playerId);
    if (side === -1) return { error: 'That prompt is not yours.' };
    if (m.answers[side] !== null) return { error: 'Already answered.' };
    text = cleanText(text, MAX_ANSWER);
    if (!text) return { error: 'Write something first!' };
    m.answers[side] = text;
    const allIn = this.matchups.every(mm =>
      mm.players.every((pid, s) => mm.answers[s] !== null || !this.getPlayer(pid).connected));
    if (allIn) this.endDuelAnswering();
    else this.changed();
    return { ok: true };
  }

  endDuelAnswering() {
    this.voteIndex = -1;
    this.nextVote();
  }

  nextVote() {
    this.voteIndex++;
    // Skip matchups where nobody answered at all.
    while (this.voteIndex < this.matchups.length) {
      const m = this.matchups[this.voteIndex];
      if (m.answers[0] !== null || m.answers[1] !== null) break;
      this.voteIndex++;
    }
    if (this.voteIndex >= this.matchups.length) {
      this.setPhase('scores', T.scores, this.nextRound);
      return;
    }
    const m = this.currentMatchup();
    const same = m.answers[0] && m.answers[1] && m.answers[0].toLowerCase() === m.answers[1].toLowerCase();
    if (same || m.answers[0] === null || m.answers[1] === null) {
      // Jinx or forfeit: no voting needed.
      this.scoreMatchup();
      return;
    }
    this.setPhase('voting', T.vote, this.scoreMatchup);
  }

  currentMatchup() {
    return this.matchups[this.voteIndex];
  }

  votersFor(m) {
    return this.players.filter(p => p.connected && !m.players.includes(p.id));
  }

  submitVote(playerId, choice) {
    if (this.phase === 'finalVoting') return this.submitFinalVotes(playerId, choice);
    if (this.phase !== 'voting') return { error: 'Not voting right now.' };
    const m = this.currentMatchup();
    if (m.players.includes(playerId)) return { error: 'You cannot vote on your own matchup.' };
    if (!this.getPlayer(playerId)) return { error: 'Unknown player.' };
    if (choice !== 0 && choice !== 1) return { error: 'Bad vote.' };
    if (m.votes[playerId] !== undefined) return { error: 'Already voted.' };
    m.votes[playerId] = choice;
    if (this.votersFor(m).every(p => m.votes[p.id] !== undefined)) this.scoreMatchup();
    else this.changed();
    return { ok: true };
  }

  scoreMatchup() {
    const m = this.currentMatchup();
    const mult = this.round().mult;
    const counts = [0, 0];
    for (const v of Object.values(m.votes)) counts[v]++;
    const points = [counts[0] * 100 * mult, counts[1] * 100 * mult];
    let outcome = 'normal';
    let winner = null;
    const same = m.answers[0] && m.answers[1] && m.answers[0].toLowerCase() === m.answers[1].toLowerCase();
    if (same) {
      outcome = 'jinx';
      points[0] = points[1] = 0;
    } else if (m.answers[0] === null || m.answers[1] === null) {
      outcome = 'forfeit';
      winner = m.answers[0] === null ? 1 : 0;
      points[winner] = 250 * mult;
    } else if (counts[0] !== counts[1]) {
      winner = counts[0] > counts[1] ? 0 : 1;
      points[winner] += 100 * mult; // winner bonus
      const total = counts[0] + counts[1];
      if (total >= 2 && counts[1 - winner] === 0) {
        outcome = 'knockout';
        points[winner] += 150 * mult;
      }
    } else {
      outcome = 'tie';
    }
    m.result = { counts, points, outcome, winner };
    m.players.forEach((pid, s) => {
      const p = this.getPlayer(pid);
      if (p) p.score += points[s];
    });
    this.setPhase('reveal', T.reveal, this.nextVote);
  }

  // ---------- final round ----------
  startFinalAnswering() {
    this.final = { prompt: this.drawFinal(), answers: {}, votes: {}, order: [], result: null };
    this.setPhase('finalAnswering', T.finalAnswer, this.endFinalAnswering);
  }

  submitFinalAnswer(playerId, text) {
    if (!this.getPlayer(playerId)) return { error: 'Unknown player.' };
    if (this.final.answers[playerId] !== undefined) return { error: 'Already answered.' };
    text = cleanText(text, MAX_ANSWER);
    if (!text) return { error: 'Write something first!' };
    this.final.answers[playerId] = text;
    if (this.players.filter(p => p.connected).every(p => this.final.answers[p.id] !== undefined)) this.endFinalAnswering();
    else this.changed();
    return { ok: true };
  }

  endFinalAnswering() {
    this.final.order = shuffle(Object.keys(this.final.answers));
    if (this.final.order.length < 2) {
      this.scoreFinal();
      return;
    }
    this.setPhase('finalVoting', T.finalVote, this.scoreFinal);
  }

  // choice: array of 3 answer indexes (repeats allowed), never your own.
  submitFinalVotes(playerId, choice) {
    if (!this.getPlayer(playerId)) return { error: 'Unknown player.' };
    if (this.final.votes[playerId]) return { error: 'Already voted.' };
    if (!Array.isArray(choice) || choice.length < 1 || choice.length > 3) return { error: 'Pick up to 3.' };
    const order = this.final.order;
    for (const idx of choice) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= order.length) return { error: 'Bad vote.' };
      if (order[idx] === playerId) return { error: 'You cannot vote for yourself.' };
    }
    this.final.votes[playerId] = choice;
    if (this.players.filter(p => p.connected).every(p => this.final.votes[p.id])) this.scoreFinal();
    else this.changed();
    return { ok: true };
  }

  scoreFinal() {
    const mult = this.round().mult;
    const counts = this.final.order.map(() => 0);
    for (const arr of Object.values(this.final.votes)) for (const idx of arr) counts[idx]++;
    const points = counts.map(c => c * 100 * mult);
    this.final.order.forEach((pid, i) => {
      const p = this.getPlayer(pid);
      if (p) p.score += points[i];
    });
    this.final.result = { counts, points };
    this.setPhase('finalReveal', T.finalReveal, this.nextRound);
  }

  // ---------- views ----------
  publicPlayers() {
    return this.players.map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected }));
  }

  timeLeft() {
    return this.deadline ? Math.max(0, this.deadline - Date.now()) : null;
  }

  baseView() {
    const r = this.round();
    return {
      code: this.code,
      phase: this.phase,
      players: this.publicPlayers(),
      vipId: this.vipId(),
      round: r ? { index: this.roundIndex, title: r.title, subtitle: r.subtitle, mult: r.mult, type: r.type } : null,
      roundCount: ROUNDS.length,
      timeLeft: this.timeLeft(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }

  matchupView(m, reveal) {
    const v = { prompt: m.prompt, answers: m.answers.slice() };
    if (reveal && m.result) {
      v.result = m.result;
      v.authors = m.players.map(pid => {
        const p = this.getPlayer(pid);
        return p ? { name: p.name, color: p.color } : { name: '?', color: '#999' };
      });
      v.voters = [[], []];
      for (const [vid, c] of Object.entries(m.votes)) {
        const p = this.getPlayer(vid);
        if (p) v.voters[c].push({ name: p.name, color: p.color });
      }
    }
    return v;
  }

  finalView(reveal) {
    const f = this.final;
    if (!f) return null;
    const v = { prompt: f.prompt, answers: f.order.map(pid => f.answers[pid]) };
    if (reveal && f.result) {
      v.result = f.result;
      v.authors = f.order.map(pid => {
        const p = this.getPlayer(pid);
        return p ? { name: p.name, color: p.color } : { name: '?', color: '#999' };
      });
    }
    return v;
  }

  hostView() {
    const v = this.baseView();
    const connected = this.players.filter(p => p.connected);
    if (this.phase === 'answering') {
      v.waitingOn = connected.filter(p => this.promptsFor(p.id).some(x => !x.answered)).map(p => p.id);
    } else if (this.phase === 'voting' || this.phase === 'reveal') {
      const m = this.currentMatchup();
      v.matchup = this.matchupView(m, this.phase === 'reveal');
      v.matchupNumber = this.voteIndex + 1;
      v.matchupCount = this.matchups.length;
      if (this.phase === 'voting') v.waitingOn = this.votersFor(m).filter(p => m.votes[p.id] === undefined).map(p => p.id);
    } else if (this.phase === 'finalAnswering') {
      v.final = { prompt: this.final.prompt };
      v.waitingOn = connected.filter(p => this.final.answers[p.id] === undefined).map(p => p.id);
    } else if (this.phase === 'finalVoting' || this.phase === 'finalReveal') {
      v.final = this.finalView(this.phase === 'finalReveal');
      if (this.phase === 'finalVoting') v.waitingOn = connected.filter(p => !this.final.votes[p.id]).map(p => p.id);
    }
    return v;
  }

  playerView(playerId) {
    const v = this.baseView();
    const me = this.getPlayer(playerId);
    v.me = me ? { id: me.id, name: me.name, color: me.color, score: me.score } : null;
    v.isVip = this.vipId() === playerId;
    if (this.phase === 'answering') {
      const mine = this.promptsFor(playerId);
      const next = mine.find(x => !x.answered);
      v.task = next ? { kind: 'answer', matchup: next.matchup, prompt: next.text, step: mine.indexOf(next) + 1, steps: mine.length } : { kind: 'wait', message: 'Answers locked in! Waiting on everyone else…' };
    } else if (this.phase === 'voting') {
      const m = this.currentMatchup();
      if (m.players.includes(playerId)) v.task = { kind: 'wait', message: 'This is your matchup! Sit back and look innocent.' };
      else if (m.votes[playerId] !== undefined) v.task = { kind: 'wait', message: 'Vote cast. Waiting on the rest…' };
      else v.task = { kind: 'vote', prompt: m.prompt, answers: m.answers };
    } else if (this.phase === 'finalAnswering') {
      v.task = this.final.answers[playerId] === undefined
        ? { kind: 'answer', matchup: -1, prompt: this.final.prompt, step: 1, steps: 1 }
        : { kind: 'wait', message: 'Locked in! Waiting on everyone else…' };
    } else if (this.phase === 'finalVoting') {
      if (this.final.votes[playerId]) v.task = { kind: 'wait', message: 'Votes cast. Waiting on the rest…' };
      else v.task = {
        kind: 'finalVote',
        prompt: this.final.prompt,
        answers: this.final.order.map(pid => ({ text: this.final.answers[pid], mine: pid === playerId })),
        votes: 3,
      };
    }
    return v;
  }
}

module.exports = { Room, ROUNDS, MIN_PLAYERS, MAX_PLAYERS, MAX_ANSWER, T };
