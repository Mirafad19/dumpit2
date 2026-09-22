// Dumpit Web — signaling server.
//
// This server's entire job is introducing two browsers to each other so
// they can open a direct WebRTC connection. Once that connection is up,
// file bytes flow peer-to-peer over the data channel — they never pass
// through this server, and it never stores anything to disk. If this
// server goes down mid-transfer, an already-connected transfer keeps
// going; only *new* connections would be affected.

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

// rooms: Map<roomCode, Map<clientId, ws>>
const rooms = new Map();

function makeRoomCode() {
  // Short, easy to read aloud / type on the other laptop — like a pairing
  // code, not a long opaque token.
  return crypto.randomInt(100000, 999999).toString();
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastPresence(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const ids = [...room.keys()];
  for (const [id, ws] of room) {
    send(ws, { type: 'presence', peers: ids.filter((x) => x !== id) });
  }
}

wss.on('connection', (ws) => {
  let roomCode = null;
  let clientId = crypto.randomUUID();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create-room') {
      roomCode = makeRoomCode();
      rooms.set(roomCode, new Map([[clientId, ws]]));
      send(ws, { type: 'room-created', roomCode, clientId });
      return;
    }

    if (msg.type === 'join-room') {
      const room = rooms.get(msg.roomCode);
      if (!room) {
        send(ws, { type: 'join-error', message: 'Room not found — check the code.' });
        return;
      }
      if (room.size >= 2) {
        send(ws, { type: 'join-error', message: 'This room already has two people in it.' });
        return;
      }
      roomCode = msg.roomCode;
      room.set(clientId, ws);
      send(ws, { type: 'room-joined', roomCode, clientId });
      broadcastPresence(roomCode);
      return;
    }

    // Relay WebRTC signaling (offer/answer/ICE candidates) to a specific
    // peer in the same room. Payload is opaque to this server.
    if (['offer', 'answer', 'ice-candidate'].includes(msg.type)) {
      const room = rooms.get(roomCode);
      if (!room) return;
      const target = room.get(msg.to);
      if (target) {
        send(target, { ...msg, from: clientId });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.delete(clientId);
    if (room.size === 0) {
      rooms.delete(roomCode);
    } else {
      broadcastPresence(roomCode);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Dumpit Web signaling server listening on :${PORT}`);
});
