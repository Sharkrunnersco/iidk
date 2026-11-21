// FERAL DEPTHS multiplayer server: rooms, pose relay, server-owned tag / infection rounds.
// Run: npm install && node server.js   (PORT env var is respected, default 8080)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080, MAX_PLAYERS = 8, TICK_HZ = 15;
const ROUND = { tag: 120, infect: 90 }, IMMUNITY = 3, TAG_REACH = 1.6, MAX_SPEED = 30, BOUND = 62;

// --- tiny static file server so one host serves the game page AND the websocket ---
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const file = path.join(__dirname, 'public', url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Put the game file at public/index.html'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

const rooms = new Map();   // public join code -> room   (codes are for players only)
const clients = new Map(); // ws -> { id, name, room }   (internal ids never shown as room codes)

const code = () => { let c; do { c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); } while (rooms.has(c)); return c; };
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const finite3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

function newRoom(hostId) {
  const c = code(), room = { code: c, internalId: crypto.randomUUID(), hostId, players: new Map(), mode: 'lobby', time: 0, state: 'lobby', it: null, result: '' };
  rooms.set(c, room); return room;
}
function addPlayer(room, ws, name) {
  const cl = clients.get(ws);
  room.players.set(cl.id, { id: cl.id, ws, name: name || 'Player', head: [0, 1.6, 0], lh: [0, 1, 0], rh: [0, 1, 0], ry: 0, last: Date.now(), infected: false, immune: 0, itTime: 0, vr: false });
  cl.room = room;
}
function startRound(room, mode) {
  if (!ROUND[mode]) return;
  room.mode = mode; room.state = 'play'; room.time = ROUND[mode]; room.result = '';
  const ids = [...room.players.keys()], pick = ids[crypto.randomInt(ids.length)];
  room.players.forEach(p => { p.infected = false; p.immune = 0; p.itTime = 0; });
  if (mode === 'tag') room.it = pick; else { room.it = null; room.players.get(pick).infected = true; }
}
function endRound(room, text) { room.state = 'results'; room.result = text; room.resultT = 8; }
function leave(ws) {
  const cl = clients.get(ws); if (!cl || !cl.room) return;
  const room = cl.room; room.players.delete(cl.id); cl.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === cl.id) room.hostId = room.players.keys().next().value;
  if (room.mode === 'tag' && room.it === cl.id) room.it = room.players.keys().next().value;
}

wss.on('connection', ws => {
  clients.set(ws, { id: crypto.randomUUID().slice(0, 8), name: 'Player', room: null });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const cl = clients.get(ws); if (!cl || typeof m.t !== 'string') return;
    if (m.t === 'create' || m.t === 'join') {
      if (cl.room) leave(ws);
      cl.name = String(m.name || 'Player').slice(0, 16);
      let room;
      if (m.t === 'create') room = newRoom(cl.id);
      else { room = rooms.get(String(m.code || '').toUpperCase()); if (!room) return send(ws, { t: 'err', msg: 'No room with that code' }); }
      if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Room is full' });
      addPlayer(room, ws, cl.name);
      return send(ws, { t: 'joined', code: room.code, id: cl.id, host: room.hostId === cl.id });
    }
    const room = cl.room; if (!room) return;
    const p = room.players.get(cl.id);
    if (m.t === 'pose') { // validate shape and movement bounds before accepting
      if (!finite3(m.head) || !finite3(m.lh) || !finite3(m.rh)) return;
      const now = Date.now(), dt = Math.max(0.02, (now - p.last) / 1000);
      if (dist(m.head, p.head) > MAX_SPEED * dt + 3 && p.last) { return; }          // teleport / speed hack
      if (Math.abs(m.head[0]) > BOUND || Math.abs(m.head[2]) > BOUND || m.head[1] < -12 || m.head[1] > 60) return;
      p.head = m.head; p.lh = m.lh; p.rh = m.rh; p.ry = Number(m.ry) || 0; p.vr = !!m.vr; p.last = now;
    } else if (m.t === 'start' && room.hostId === cl.id) startRound(room, m.mode);
    else if (m.t === 'tag' && room.state === 'play') { // server decides if a tag is valid
      const a = p, b = room.players.get(m.target); if (!b || a === b) return;
      const reach = [a.lh, a.rh, a.head].some(h => dist(h, b.head) < TAG_REACH || dist(h, [b.head[0], b.head[1] - 0.4, b.head[2]]) < TAG_REACH);
      if (!reach) return;
      if (room.mode === 'tag' && room.it === a.id && b.immune <= 0) { room.it = b.id; a.immune = IMMUNITY; }
      if (room.mode === 'infect' && a.infected && !b.infected) b.infected = true;
    }
  });
  ws.on('close', () => { leave(ws); clients.delete(ws); });
});

// --- server tick: round timers, results, snapshots ---
setInterval(() => {
  const dt = 1 / TICK_HZ;
  rooms.forEach(room => {
    if (room.state === 'play') {
      room.time -= dt;
      room.players.forEach(p => { if (p.immune > 0) p.immune -= dt; if (room.mode === 'tag' && room.it === p.id) p.itTime += dt; });
      if (room.mode === 'tag' && room.time <= 0) {
        const order = [...room.players.values()].sort((x, y) => x.itTime - y.itTime);
        endRound(room, `Round over. Winner: ${order[0].name} (${order[0].itTime.toFixed(0)}s as IT)`);
      }
      if (room.mode === 'infect') {
        const alive = [...room.players.values()].filter(p => !p.infected).length;
        if (alive === 0) endRound(room, 'Everyone is infected. INFECTED WIN!');
        else if (room.time <= 0) endRound(room, `Sunrise! SURVIVORS WIN (${alive} left)`);
      }
    } else if (room.state === 'results') { room.resultT -= dt; if (room.resultT <= 0) { room.state = 'lobby'; room.mode = 'lobby'; } }
    const snap = {
      t: 'state', code: room.code, host: room.hostId, mode: room.mode, state: room.state, time: Math.max(0, room.time), it: room.it, result: room.result,
      players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, head: p.head, lh: p.lh, rh: p.rh, ry: p.ry, vr: p.vr, infected: p.infected, immune: p.immune > 0 }))
    };
    room.players.forEach(p => send(p.ws, snap));
  });
}, 1000 / TICK_HZ);

server.listen(PORT, () => console.log('FERAL DEPTHS server listening on :' + PORT));
