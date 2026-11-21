const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/info', (_req, res) => res.json({ lan: lanAddresses(), port: PORT, publicUrl: process.env.PUBLIC_URL || null }));

const rooms = new Map(); // code -> Room

// No vowels-only weirdness and no easily confused letters.
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('Out of room codes');
}

function broadcast(room) {
  io.to(`host:${room.code}`).emit('state', room.hostView());
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', room.playerView(p.id));
  }
}

io.on('connection', socket => {
  let room = null;
  let playerId = null;
  let isHost = false;

  const reply = (cb, data) => { if (typeof cb === 'function') cb(data); };

  socket.on('host:create', (_data, cb) => {
    const code = newCode();
    room = new Room(code, broadcast);
    rooms.set(code, room);
    isHost = true;
    socket.join(`host:${code}`);
    reply(cb, { code, hostKey: room.hostKey });
    broadcast(room);
  });

  socket.on('host:rejoin', ({ code, hostKey } = {}, cb) => {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r || r.hostKey !== hostKey) return reply(cb, { error: 'Room not found.' });
    room = r;
    isHost = true;
    socket.join(`host:${r.code}`);
    reply(cb, { code: r.code, hostKey: r.hostKey });
    broadcast(r);
  });

  socket.on('player:join', ({ code, name, playerId: pid } = {}, cb) => {
    const r = rooms.get(String(code || '').trim().toUpperCase());
    if (!r) return reply(cb, { error: 'No game with that code. Check the TV!' });
    let p = pid && r.getPlayer(pid);
    if (!p) {
      const res = r.addPlayer(name);
      if (res.error) return reply(cb, res);
      p = res.player;
    }
    room = r;
    playerId = p.id;
    r.setConnected(p.id, true, socket.id);
    reply(cb, { code: r.code, playerId: p.id });
    broadcast(r);
  });

  socket.on('player:leave', () => {
    if (room && playerId) room.removePlayer(playerId);
    playerId = null;
  });

  socket.on('game:start', (_d, cb) => {
    if (!room) return;
    if (!isHost && room.vipId() !== playerId) return reply(cb, { error: 'Only the TV or the first player can start.' });
    reply(cb, room.start());
  });

  socket.on('game:lobby', (_d, cb) => {
    if (!room) return reply(cb, { error: 'Not in a game.' });
    if (!isHost && room.vipId() !== playerId) return reply(cb, { error: 'Not allowed.' });
    if (room.phase === 'gameover') room.backToLobby();
    reply(cb, { ok: true });
  });

  socket.on('game:skip', (_d, cb) => {
    reply(cb, { ok: true });
    // Host can end a timer early (e.g. someone wandered off).
    if (!room) return;
    if (!isHost && room.vipId() !== playerId) return;
    room.skip();
  });

  socket.on('answer', ({ matchup, text } = {}, cb) => {
    if (!room || !playerId) return reply(cb, { error: 'Not in a game.' });
    reply(cb, room.submitAnswer(playerId, matchup, text));
  });

  socket.on('vote', ({ choice } = {}, cb) => {
    if (!room || !playerId) return reply(cb, { error: 'Not in a game.' });
    reply(cb, room.submitVote(playerId, choice));
  });

  socket.on('disconnect', () => {
    if (room && playerId) {
      const p = room.getPlayer(playerId);
      if (p && p.socketId === socket.id) room.setConnected(playerId, false);
    }
  });
});

// Clean up rooms nobody has touched in a while.
setInterval(() => {
  const cutoff = Date.now() - 45 * 60 * 1000;
  for (const [code, r] of rooms) {
    if (r.lastActive < cutoff) { r.stop(); rooms.delete(code); }
  }
}, 60 * 1000).unref();

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`\n  PUNCH BOWL is running!`);
  console.log(`  TV / host screen:  http://localhost:${PORT}/host`);
  for (const ip of lanAddresses()) console.log(`  On your Wi-Fi:     http://${ip}:${PORT}  (phones join here, TV opens /host)`);
  console.log('');
});

module.exports = { server, rooms };
