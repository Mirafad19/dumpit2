# Dumpit Web

A second, browser-based way to use Dumpit — same fist-to-grab /
open-hand-to-catch idea as the desktop Air Grab, but running in a browser
tab with no install. This is a companion to the Electron app, not a
replacement.

## How it's different from the desktop app

- No local-network auto-discovery (browsers can't do mDNS). Instead, one
  person creates a room and gets a 6-digit code; the other person enters it.
  Once both are in the room, it behaves just like Air Grab.
- File bytes go **directly between the two browsers** over WebRTC — the
  signaling server only helps them find each other and never sees file
  contents.
- **Chrome/Edge**: pick a save folder once, then files write straight into
  it, silently — same feel as the desktop app.
- **Safari/Firefox**: no such API exists, so incoming files come through as
  normal browser downloads instead. Still arrives, just less seamless.

## 1. Deploy the signaling server (Render)

1. Push this project to a GitHub repo.
2. Go to render.com → **New → Web Service** → connect the repo.
3. Set **Root Directory** to `server` — Render will pick up `render.yaml`
   automatically (Docker runtime, free plan, health check on `/health`).
   No card needed.
4. Deploy. Render gives you a URL like:

```
https://dumpit-signal.onrender.com
```

Your signaling URL is the same thing with `wss://` instead of `https://`:

```
wss://dumpit-signal.onrender.com
```

**Note on the free plan:** Render spins the service down after 15 minutes
with no traffic, and waking back up takes roughly 30–50 seconds. The first
person to connect after any gap that long will see a short delay before
the room responds — it's not broken, that's just the free tier. Once
you're actually launching this to real users rather than testing, that's
the point to move to a paid instance (or back to Fly with billing set up)
for instant response.

## 2. Point the client at it

Edit `client/config.js`:

```js
window.DUMPIT_SIGNAL_URL = 'wss://dumpit-signal.onrender.com';
```

## 3. Host the client

`client/` is fully static (HTML/CSS/JS, no build step) — drop it on
Cloudflare Pages, Netlify, Vercel, or GitHub Pages.
It just needs to be served over **HTTPS** (camera access and WebRTC both
require a secure context — `http://` will not work except on localhost).

For local testing:

```bash
cd client
npx serve .
```

## Known limitations of this first pass

- No TURN server configured — only STUN (`stun.l.google.com`). On most
  home/office Wi-Fi this is enough for two browsers to connect directly,
  but on some corporate networks with strict NAT/firewalls the WebRTC
  connection may fail to establish. Adding a TURN relay (e.g. via
  Cloudflare or Twilio) is the fix if that turns out to matter in practice.
- One room = effectively one sender/receiver pair in typical use. The
  server supports more than two people in a room, but that hasn't been
  tested end-to-end yet.
- No activity history yet on the web version (the desktop app persists
  transfers to disk; a browser tab doesn't have an equivalent by default).
