const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ---- Campeones (Data Dragon de Riot, siempre actualizado) ----
let champs = [];
async function loadChamps() {
  try {
    const v = (await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json())[0];
    const d = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/es_MX/champion.json`)).json();
    champs = Object.values(d.data).map(c => ({
      name: c.name,
      img: `https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${c.image.full}`
    }));
    console.log(`${champs.length} campeones cargados (v${v})`);
  } catch (e) {
    console.error('No se pudo cargar Data Dragon:', e.message);
  }
}
loadChamps();

// ---- Salas en memoria ----
const rooms = {};
const newCode = () => {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms[c]);
  return c;
};

function view(r, id) {
  const imp = r.impostors.includes(id);
  const v = {
    code: r.code, phase: r.phase, me: id, host: r.host === id,
    players: Object.entries(r.players).map(([i, p]) => ({ id: i, name: p.name, voted: i in r.votes })),
    clues: r.clues
  };
  if (r.phase !== 'lobby') {
    v.isImpostor = imp;
    v.champ = imp ? null : r.champ;
    v.impostorCount = r.impostors.length;
  }
  if (r.phase === 'result') v.result = r.result;
  return v;
}
const push = r => Object.keys(r.players).forEach(id => io.to(id).emit('state', view(r, id)));

io.on('connection', socket => {
  let room = null;
  const join = (code, name) => {
    const r = rooms[code];
    if (!r) return socket.emit('err', 'Esa sala no existe.');
    if (r.phase !== 'lobby') return socket.emit('err', 'La partida ya empezó.');
    if (Object.keys(r.players).length >= 12) return socket.emit('err', 'Sala llena (máx. 12).');
    r.players[socket.id] = { name: name.slice(0, 16) || 'Jugador' };
    room = r;
    push(r);
  };

  socket.on('create', name => {
    const code = newCode();
    rooms[code] = { code, host: socket.id, players: {}, phase: 'lobby', champ: null, impostors: [], votes: {}, clues: [], result: null };
    join(code, String(name || ''));
  });
  socket.on('join', ({ code, name }) => join(String(code || '').toUpperCase(), String(name || '')));

  socket.on('start', n => {
    const r = room;
    if (!r || r.host !== socket.id || r.phase !== 'lobby') return;
    const ids = Object.keys(r.players);
    if (ids.length < 3) return socket.emit('err', 'Se necesitan al menos 3 jugadores.');
    if (!champs.length) return socket.emit('err', 'Campeones aún cargando, intenta de nuevo.');
    const k = Math.max(1, Math.min(Number(n) || 1, Math.floor((ids.length - 1) / 2) || 1));
    r.champ = champs[Math.floor(Math.random() * champs.length)];
    r.impostors = [...ids].sort(() => Math.random() - 0.5).slice(0, k);
    r.votes = {}; r.clues = []; r.result = null; r.phase = 'play';
    push(r);
  });

  socket.on('clue', text => {
    const r = room;
    if (!r || r.phase !== 'play' || !r.players[socket.id]) return;
    const t = String(text || '').trim().slice(0, 40);
    if (!t) return;
    r.clues.push({ name: r.players[socket.id].name, text: t });
    push(r);
  });

  socket.on('toVote', () => {
    const r = room;
    if (!r || r.host !== socket.id || r.phase !== 'play') return;
    r.phase = 'vote'; push(r);
  });

  socket.on('vote', target => {
    const r = room;
    if (!r || r.phase !== 'vote' || !r.players[socket.id] || !r.players[target] || target === socket.id) return;
    r.votes[socket.id] = target;
    if (Object.keys(r.votes).length >= Object.keys(r.players).length) finish(r);
    push(r);
  });

  socket.on('again', () => {
    const r = room;
    if (!r || r.host !== socket.id || r.phase !== 'result') return;
    r.phase = 'lobby'; r.votes = {}; r.clues = []; r.impostors = []; r.result = null;
    push(r);
  });

  socket.on('disconnect', () => {
    const r = room;
    if (!r) return;
    delete r.players[socket.id];
    delete r.votes[socket.id];
    const ids = Object.keys(r.players);
    if (!ids.length) return void delete rooms[r.code];
    if (r.host === socket.id) r.host = ids[0];
    if (r.phase === 'vote' && Object.keys(r.votes).length >= ids.length) finish(r);
    push(r);
  });
});

function finish(r) {
  const tally = {};
  Object.values(r.votes).forEach(t => (tally[t] = (tally[t] || 0) + 1));
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter(i => tally[i] === max);
  const caught = top.length === 1 && r.impostors.includes(top[0]);
  r.result = {
    champ: r.champ,
    impostors: r.impostors.map(i => r.players[i]?.name || '(salió)'),
    tally: Object.entries(tally).map(([i, n]) => ({ name: r.players[i]?.name || '(salió)', n })).sort((a, b) => b.n - a.n),
    caught
  };
  r.phase = 'result';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Juego en http://localhost:${PORT}`));
