# Herdr Web

A web app for watching and answering your [Herdr](https://herdr.dev) agents
from an iPhone. It talks to **herdr-core** (`hc connect`, JSON-RPC), the same
core the Herdr desktop window uses, so everything you do here shows up there too.

- **Agents**: by priority (Needs you / Done / Working / Idle) or grouped by space, updated live.
- **Agent screen**: its terminal text, tidied up for a phone screen, following the output while it works.
- **Answering**: send a message, press keys (esc, ⇧⇥, arrows, enter, 1/2/3, ^C, Stop),
  and tap the options of a permission prompt or menu.
- **New agent**: start Claude Code or a shell in a new tab of any space.
- **Notifications** (Web Push): when an agent needs you or finishes. Works from a Home Screen app (iOS 16.4+).
- No dependencies, just Node ≥ 20.

## Run it

```sh
npm start                 # http://127.0.0.1:8787
```

The server only listens on localhost. To reach it from your phone over Tailscale:

```sh
tailscale serve --bg --https=8445 http://127.0.0.1:8787
# → https://<mac>.<tailnet>.ts.net:8445   (tailnet only)
```

Through `tailscale serve` you're signed in by your Tailscale identity (the
`Tailscale-User-Login` header), so the phone needs no password. Anywhere else
it asks for the token printed at start (`npm run token`).
`HERDR_WEB_ALLOWED_LOGINS=a@x.com,b@y.com` limits which Tailscale users get in.

### On the iPhone

1. Open `https://<mac>.<tailnet>.ts.net:8445` in Safari.
2. Share → **Add to Home Screen**.
3. Open Herdr from the Home Screen → ⚙︎ → **Notify me**.

### Keep it running

```sh
scripts/install-launchd.sh     # starts at login, restarts if it dies
scripts/uninstall-launchd.sh   # undo
```

Log: `~/Library/Logs/herdr-web.log`. State (token, push keys and subscriptions):
`~/.config/herdr-web/`.

## How it works

```
iPhone (PWA) ──https──▶ tailscale serve ──▶ server.js :8787 ──stdin/stdout──▶ hc connect ──▶ herdr-core
             ◀──SSE───                                       events.subscribe, terminal.read/send/keys
```

- `lib/hc.js`: JSON-RPC client over `hc connect`, reconnects by itself.
- `server.js`: subscribes to core events, re-lists terminals and the
  `herdr-app` layout document (spaces/tabs) on every change, pushes state to
  the browser over SSE, and sends Web Push when an agent becomes blocked or done.
- `lib/push.js`: Web Push with VAPID and aes128gcm using only `node:crypto`.
- `public/`: the app: plain HTML/CSS/JS, a service worker, and a manifest.

A screen is read with `terminal.read` (text, no colours): while the agent
works it's polled every ~1.2 s, otherwise it's read again only when something
changes, because reading an idle full-screen app's history scrolls it.
