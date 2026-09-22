// Dumpit Web — app shell.
// Two ways to connect: (1) automatic — the signaling server groups every
// browser by shared public IP (same Wi-Fi), so devices just appear in a
// list, like the desktop app's dropdown; or (2) a manual 6-digit code, for
// two people who aren't on the same network. Either way, once a WebRTC
// data channel opens to at least one peer, we drop into the same Air Grab
// camera flow as desktop.

const pairScreen = document.getElementById('pairScreen');
const grabScreen = document.getElementById('grabScreen');

const deviceEmpty = document.getElementById('deviceEmpty');
const deviceList = document.getElementById('deviceList');
const connectAllBtn = document.getElementById('connectAllBtn');

const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const joinCodeInput = document.getElementById('joinCodeInput');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const roomCodeText = document.getElementById('roomCodeText');
const waitingText = document.getElementById('waitingText');
const pairError = document.getElementById('pairError');
const browserNote = document.getElementById('browserNote');

const video = document.getElementById('video');
const ringCanvas = document.getElementById('ringCanvas');
const ringCtx = ringCanvas.getContext('2d');
const orbBurst = document.getElementById('orbBurst');
const grabPulse = document.getElementById('grabPulse');
const gestureStatus = document.getElementById('gestureStatus');
const incomingBanner = document.getElementById('incomingBanner');
const toast = document.getElementById('toast');
const addFilesBtn = document.getElementById('addFilesBtn');
const stagedSummary = document.getElementById('stagedSummary');
const fileInput = document.getElementById('fileInput');
const exitBtn = document.getElementById('exitBtn');

// ---- Browser capability notice ----
browserNote.textContent = DumpitTransfer.hasFileSystemAccess
  ? ''
  : "Heads up: this browser can't save straight into a chosen folder, so incoming files will come through as normal downloads instead. For the seamless version, use Chrome or Edge.";

// ---- A friendly label for this device, shown to others in the list ----
function guessDeviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'a browser';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
const myLabel = guessDeviceLabel();

// ---- Signaling ----
let ws = null;
let myClientId = null;
let networkPeers = new Map(); // id -> label, from the auto-detected group
const peerConnections = new Map(); // peerId -> RTCPeerConnection
const dataChannels = new Map(); // peerId -> RTCDataChannel
const connectingTo = new Set();

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connectSignaling() {
  ws = new WebSocket(window.DUMPIT_SIGNAL_URL);

  // If we don't hear back within 6s, the signaling server is almost
  // certainly unreachable — say so loudly instead of spinning forever.
  const connectTimeout = setTimeout(() => {
    if (myClientId === null) {
      showConnectionStatus(
        `Can't reach the signaling server at ${window.DUMPIT_SIGNAL_URL}. ` +
        `Check it's deployed (server/) and that config.js has the right URL.`
      );
    }
  }, 6000);

  ws.onopen = () => send({ type: 'set-label', label: myLabel });
  ws.onmessage = (event) => {
    clearTimeout(connectTimeout);
    hideConnectionStatus();
    handleSignalMessage(JSON.parse(event.data));
  };
  ws.onerror = () => {
    clearTimeout(connectTimeout);
    showConnectionStatus(
      `Could not connect to the signaling server at ${window.DUMPIT_SIGNAL_URL}. ` +
      `Open DevTools → Console for the exact error.`
    );
  };
  ws.onclose = () => {
    if (myClientId === null) {
      showConnectionStatus('Connection to the signaling server closed before it finished connecting.');
    }
  };
}
connectSignaling(); // connect immediately on page load — this is what makes auto-detection happen with no button press

const connectionStatusEl = document.getElementById('connectionStatus');
const networkFingerprintEl = document.getElementById('networkFingerprint');
function showConnectionStatus(msg) {
  connectionStatusEl.textContent = msg;
  connectionStatusEl.classList.remove('hidden');
}
function hideConnectionStatus() {
  connectionStatusEl.classList.add('hidden');
}

function showPairError(msg) {
  pairError.textContent = msg;
  pairError.classList.remove('hidden');
}

async function handleSignalMessage(msg) {
  if (msg.type === 'network-joined') {
    myClientId = msg.clientId;
    networkFingerprintEl.textContent = `Network ID: ${msg.networkFingerprint}`;
    networkFingerprintEl.classList.remove('hidden');
  } else if (msg.type === 'presence' && msg.source === 'network') {
    networkPeers = new Map(msg.peers.map((p) => [p.id, p.label]));
    renderDeviceList();
  } else if (msg.type === 'presence' && msg.source === 'code') {
    // Manual code pairing: treat it like the old direct flow — connect to
    // whoever's in the code room right away, since joining a code room is
    // already an explicit, deliberate action from both sides.
    for (const peer of msg.peers) {
      if (!peerConnections.has(peer.id)) {
        const shouldOffer = myClientId < peer.id;
        await connectToPeer(peer.id, shouldOffer);
      }
    }
    if (msg.peers.length > 0) waitingText.textContent = 'Connected — opening Air Grab…';
  } else if (msg.type === 'code-room-created') {
    roomCodeText.textContent = msg.roomCode;
    roomCodeDisplay.classList.remove('hidden');
  } else if (msg.type === 'code-room-joined') {
    waitingText.textContent = 'Joined — waiting for connection…';
    roomCodeDisplay.classList.remove('hidden');
  } else if (msg.type === 'join-error') {
    showPairError(msg.message);
  } else if (msg.type === 'offer') {
    await connectToPeer(msg.from, false, msg.sdp);
  } else if (msg.type === 'answer') {
    const pc = peerConnections.get(msg.from);
    if (pc) await pc.setRemoteDescription(msg.sdp);
  } else if (msg.type === 'ice-candidate') {
    const pc = peerConnections.get(msg.from);
    if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate);
  }
}

// ---- Device list UI (the auto-detected "same Wi-Fi" flow) ----

function renderDeviceList() {
  const ids = [...networkPeers.keys()];
  if (ids.length === 0) {
    deviceEmpty.classList.remove('hidden');
    deviceList.classList.add('hidden');
    connectAllBtn.classList.add('hidden');
    return;
  }
  deviceEmpty.classList.add('hidden');
  deviceList.classList.remove('hidden');
  connectAllBtn.classList.remove('hidden');

  deviceList.innerHTML = '';
  for (const id of ids) {
    const li = document.createElement('li');
    li.className = 'device-item';
    const isBusy = connectingTo.has(id) || peerConnections.has(id);
    li.innerHTML = `
      <span class="device-dot"></span>
      <span class="device-name">${networkPeers.get(id)}</span>
      <button class="device-connect-btn" data-id="${id}" ${isBusy ? 'disabled' : ''}>
        ${peerConnections.has(id) ? 'Connected' : connectingTo.has(id) ? 'Connecting…' : 'Connect'}
      </button>
    `;
    deviceList.appendChild(li);
  }
  deviceList.querySelectorAll('.device-connect-btn').forEach((btn) => {
    btn.onclick = () => connectToPeer(btn.dataset.id, true);
  });
}

connectAllBtn.onclick = () => {
  // The one-click broadcast: offer a direct connection to every currently
  // known device on this Wi-Fi at once.
  for (const id of networkPeers.keys()) {
    if (!peerConnections.has(id) && !connectingTo.has(id)) connectToPeer(id, true);
  }
};

// ---- Manual code fallback ----

createRoomBtn.onclick = () => send({ type: 'create-code-room' });
joinRoomBtn.onclick = () => {
  const code = joinCodeInput.value.trim();
  if (!code) return;
  send({ type: 'join-code-room', roomCode: code });
};

// ---- WebRTC plumbing ----

async function connectToPeer(peerId, shouldOffer, remoteOffer) {
  connectingTo.add(peerId);
  renderDeviceList();

  const pc = DumpitTransfer.makePeerConnection();
  peerConnections.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) send({ type: 'ice-candidate', to: peerId, candidate: event.candidate });
  };
  pc.ondatachannel = (event) => setupChannel(peerId, event.channel);

  if (shouldOffer) {
    const channel = pc.createDataChannel('dumpit');
    setupChannel(peerId, channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, sdp: offer });
  } else if (remoteOffer) {
    await pc.setRemoteDescription(remoteOffer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'answer', to: peerId, sdp: answer });
  }
}

function setupChannel(peerId, channel) {
  dataChannels.set(peerId, channel);
  channel.onopen = () => {
    connectingTo.delete(peerId);
    renderDeviceList();
    enterGrabScreen();
  };
  DumpitTransfer.makeReceiver(channel, {
    onManifest: (manifest) => {
      pendingIncoming = { ...manifest, peerId };
      renderIncomingBanner();
    },
    onProgress: () => {},
    onFileComplete: () => {},
    onDone: (info) => {
      showToast(`Received ${info.fileCount || ''} file(s)`);
      receiving = false;
    },
    onError: (err) => showToast(`Error: ${err.message}`, 4000),
  });
}

function enterGrabScreen() {
  if (!grabScreen.classList.contains('hidden')) return;
  pairScreen.classList.add('hidden');
  grabScreen.classList.remove('hidden');
  bootGesture();
}

// ---- File staging ----

let stagedFiles = [];
let sendInFlight = false;
let fistArmed = true;
let receiving = false;
let pendingIncoming = null;

addFilesBtn.onclick = () => fileInput.click();
fileInput.onchange = () => {
  stagedFiles = [...stagedFiles, ...fileInput.files];
  renderStagedSummary();
};

function renderStagedSummary() {
  stagedSummary.textContent = stagedFiles.length === 0 ? 'No files staged' : `${stagedFiles.length} file(s) staged`;
}

function showToast(msg, ms = 3000) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

async function triggerSend() {
  if (sendInFlight) return;
  if (stagedFiles.length === 0) {
    gestureStatus.textContent = '✊ Fist detected — but no files are staged yet. Tap "Add Files…" first.';
    return;
  }
  if (dataChannels.size === 0) {
    gestureStatus.textContent = 'No one connected yet — go back and connect to a device first.';
    return;
  }
  sendInFlight = true;
  showToast(`Broadcasting ${stagedFiles.length} file(s) — waiting for someone to catch…`);
  const files = stagedFiles;
  for (const [, channel] of dataChannels) {
    if (channel.readyState !== 'open') continue;
    DumpitTransfer.sendFilesOverChannel(channel, files, {
      onProgress: () => {},
      onDone: () => {
        sendInFlight = false;
        showToast('Sent successfully');
        stagedFiles = [];
        renderStagedSummary();
      },
      onError: (err) => {
        sendInFlight = false;
        showToast(`Error: ${err.message}`, 4000);
      },
    });
  }
}

// ---- Receiving / catching ----

function renderIncomingBanner() {
  if (!pendingIncoming) {
    incomingBanner.classList.add('hidden');
    return;
  }
  const sizeMb = (pendingIncoming.totalSize / (1024 * 1024)).toFixed(1);
  incomingBanner.textContent = `Someone wants to send you ${pendingIncoming.files.length} file(s) (${sizeMb} MB) — hold an open hand to catch`;
  incomingBanner.classList.remove('hidden');
}

function playAuraSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    for (const freq of [523.25, 659.25, 783.99]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 1.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 1.35);
    }
  } catch (err) {
    console.warn('[Dumpit Web] could not play aura sound', err);
  }
}

function playGrabBlip() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(660, now + 0.15);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch (err) {
    console.warn('[Dumpit Web] could not play grab sound', err);
  }
}

function triggerGrabPulse(x, y) {
  grabPulse.style.setProperty('--gx', `${x}px`);
  grabPulse.style.setProperty('--gy', `${y}px`);
  grabPulse.classList.remove('hidden', 'playing');
  void grabPulse.offsetWidth;
  grabPulse.classList.add('playing');
  playGrabBlip();
  setTimeout(() => grabPulse.classList.add('hidden'), 700);
}

function triggerCatchReveal(x, y) {
  orbBurst.style.setProperty('--ox', `${x}px`);
  orbBurst.style.setProperty('--oy', `${y}px`);
  orbBurst.style.background = `radial-gradient(circle at ${x}px ${y}px, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.5) 35%, rgba(255,255,255,0) 70%)`;
  orbBurst.classList.remove('hidden', 'playing');
  void orbBurst.offsetWidth;
  orbBurst.classList.add('playing');
  playAuraSound();
}

async function acceptPending(x, y) {
  if (!pendingIncoming) return;
  if (!DumpitTransfer.hasSaveFolder && DumpitTransfer.hasFileSystemAccess) {
    try {
      await DumpitTransfer.pickSaveFolder();
    } catch {
      // dismissed — falls back to downloads this time
    }
  }
  receiving = true;
  triggerCatchReveal(x, y);
  pendingIncoming = null;
  renderIncomingBanner();
  gestureStatus.textContent = 'Catching…';
}

// ---- Gesture wiring ----

function resizeCanvas() {
  ringCanvas.width = window.innerWidth;
  ringCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function landmarkToCanvas(landmark) {
  return { x: ringCanvas.width - landmark.x * ringCanvas.width, y: landmark.y * ringCanvas.height };
}

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function drawSkeleton(landmarks) {
  const points = landmarks.map(landmarkToCanvas);
  ringCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  ringCtx.lineWidth = 3;
  for (const [a, b] of HAND_CONNECTIONS) {
    ringCtx.beginPath();
    ringCtx.moveTo(points[a].x, points[a].y);
    ringCtx.lineTo(points[b].x, points[b].y);
    ringCtx.stroke();
  }
  ringCtx.fillStyle = '#1090e0';
  for (const p of points) {
    ringCtx.beginPath();
    ringCtx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ringCtx.fill();
  }
}

function drawRevealRing(x, y, pct) {
  const radius = 46;
  ringCtx.lineWidth = 6;
  ringCtx.strokeStyle = 'rgba(255,255,255,0.15)';
  ringCtx.beginPath();
  ringCtx.arc(x, y, radius, 0, Math.PI * 2);
  ringCtx.stroke();
  ringCtx.lineWidth = 6;
  ringCtx.strokeStyle = '#1090e0';
  ringCtx.lineCap = 'round';
  ringCtx.beginPath();
  ringCtx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
  ringCtx.stroke();
}

function onGestureUpdate(gesture, landmarks, extra) {
  if (receiving) return;
  ringCtx.clearRect(0, 0, ringCanvas.width, ringCanvas.height);

  if (gesture === 'fist') {
    if (landmarks) drawSkeleton(landmarks);
    if (fistArmed && !sendInFlight) {
      fistArmed = false;
      const pos = landmarks ? landmarkToCanvas(landmarks[0]) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      if (stagedFiles.length > 0) triggerGrabPulse(pos.x, pos.y);
      triggerSend();
    }
    if (!pendingIncoming) gestureStatus.textContent = '✊ Fist held';
  } else {
    fistArmed = true;
  }

  if (gesture === 'revealing' && landmarks) {
    const pos = landmarkToCanvas(landmarks[0]);
    drawRevealRing(pos.x, pos.y, extra.openHoldPct);
    if (!pendingIncoming) gestureStatus.textContent = 'Hold steady…';
  }

  if (gesture === 'open' && landmarks) {
    drawSkeleton(landmarks);
    const pos = landmarkToCanvas(landmarks[0]);
    if (pendingIncoming) {
      gestureStatus.textContent = 'Catching…';
      acceptPending(pos.x, pos.y);
    } else {
      gestureStatus.textContent = '🖐 Open hand';
    }
  }

  if (gesture === 'none' && !pendingIncoming) {
    gestureStatus.textContent = 'No hand detected';
  }
}

async function bootGesture() {
  try {
    await DumpitGesture.initGesture(video, onGestureUpdate);
    gestureStatus.textContent = 'Camera ready — fist to grab, hold an open hand steady to catch';
  } catch (err) {
    gestureStatus.textContent = `Camera error: ${err.message}`;
  }
}

exitBtn.onclick = () => {
  DumpitGesture.stopGesture();
  for (const pc of peerConnections.values()) pc.close();
  peerConnections.clear();
  dataChannels.clear();
  if (ws) ws.close();
  window.location.reload();
};

renderStagedSummary();
