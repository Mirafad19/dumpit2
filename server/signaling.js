// Dumpit Web — signaling server.
//
// This server's entire job is introducing browsers to each other so they
// can open a direct WebRTC connection. File bytes never pass through here
// — once two browsers are connected, they talk directly to each other.
//
// AUTO-DISCOVERY, THE ONLY WAY A BROWSER CAN ACTUALLY DO IT:
// A web page can't scan the local network the way the Electron app's mDNS
// discovery does — browsers block that outright, no setting fixes it.
// What we CAN do instead: every device on the same Wi-Fi shares the same
// public IP address (that's just how home/office routers work — it's
// called NAT). So the moment a browser connects here, we group it with
// every other currently-connected browser that has the SAME public IP.
// That reproduces "device just shows up" without needing a typed code.
//
// Caveat worth knowing: in a big shared network (large office, campus,
// coffee shop) many unrelated people can share one public IP, so that
// "network group" can occasionally include strangers. That's a property
// of NAT, not a bug — it's why joining is still an explicit click, not an
// automatic file send.
//
// The manual 6-digit room code still exists as a fallback for the case
// where two people are NOT on the same network (e.g. one's on mobile
// data) and still want to pair directly.

const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

// networkGroups: Map<publicIp, Map<clientId, { ws, label }>>
const networkGroups = new Map();
// codeRooms: Map<roomCode, Map<clientId, { ws, label }>>  — manual fallback
const codeRooms = new Map();

function getPublicIp(req) {
  // Fly.io (and most proxies/CDNs) put the real client IP in one of these
  // headers, since req.socket.remoteAddress would otherwise just be the
  // proxy's own IP.
  const fwd = req.headers['fly-client-ip'] || req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function makeRoomCode() {
  return crypto.randomInt(100000, 999999).toString();
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastGroupPresence(group, source) {
  const entries = [...group.entries()];
  for (const [id, client] of entries) {
    const others = entries
      .filter(([otherId]) => otherId !== id)
      .map(([otherId, other]) => ({ id: otherId, label: other.label }));
    send(client.ws, { type: 'presence', source, peers: others });
  }
}

wss.on('connection', (ws, req) => {
  const clientId = crypto.randomUUID();
  const publicIp = getPublicIp(req);
  let label = 'A device';
  let joinedCodeRoom = null;

  // Auto-join the network group for this IP the moment the socket opens —
  // this is what makes devices "just appear," no button press needed.
  if (!networkGroups.has(publicIp)) networkGroups.set(publicIp, new Map());
  const myGroup = networkGroups.get(publicIp);
  myGroup.set(clientId, { ws, label });
  // Short, non-reversible fingerprint of the grouping IP — not the real IP
  // itself, just enough for two screens to be visually compared side by
  // side to confirm "yes, these two are actually landing in the same
  // group." If they don't match, that's the whole bug, right there.
  const networkFingerprint = crypto.createHash('sha256').update(publicIp).digest('hex').slice(0, 6);
  send(ws, { type: 'network-joined', clientId, networkFingerprint });
  broadcastGroupPresence(myGroup, 'network');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'set-label') {
      label = msg.label || label;
      const entry = myGroup.get(clientId);
      if (entry) entry.label = label;
      broadcastGroupPresence(myGroup, 'network');
      return;
    }

    if (msg.type === 'create-code-room') {
      const roomCode = makeRoomCode();
      codeRooms.set(roomCode, new Map([[clientId, { ws, label }]]));
      joinedCodeRoom = roomCode;
      send(ws, { type: 'code-room-created', roomCode });
      return;
    }
    if (msg.type === 'join-code-room') {
      const room = codeRooms.get(msg.roomCode);
      if (!room) {
        send(ws, { type: 'join-error', message: 'Room not found — check the code.' });
        return;
      }
      joinedCodeRoom = msg.roomCode;
      room.set(clientId, { ws, label });
      send(ws, { type: 'code-room-joined', roomCode: msg.roomCode });
      broadcastGroupPresence(room, 'code');
      return;
    }

    // Relay WebRTC signaling to a specific peer, whichever group they're
    // reachable through (network group or code room) — payload is opaque
    // to this server either way.
    if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
      const target = myGroup.get(msg.to) || (joinedCodeRoom && codeRooms.get(joinedCodeRoom)?.get(msg.to));
      if (target) send(target.ws, { ...msg, from: clientId });
      return;
    }
  });

  ws.on('close', () => {
    myGroup.delete(clientId);
    if (myGroup.size === 0) networkGroups.delete(publicIp);
    else broadcastGroupPresence(myGroup, 'network');

    if (joinedCodeRoom) {
      const room = codeRooms.get(joinedCodeRoom);
      if (room) {
        room.delete(clientId);
        if (room.size === 0) codeRooms.delete(joinedCodeRoom);
        else broadcastGroupPresence(room, 'code');
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dumpit Web signaling server listening on :${PORT}`);
});
