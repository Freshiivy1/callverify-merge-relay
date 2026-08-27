# Deploy Guide — CallVerify Merge-Detection Relay → Render.com

This relay is what gets you **merge detection ≤ 0.5 s**: it hosts the WebSocket
that Twilio Media Streams connects to and runs the Goertzel DTMF-'9' detector
(852 + 1336 Hz) on Leg B's live audio. On detection (~300 ms of tone) it POSTs
to the main app, which plays the verdict and terminates both calls.

## 1. Push this folder to GitHub

```bash
cd merge-relay
git init && git add -A && git commit -m "callverify merge relay"
git remote add origin https://github.com/<you>/callverify-merge-relay.git
git push -u origin main
```

## 2. Create the Render service

**Option A — Blueprint (uses render.yaml):**
Render Dashboard → **New → Blueprint** → connect the repo → apply.

**Option B — Manual Web Service:**
1. Render Dashboard → **New → Web Service** → pick the repo
2. Runtime: **Node**; Build command: `npm install`; Start command: `npm start`
3. Health check path: `/health`
4. Instance type: **Free** is fine

## 3. Set environment variables (Render → service → Environment)

| Var | Value |
|---|---|
| `CALLBACK_URL` | `https://<your-main-app-domain>/api/verify/stream-detected` |
| `STREAM_SECRET` | Long random string, e.g. `openssl rand -hex 32` |

Render injects `PORT` itself — do not set it.

## 4. Wire the main app

On the main app's host, set and republish/restart:

| Var | Value |
|---|---|
| `VERIFY_STREAM_URL` | `wss://<your-relay-name>.onrender.com/` (note: **wss**, trailing slash OK) |
| `VERIFY_STREAM_SECRET` | The exact same string as `STREAM_SECRET` above |
| `PUBLIC_BASE_URL` | `https://<your-main-app-domain>` (needed so Twilio webhooks resolve) |

## 5. Verify

```bash
curl https://<your-relay-name>.onrender.com/health
# {"ok":true,"service":"callverify-merge-relay"}
```

Then run a verification call and merge the calls on the callee's phone.
Expected: session event log shows `MERGE_STREAM_DETECTED` (not the ~2 s
`MERGE_RECORD_DETECTED` fallback), and both calls terminate in **under half a
second** after the tone starts leaking.

## Notes / gotchas

- **Free-tier cold start:** Render free instances sleep after inactivity. The
  first verification call after idle may wait ~30–60 s for the relay to wake
  (the TwiML `<Start><Stream>` connect will block until then). Paid tier or a
  cron ping of `/health` avoids this. Detection itself is unaffected once the
  stream is connected.
- **Secret rotation:** change `STREAM_SECRET` (relay) and `VERIFY_STREAM_SECRET`
  (main app) together.
- **Self-test before deploy:** `npm install && npm test` inside this folder
  spins up the relay + a dummy callback server, streams a synthetic tone, and
  asserts the callback fires within 500 ms.
