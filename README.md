# Dumpit Web

A second, browser-based way to use Dumpit — same fist-to-grab /
open-hand-to-catch idea as the desktop Air Grab, but running in a browser
tab with no install. This is a companion to the Electron app, not a
replacement.

## How it's different from the desktop app

- No local-network auto-discovery the way Electron's mDNS does. Instead,
  the signaling server groups browsers by shared public IP (same Wi-Fi),
  so devices on the same network just appear in a list automatically — no
  code needed for that case. A manual 6-digit code is kept as a visible
  fallback for two people who aren't on the same Wi-Fi.
- File bytes go **directly between the two browsers** over WebRTC — the
  signaling server only helps them find each other and never sees file
  contents.
- **Chrome/Edge**: pick a save folder once, then files write straight into
  it, silently — same feel as the desktop app.
- **Safari/Firefox/Brave (Shields on)**: no such API exists, so incoming
  files come through as normal browser downloads instead. Still arrives,
  just less seamless.

## 1. Deploy the signaling server (Render)

Render's free tier needs no card at all — the trade-off is it sleeps after
15 minutes of no traffic and takes ~30-50s to wake back up on the next
connection. Fine for testing; revisit Fly.io (with billing set up) or
Render's paid tier later if that delay ever matters for real users.

1. Push this whole `dumpit-web` folder to a GitHub repo (Render deploys
   from a repo, not a folder upload).
2. Go to `https://dashboard.render.com` → **New +** → **Web Service** →
   connect that repo.
3. Render should auto-detect `server/render.yaml`. If it asks you to fill
   settings in manually instead, use:
   - **Root Directory:** `server`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node signaling.js`
4. Create the service. Render gives you a URL like:
   ```
   https://dumpit-signal.onrender.com
   ```

## 2. Point the client at it

Edit `client/config.js` and put the exact URL Render gave you (swap
`https://` for `wss://`):

```js
window.DUMPIT_SIGNAL_URL = 'wss://dumpit-signal.onrender.com';
```

If Render appended numbers to your service name because it was taken,
make sure you copy the *real* URL it shows you, not the one you typed.

## 3. Host the client

`client/` is fully static (HTML/CSS/JS, no build step) — Vercel, Netlify,
Cloudflare Pages, or GitHub Pages all work. It must be served over
**HTTPS** — camera access and WebRTC both require a secure context.

For local testing:

```bash
cd client
npx serve .
```

## Known limitations of this pass

- No TURN server configured — only STUN (`stun.l.google.com`). Works on
  most home/office Wi-Fi; strict corporate networks may fail to establish
  the direct WebRTC connection without a TURN relay added later.
- One room = effectively one sender/receiver pair in typical use.
- No activity history yet on the web version (unlike the desktop app,
  which persists transfers to disk).
- Render free tier sleeps after 15 min idle — first connection after that
  can take 30-50s to respond. This is Render's behavior, not a bug.
