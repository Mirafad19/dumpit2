// Dumpit Web — gesture detection. Same MediaPipe HandLandmarker approach as
// the desktop app's renderer/gesture.js, adapted to run standalone in a
// browser tab (no Electron IPC).
//
// Difference from desktop, on purpose: an OPEN hand only "reveals" (draws
// the skeleton, becomes actionable) after being held steadily for ~2
// seconds. On desktop this was tuned for speed; here the goal is a calmer,
// more deliberate feel — a flash of an open hand walking past the camera
// shouldn't light anything up. A FIST still responds fast, since grabbing
// is a deliberate, quick action, not something you want to accidentally
// hold for 2 seconds while your files just sit there staged.

(function () {
  let handLandmarker = null;
  let videoEl = null;
  let stream = null;
  let rafId = null;
  let onGestureCallback = null;

  const FIST_FRAMES_TO_CONFIRM = 4;
  const OPEN_HOLD_MS = 2000; // the "calm reveal" delay you asked for
  const PRESENCE_FRAMES_TO_CONFIRM = 3;

  let fistStreak = 0;
  let presenceStreak = 0;
  let openHoldStart = null;

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function isFingerCurled(landmarks, tipIdx, pipIdx, wristIdx) {
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    const wrist = landmarks[wristIdx];
    return distance(tip, wrist) < distance(pip, wrist) * 1.1;
  }

  // Same best-effort palm-vs-back-of-hand heuristic as desktop. See the
  // note in the Electron app's gesture.js if this ever needs flipping for
  // a given camera setup.
  function isPalmFacing(landmarks, handednessLabel) {
    if (!handednessLabel) return true;
    const wrist = landmarks[0];
    const indexMcp = landmarks[5];
    const pinkyMcp = landmarks[17];
    const v1x = indexMcp.x - wrist.x, v1y = indexMcp.y - wrist.y;
    const v2x = pinkyMcp.x - wrist.x, v2y = pinkyMcp.y - wrist.y;
    const cross = v1x * v2y - v1y * v2x;
    return handednessLabel === 'Right' ? cross < 0 : cross > 0;
  }

  function rawClassify(landmarks, handednessLabel) {
    if (!isPalmFacing(landmarks, handednessLabel)) return 'none';
    const fingers = [[8, 6], [12, 10], [16, 14], [20, 18]];
    let curled = 0;
    for (const [tip, pip] of fingers) if (isFingerCurled(landmarks, tip, pip, 0)) curled++;
    if (curled >= 3) return 'fist';
    if (curled === 0) return 'open';
    return 'none';
  }

  async function initGesture(videoElement, onGesture) {
    videoEl = videoElement;
    onGestureCallback = onGesture;

    const vision = await import(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
    );
    const { FilesetResolver, HandLandmarker } = vision;
    const filesetResolver = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );
    handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });

    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    videoEl.srcObject = stream;
    await videoEl.play();
    loop();
  }

  function loop() {
    if (!handLandmarker || !videoEl) return;
    const now = performance.now();
    const result = handLandmarker.detectForVideo(videoEl, now);

    let rawLandmarks = null;
    let handednessLabel = null;
    if (result.landmarks?.length > 0) {
      rawLandmarks = result.landmarks[0];
      const handednessArr = result.handedness || result.handednesses;
      handednessLabel = handednessArr?.[0]?.[0]?.categoryName || null;
      presenceStreak++;
    } else {
      presenceStreak = 0;
    }

    const confidentLandmarks = presenceStreak >= PRESENCE_FRAMES_TO_CONFIRM ? rawLandmarks : null;
    const raw = confidentLandmarks ? rawClassify(confidentLandmarks, handednessLabel) : 'none';

    // Fist: fast, same-frame response (after the normal presence debounce).
    if (raw === 'fist') {
      fistStreak++;
    } else {
      fistStreak = 0;
    }

    // Open: needs a full 2-second steady hold before it reveals anything.
    let openHoldPct = 0;
    if (raw === 'open') {
      if (!openHoldStart) openHoldStart = performance.now();
      openHoldPct = Math.min(1, (performance.now() - openHoldStart) / OPEN_HOLD_MS);
    } else {
      openHoldStart = null;
      openHoldPct = 0;
    }

    let stable = 'none';
    if (fistStreak >= FIST_FRAMES_TO_CONFIRM) stable = 'fist';
    else if (raw === 'open' && openHoldPct >= 1) stable = 'open';
    else if (raw === 'open') stable = 'revealing'; // mid-hold — caller can show a subtle progress cue, not a full skeleton

    onGestureCallback?.(stable, confidentLandmarks, { openHoldPct });
    rafId = requestAnimationFrame(loop);
  }

  function stopGesture() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    handLandmarker = null;
    presenceStreak = 0;
    fistStreak = 0;
    openHoldStart = null;
  }

  window.DumpitGesture = { initGesture, stopGesture };
})();
