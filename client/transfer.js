// Dumpit Web — transfer engine. Mirrors the desktop app's manifest ->
// accept -> stream-chunks -> done protocol, but over an RTCDataChannel
// instead of a raw TCP socket. File bytes never touch the signaling
// server — they go directly between the two browsers once the
// RTCPeerConnection is established.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CHUNK_SIZE = 64 * 1024; // 64KB — safe, well-tested data-channel chunk size
const BUFFERED_AMOUNT_LOW = 1024 * 1024; // backpressure watermark

function makePeerConnection() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

// ---- Saving received files ----
// Chrome/Edge: File System Access API — pick a folder once, then every
// incoming file writes straight into it, silently, just like the desktop
// app. Safari/Firefox don't have this API at all, so those files fall back
// to a normal browser download (goes to the Downloads folder, or prompts
// "Save As" depending on the person's browser settings). Either way the
// file arrives — it's the *landing spot* that differs, not whether they
// get it.
const hasFileSystemAccess = 'showDirectoryPicker' in window;
let savedDirHandle = null;

async function pickSaveFolder() {
  if (!hasFileSystemAccess) return null;
  savedDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  return savedDirHandle;
}

async function saveIncomingFile(name, blob) {
  if (hasFileSystemAccess && savedDirHandle) {
    try {
      const fileHandle = await savedDirHandle.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { method: 'folder' };
    } catch (err) {
      console.warn('[Dumpit Web] folder write failed, falling back to download', err);
    }
  }
  // Fallback: trigger a normal browser download.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { method: 'download' };
}

// ---- Sending files over a data channel ----

async function sendFilesOverChannel(channel, files, { onProgress, onDone, onError }) {
  try {
    const fileMetas = files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
    const totalSize = fileMetas.reduce((s, f) => s + f.size, 0);
    channel.send(JSON.stringify({ type: 'manifest', files: fileMetas, totalSize }));

    let sentTotal = 0;
    for (const file of files) {
      channel.send(JSON.stringify({ type: 'file-start', name: file.name, size: file.size }));
      const buf = await file.arrayBuffer();
      let offset = 0;
      while (offset < buf.byteLength) {
        // Backpressure: don't flood the data channel faster than it can drain.
        if (channel.bufferedAmount > BUFFERED_AMOUNT_LOW) {
          await new Promise((resolve) => {
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              resolve();
            };
          });
        }
        const chunk = buf.slice(offset, offset + CHUNK_SIZE);
        channel.send(chunk);
        offset += chunk.byteLength;
        sentTotal += chunk.byteLength;
        onProgress?.({ fileName: file.name, totalBytesSent: sentTotal, totalBytesExpected: totalSize });
      }
      channel.send(JSON.stringify({ type: 'file-end', name: file.name }));
    }
    channel.send(JSON.stringify({ type: 'done' }));
    onDone?.();
  } catch (err) {
    onError?.(err);
  }
}

// ---- Receiving files over a data channel ----

function makeReceiver(channel, { onManifest, onProgress, onFileComplete, onDone, onError }) {
  channel.binaryType = 'arraybuffer';
  let manifest = null;
  let currentFile = null;
  let currentChunks = [];
  let currentReceived = 0;
  let totalReceived = 0;

  channel.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'manifest') {
        manifest = msg;
        onManifest?.(msg);
      } else if (msg.type === 'file-start') {
        currentFile = { name: msg.name, size: msg.size };
        currentChunks = [];
        currentReceived = 0;
      } else if (msg.type === 'file-end') {
        const blob = new Blob(currentChunks);
        const saveResult = await saveIncomingFile(currentFile.name, blob);
        onFileComplete?.({ name: currentFile.name, size: currentFile.size, saveMethod: saveResult.method });
        currentFile = null;
        currentChunks = [];
      } else if (msg.type === 'done') {
        onDone?.({ senderName: manifest?.senderName, fileCount: manifest?.files?.length, totalSize: manifest?.totalSize });
      }
      return;
    }

    // Binary chunk
    if (!currentFile) return;
    currentChunks.push(event.data);
    currentReceived += event.data.byteLength;
    totalReceived += event.data.byteLength;
    onProgress?.({
      fileName: currentFile.name,
      totalBytesReceived: totalReceived,
      totalBytesExpected: manifest?.totalSize || currentFile.size,
    });
  };

  channel.onerror = (err) => onError?.(err);
}

window.DumpitTransfer = {
  makePeerConnection,
  sendFilesOverChannel,
  makeReceiver,
  pickSaveFolder,
  hasFileSystemAccess,
  get hasSaveFolder() { return !!savedDirHandle; },
};
