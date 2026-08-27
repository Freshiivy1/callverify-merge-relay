/**
 * Self-test for the CallVerify merge-detection relay (server.js).
 *
 * What it proves, end to end against a real running relay:
 *   1. POSITIVE — a synthetic DTMF-'9' merge tone (852+1336 Hz) encoded as
 *      μ-law Twilio Media Stream frames is detected and the CALLBACK_URL POST
 *      arrives with the shared-secret header. The wall-clock latency from the
 *      FIRST tone frame to the callback is measured, printed, and asserted
 *      ≤ 500 ms (the merge-detection budget).
 *   2. NEGATIVE — 5 s of silence followed by speech-like noise must NOT fire
 *      the detector (no callback within 5 s).
 *
 * Run: npm test   (requires `npm install` first — only dep is `ws`)
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const SECRET = "selftest-secret";
const SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160

/* ------------------------------------------------------------------ */
/* G.711 μ-law encoder (PCM int16 → μ-law byte)                         */
/* ------------------------------------------------------------------ */
function encodeMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0x00;
  let pcm = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Synthesize a μ-law frame: dual-tone 852+1336 Hz (DTMF '9'). */
function toneFrame() {
  const bytes = Buffer.alloc(FRAME_SAMPLES);
  const phase = toneFrame.phase;
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (phase.value + i) / SAMPLE_RATE;
    const s =
      12000 * Math.sin(2 * Math.PI * 852 * t) + 12000 * Math.sin(2 * Math.PI * 1336 * t);
    bytes[i] = encodeMulaw(Math.round(s));
  }
  phase.value += FRAME_SAMPLES;
  return bytes.toString("base64");
}
toneFrame.phase = { value: 0 };

/** Silence frame (μ-law silence ≈ 0xff). */
function silenceFrame() {
  return Buffer.alloc(FRAME_SAMPLES, 0xff).toString("base64");
}

/** Speech-like noise: random amplitude-modulated bursts (never tonal). */
function noiseFrame(rng) {
  const bytes = Buffer.alloc(FRAME_SAMPLES);
  const burst = rng() < 0.5 ? 0 : 1; // babble gating
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const s = burst ? Math.round((rng() * 2 - 1) * 9000) : 0;
    bytes[i] = encodeMulaw(s);
  }
  return bytes.toString("base64");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function startCallbackServer() {
  const hits = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    const hit = {
      url: req.url,
      secret: req.headers["x-verify-secret"],
      at: Date.now(),
    };
    hits.push(hit);
    for (const w of waiters.splice(0)) w(hit);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        hits,
        port: server.address().port,
        nextHit: () => new Promise((r) => waiters.push(r)),
      }),
    );
  });
}

function startRelay(env) {
  const child = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    // server.js has no "ready" output beyond the listen line; give it a moment.
    child.stdout.once("data", () => resolve({ child }));
  });
}

/** Grab an ephemeral port by binding and immediately releasing. */
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function openStream(port, sid) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?sid=${encodeURIComponent(sid)}`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(
    JSON.stringify({
      event: "start",
      start: { streamSid: "MZ_selftest", accountSid: "AC_selftest", tracks: ["inbound"] },
    }),
  );
  return ws;
}

/** Send media frames in real time until `frames` are sent. */
async function streamFrames(ws, makeFrame, frames) {
  for (let i = 0; i < frames; i++) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(
      JSON.stringify({
        event: "media",
        media: { track: "inbound", payload: makeFrame(i) },
      }),
    );
    await sleep(FRAME_MS);
  }
}

/* ------------------------------------------------------------------ */
/* Test body                                                           */
/* ------------------------------------------------------------------ */
let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL  ${msg}`);
  }
}

const cb = await startCallbackServer();
const relayPort = await freePort();
const relay = await startRelay({
  PORT: String(relayPort),
  CALLBACK_URL: `http://127.0.0.1:${cb.port}/api/verify/stream-detected`,
  STREAM_SECRET: SECRET,
});
relay.port = relayPort;
await sleep(150); // let listen() complete
console.log(`relay on :${relay.port}, callback server on :${cb.port}`);

try {
  /* ---------- positive case: merge tone → callback within budget ---------- */
  console.log("\n[positive] streaming 200 ms silence then the 852+1336 Hz merge tone…");
  const ws1 = await openStream(relay.port, "selftest-positive");
  let firstToneAt = 0;
  const waitHit = cb.nextHit();
  // 10 silence frames (200 ms), then continuous tone.
  await streamFrames(ws1, silenceFrame, 10);
  firstToneAt = Date.now();
  const sending = streamFrames(ws1, toneFrame, 100); // 2 s of tone, plenty
  const hit = await Promise.race([waitHit, sleep(2000).then(() => null)]);
  assert(hit != null, "callback POST received after tone start");
  if (hit) {
    const latency = hit.at - firstToneAt;
    console.log(`  detection latency from first tone frame: ${latency} ms`);
    assert(latency <= 500, `latency ${latency} ms ≤ 500 ms budget`);
    assert(hit.url.includes("sid=selftest-positive"), "callback carries the session sid");
    assert(hit.secret === SECRET, "callback carries the x-verify-secret header");
  }
  await sending;
  ws1.close();

  /* ---------- negative case: silence + noise must NOT fire ---------- */
  console.log("\n[negative] streaming 2.5 s silence + 5 s speech-like noise…");
  const ws2 = await openStream(relay.port, "selftest-negative");
  let rngState = 0x2f6e2b1;
  const rng = () => {
    // deterministic xorshift32
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    return (rngState >>> 0) / 0xffffffff;
  };
  const hitsBefore = cb.hits.length;
  await streamFrames(ws2, silenceFrame, 125); // 2.5 s silence
  await streamFrames(ws2, () => noiseFrame(rng), 250); // 5 s noise
  assert(
    cb.hits.length === hitsBefore,
    "no callback fired during 7.5 s of silence/noise",
  );
  ws2.close();
} finally {
  relay.child.kill();
  cb.server.close();
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nselftest OK");
