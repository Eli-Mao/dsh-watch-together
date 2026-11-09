// dsh-watch-eyes daemon: holds the resident capture worker and a warm HTTP
// connection to the vision endpoint, and answers frames over loopback.
import http from 'node:http'
import { CaptureWorker } from './capture.mjs'
import { describe, probe } from './vision.mjs'
import { DATA_DIR, hashDistance, loadConfig, log, PID_PATH, STATE_DIR } from './shared.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// The mouth is its own service (37716) since 2026-10-26. This daemon used to
// own a Speaker, which meant a capture-worker restart also killed the voice and
// a slow synthesis could block screen_look. /say, /said, /mouth and /devices
// below are thin proxies so old callers keep working; the audio never lives here.
const MOUTH_URL = process.env.DSH_MOUTH_URL || 'http://127.0.0.1:37716'

const cfg = loadConfig()
const worker = new CaptureWorker()
worker.start().catch((e) => log('worker start failed: ' + String(e && e.message)))

async function mouth(path, timeoutMs) {
  const res = await fetch(MOUTH_URL + path, { signal: AbortSignal.timeout(timeoutMs ?? 20000) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error('mouth ' + res.status + ': ' + String((body && body.error) || 'unknown'))
  return body
}

const state = {
  started: Date.now(),
  lastHash: null,
  lastBytes: null,
  lastFrame: null,
  windowsCache: null,
  windowsCacheAt: 0,
  lookCount: 0,
  skipCount: 0,
  lastLook: null,
}

// Which window is in front, and roughly where the screen is.
//
// The video path never needed this: there was one <video> and it was always the
// subject. Watching "whatever the user is looking at" does need it - and it must
// be cheap, so this is a Win32 call, not a screenshot.
const FG_SCRIPT = fileURLToPath(new URL('./fg-window.ps1', import.meta.url))

async function foregroundWindow() {
  // Fast path: the resident capture worker answers this in a few ms.
  try {
    const w = await worker.foreground()
    if (w && typeof w === 'object' && !w.error && w.title !== undefined) {
      const valid = (w.w || 0) >= 200 && (w.h || 0) >= 150
      return { valid, pid: w.pid, process: w.process, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h }
    }
  } catch { /* fall through to the spawn path */ }
  return await new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FG_SCRIPT],
      { windowsHide: true },
    )
    let out = ''
    const timer = setTimeout(() => { try { ps.kill() } catch { /* gone */ } resolve({ valid: false, reason: 'timeout' }) }, 5000)
    ps.stdout.on('data', (d) => { out += String(d) })
    ps.on('exit', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out.trim())
        resolve({
          valid: j.w >= 200 && j.h >= 150,
          pid: j.pid, process: j.process, title: j.title,
          x: j.x, y: j.y, w: j.w, h: j.h,
        })
      } catch {
        resolve({ valid: false, reason: 'parse failed' })
      }
    })
  })
}

function virtualRect() {
  // Union of all monitors, matching what the capture worker's CAPTURE|full uses.
  // A configured region wins; otherwise return null, which captureRect treats as
  // "the whole virtual desktop" - the same thing CAPTURE|full grabs.
  const sx = cfg.capture.region
  if (sx && sx.x !== undefined) return { x: sx.x, y: sx.y, width: sx.w || sx.width, height: sx.h || sx.height }
  return null
}

async function captureRect(rect, width) {
  // Reuse the worker's region support. A missing rect falls back to full screen,
  // which is exactly what a maximised player wants.
  const region = rect && rect.width > 50 && rect.height > 50
    ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
    : null
  const shot = await worker.capture({ region, width: width || 960, quality: cfg.capture.quality })
  // The worker returns the JPEG as base64 in `data`, NOT as a file. /fgscreen has to
  // write it, because its caller (/read, the screen-mode sampler) works from a PATH.
  //
  // This used to return { path: shot.path } - a field that never existed - so every
  // /fgscreen response carried path: undefined, the sampler handed "undefined" to
  // /read, and the vision call died with ENOENT. The hash and the window were
  // correct, so the sampler looked alive: it read 29 frames and described none.
  const dir = join(DATA_DIR, 'frames')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'fg-' + Date.now() + '.jpg')
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  return { path, width: shot.width, height: shot.height, hash: shot.hash, bytes: shot.bytes }
}

async function listWindows(maxAgeMs) {
  const now = Date.now()
  if (state.windowsCache && now - state.windowsCacheAt < (maxAgeMs ?? 3000)) return state.windowsCache
  const list = await worker.windows()
  state.windowsCache = Array.isArray(list) ? list : [list]
  state.windowsCacheAt = now
  return state.windowsCache
}

function matchWindow(list, needle) {
  if (!needle) return null
  const q = String(needle).toLowerCase()
  const hits = list.filter((w) => String(w.title).toLowerCase().includes(q))
  if (hits.length === 0) return null
  hits.sort((a, b) => b.w * b.h - a.w * a.h)
  return hits[0]
}

function parseRegion(raw) {
  if (!raw) return null
  const n = String(raw).split(',').map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) return null
  return { x: n[0], y: n[1], w: n[2], h: n[3] }
}

// The calibrated player rectangle saved by the calibration run. Without this
// fallback the config key is silently ignored and every frame is the whole
// desktop again, which throws away most of the detail.
function configRegion() {
  const r = cfg.capture.region
  if (!r || !(r.w > 0) || !(r.h > 0)) return null
  return { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w), h: Number(r.h) }
}

async function resolveTarget(query) {
  const width = query.width ? Number(query.width) : cfg.capture.width
  const quality = query.quality ? Number(query.quality) : cfg.capture.quality
  let region = parseRegion(query.region)
  let window = null
  // An explicit region supersedes the configured window match.
  const wanted = query.window !== undefined ? query.window : query.region ? '' : cfg.capture.window
  if (!region && wanted) {
    const list = await listWindows()
    const hit = matchWindow(list, wanted)
    if (hit) {
      window = { title: hit.title, process: hit.process, pid: hit.pid }
      region = { x: hit.x, y: hit.y, w: hit.w, h: hit.h }
    }
  }
  if (!region && !window) region = configRegion()
  return { region, window, width, quality }
}

async function look(query) {
  const t0 = Date.now()
  const target = await resolveTarget(query)
  const frame = await worker.capture({ width: target.width, quality: target.quality, region: target.region })
  const captureMs = Date.now() - t0
  const force = query.force === '1' || query.force === 'true'
  const threshold = query.threshold !== undefined ? Number(query.threshold) : cfg.capture.diffThreshold
  const distance = state.lastHash === null ? null : hashDistance(state.lastHash, frame.hash)
  // A 16x16 aHash alone cannot prove a video frame did not move; a real change
  // also shifts the JPEG size. Require both to agree before skipping a look.
  const drift = state.lastBytes === null ? 0 : Math.abs(frame.bytes - state.lastBytes)
  const tolerable = Math.max(96, Math.round((state.lastBytes ?? frame.bytes) * 0.01))
  const unchanged = !force && distance !== null && distance <= threshold && drift <= tolerable
  state.lastFrame = frame
  if (unchanged) {
    state.skipCount += 1
    return {
      changed: false,
      text: '(画面没有变化)',
      hash: frame.hash,
      distance,
      captureMs,
      apiMs: 0,
      model: null,
      window: target.window,
      totalMs: Date.now() - t0,
    }
  }
  const v = await describe(cfg, frame.data, query.prompt)
  state.lastHash = frame.hash
  state.lastBytes = frame.bytes
  state.lookCount += 1
  const out = {
    changed: true,
    text: v.text,
    hash: frame.hash,
    distance,
    captureMs,
    apiMs: v.ms,
    model: v.model,
    // True when a fallback model served this frame instead of the configured
    // primary. Worth surfacing: the free fallback reads burned-in subtitles
    // worse, so a caller seeing too many degraded reads should top up.
    degraded: !!v.degraded,
    tokens: v.tokens,
    window: target.window,
    totalMs: Date.now() - t0,
  }
  state.lastLook = out
  return out
}

async function watch(query) {
  const seconds = Math.min(Math.max(Number(query.seconds) || 20, 2), 300)
  const every = Math.min(Math.max(Number(query.every) || 3, 0.5), 60)
  const maxFrames = Math.min(Math.max(Number(query.max) || 40, 1), 200)
  const deadline = Date.now() + seconds * 1000
  const frames = []
  while (Date.now() < deadline && frames.length < maxFrames) {
    const t = Date.now()
    try {
      const r = await look(query)
      frames.push({ at: new Date(t).toISOString(), changed: r.changed, text: r.text, ms: r.totalMs })
    } catch (e) {
      frames.push({ at: new Date(t).toISOString(), changed: false, text: '', error: String(e && e.message) })
    }
    const wait = every * 1000 - (Date.now() - t)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  return { seconds, every, frames, skipped: state.skipCount }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 1)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

// Loopback is not the same as "a program on this machine". A web page reaches
// 127.0.0.1 too: an <img> or fetch() on any site fires a GET at this port, and
// every route here acts on a plain GET. A DNS-rebinding name that resolves to
// 127.0.0.1 even makes the page same-origin with this daemon, so it can read
// the answer back. Such requests carry the page's own name in Host and, from
// any current browser, an Origin and/or Sec-Fetch-Site header. The plugin's own
// clients (Node fetch in the DSH plugin host, the sibling daemons, the CLIs)
// send Host 127.0.0.1:<port> and neither of the other two.
//
// Sec-Fetch-Site: none is a navigation the user typed or bookmarked, not one a
// page started, so opening a route in the address bar still works.
function browserRefusal(req) {
  const h = req.headers
  const host = String(h.host || '').toLowerCase()
  const port = req.socket && req.socket.localPort
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return 'unexpected Host header'
  if (h.origin !== undefined) return 'requests from a web page are not accepted'
  const site = h['sec-fetch-site']
  if (site !== undefined && site !== 'none') return 'requests from a web page are not accepted'
  return null
}

// Autonomous narration. Capture, describe and speak from inside the daemon so
// live commentary does not depend on an agent turn: one turn costs ~35s, which
// is the whole reason the loop felt laggy.
const narrate = {
  running: false,
  timer: null,
  every: 0,
  prompt: '',
  spoken: 0,
  lines: [],
  lastText: null,
  startedAt: 0,
  error: null,
  // Why the loop has not said anything. "spoken: 0" alone is ambiguous: it is
  // the correct answer on a still screen, and also what a broken loop looks
  // like. Counting the skip reason makes "she is quiet because nothing moved"
  // distinguishable from "she is quiet because she is dead".
  ticks: 0,
  skippedSame: 0,
  skippedPaused: 0,
  lastSkip: null,
}

async function narrateTick() {
  if (!narrate.running) return
  try {
    narrate.ticks += 1
    const r = await look({ prompt: narrate.prompt })
    if (!r.changed) {
      narrate.skippedSame += 1
      narrate.lastSkip = 'frame unchanged'
      return
    }
    if (r.text === narrate.lastText) {
      narrate.skippedSame += 1
      narrate.lastSkip = 'same line as last time'
      return
    }
    if (!r.text) {
      narrate.lastSkip = 'empty description'
      return
    }
    narrate.lastText = r.text
    narrate.spoken += 1
    narrate.lines.push({ at: new Date().toISOString(), text: r.text })
    if (narrate.lines.length > 60) narrate.lines.shift()
    narrate.error = null
    narrate.lastSkip = null
    mouth('/say?async=1&text=' + encodeURIComponent(r.text), 8000).catch((e) => log('narrate speak failed: ' + String(e && e.message)))
  } catch (e) {
    narrate.error = String(e && e.message)
    log('narrate tick failed: ' + narrate.error)
  }
}

function narrateStart(q) {
  narrate.every = Math.min(Math.max(Number(q.every) || cfg.narrate.every || 8, 2), 120)
  narrate.prompt = q.prompt || cfg.narrate.prompt
  narrate.running = true
  narrate.startedAt = Date.now()
  narrate.lastText = null
  narrate.error = null
  if (narrate.timer) clearTimeout(narrate.timer)
  const tick = async () => {
    if (!narrate.running) return
    const t = Date.now()
    await narrateTick()
    const wait = Math.max(500, narrate.every * 1000 - (Date.now() - t))
    if (narrate.running) narrate.timer = setTimeout(tick, wait)
  }
  narrate.timer = setTimeout(tick, 120)
  return { running: true, every: narrate.every, voice: cfg.mouth?.voice || null, prompt: narrate.prompt }
}

function narrateStop() {
  narrate.running = false
  if (narrate.timer) clearTimeout(narrate.timer)
  narrate.timer = null
  mouth('/stop-utterance', 8000).catch(() => {})
  return { running: false, spoken: narrate.spoken }
}

const server = http.createServer(async (req, res) => {
  const address = req.socket && req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return send(res, 403, { error: 'loopback only' })
  }
  const refusal = browserRefusal(req)
  if (refusal) return send(res, 403, { error: 'forbidden: ' + refusal })
  const url = new URL(req.url, 'http://127.0.0.1')
  const q = Object.fromEntries(url.searchParams.entries())
  try {
    if (url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - state.started,
        frames: worker.frames,
        looks: state.lookCount,
        skipped: state.skipCount,
        model: cfg.provider.model,
        configPath: STATE_DIR + '\\config.json',
        // The mouth is a separate service now; report where it is instead of a
        // voice object this daemon no longer owns.
        mouth: MOUTH_URL,
        narrating: narrate.running,
        narrated: narrate.spoken,
      })
    }
    if (url.pathname === '/windows') {
      return send(res, 200, { windows: await listWindows(0) })
    }
    // The "watch anything" mode needs two things the video path never did: which
    // window is actually in front, and a cheap way to notice that it changed.
    // Both live here so the pusher can poll without paying for a vision call.
    if (url.pathname === '/foreground') {
      return send(res, 200, await foregroundWindow())
    }
    if (url.pathname === '/fgscreen') {
      // Grab the foreground window (or the whole virtual desktop) and hash it.
      // No vision call is made here: the caller decides when a description is
      // worth paying for, based on the hash.
      try {
        const fg = await foregroundWindow()
        const mode = q.mode === 'full' ? 'full' : 'window'
        const target = mode === 'full' ? virtualRect() : (fg.valid ? { x: fg.x, y: fg.y, width: fg.w, height: fg.h } : virtualRect())
        const shot = await captureRect(target, Number(q.width) || 960)
        return send(res, 200, {
          found: true,
          path: shot.path,
          clip: target,
          mode,
          width: shot.width,
          height: shot.height,
          hash: shot.hash,
          window: { process: fg.process, title: fg.title, pid: fg.pid },
          valid: fg.valid,
        })
      } catch (e) {
        return send(res, 200, { found: false, reason: String(e && e.message).slice(0, 200) })
      }
    }
    if (url.pathname === '/look') {
      return send(res, 200, await look(q))
    }
    if (url.pathname === '/watch') {
      return send(res, 200, await watch(q))
    }
    if (url.pathname === '/doctor') {
      const p = await probe(cfg)
      let windows = []
      let workerError = null
      try {
        windows = await listWindows(0)
      } catch (e) {
        workerError = String(e && e.message)
      }
      return send(res, 200, {
        provider: { baseUrl: cfg.provider.baseUrl, model: cfg.provider.model, fallbacks: cfg.provider.fallbackModels, hasKey: !!cfg.provider.apiKey },
        probe: p,
        capture: { defaultWidth: cfg.capture.width, quality: cfg.capture.quality, window: cfg.capture.window, diffThreshold: cfg.capture.diffThreshold },
        worker: { frames: worker.frames, error: workerError },
        virtualScreenWindows: windows.length,
        windows: windows.slice(0, 40),
      })
    }
    if (url.pathname === '/frame.jpg') {
      if (!state.lastFrame) return send(res, 404, { error: 'no frame yet' })
      const buf = Buffer.from(state.lastFrame.data, 'base64')
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length })
      return res.end(buf)
    }
    // Read a local image file. The browser can crop the subtitle band from the
    // page itself, which removes any dependence on screen coordinates that go
    // stale the moment a window moves.
    if (url.pathname === '/read') {
      if (!q.path) throw new Error('need path')
      const b64 = readFileSync(q.path).toString('base64')
      const v = await describe(cfg, b64, q.prompt)
      return send(res, 200, { text: v.text, model: v.model, ms: v.ms, tokens: v.tokens })
    }
    // ---- voice, proxied to the mouth (37716) ----------------------------
    //
    // These four routes are kept so existing callers (the pusher's echo filter,
    // preflight scripts, older avatars) keep working, but the mouth owns every
    // byte of audio. If the mouth is down they say so; they do not make a second
    // speaker appear here, because two speakers is how "her voice came out of
    // nowhere while the avatar stood still" happened.
    if (url.pathname === '/start-utterance') {
      // Cancels whatever is speaking and nothing else. Live2D uses this to make
      // a new line interrupt the previous one instead of queueing behind it.
      try {
        return send(res, 200, await mouth('/stop-utterance', 6000))
      } catch (e) {
        return send(res, 200, { ok: false, reason: String(e && e.message) })
      }
    }
    if (url.pathname === '/say') {
      const text = q.text || ''
      if (!text) return send(res, 400, { spoken: false, error: 'text required' })
      try {
        return send(res, 200, await mouth('/say' + (q.async === '1' ? '?async=1&text=' : '?text=') + encodeURIComponent(text), q.async === '1' ? 15000 : 90000))
      } catch (e) {
        return send(res, 200, { spoken: false, reason: 'mouth down: ' + String(e && e.message), via: 'mouth' })
      }
    }
    // What the mouth has said recently. The ears side needs this to drop its own
    // voice coming back through the system-audio capture, which otherwise gets
    // transcribed as plot dialogue and commented on a second time.
    if (url.pathname === '/said') {
      try {
        return send(res, 200, await mouth('/said', 5000))
      } catch (e) {
        return send(res, 200, { ok: false, recent: [], reason: String(e && e.message) })
      }
    }
    if (url.pathname === '/mouth') {
      // Polled by a Live2D avatar at 10-30 Hz. Answers "is the mouth open, how
      // long until it closes, and what is being said" from the utterance's own
      // timing - no audio analysis needed on the avatar side.
      try {
        return send(res, 200, await mouth('/mouth', 3000))
      } catch (e) {
        return send(res, 200, { speaking: false, text: null, elapsedMs: 0, remainingMs: 0, error: String(e && e.message) })
      }
    }
    // Which playback device speech is pinned to (Voicemeeter routing check).
    if (url.pathname === '/devices') {
      try {
        return send(res, 200, await mouth('/devices', 40000))
      } catch (e) {
        return send(res, 200, { outDevice: -1, devices: [], error: String(e && e.message) })
      }
    }
    if (url.pathname === '/narrate/start') {
      return send(res, 200, narrateStart(q))
    }
    if (url.pathname === '/narrate/stop') {
      return send(res, 200, narrateStop())
    }
    if (url.pathname === '/narrate/status') {
      return send(res, 200, {
        running: narrate.running,
        every: narrate.every,
        spoken: narrate.spoken,
        voice: cfg.mouth?.voice || null,
        error: narrate.error,
        uptimeMs: narrate.running ? Date.now() - narrate.startedAt : 0,
        // Silence is a valid state; saying WHY it is silent is what makes the
        // difference between "nothing moved" and "this is broken".
        ticks: narrate.ticks,
        skippedSame: narrate.skippedSame,
        lastSkip: narrate.lastSkip,
        last: narrate.lines.slice(-12),
      })
    }
    if (url.pathname === '/stop') {
      send(res, 200, { stopping: true })
      setTimeout(() => {
        worker.stop()
        process.exit(0)
      }, 50)
      return
    }
    return send(res, 404, { error: 'no such route: ' + url.pathname })
  } catch (e) {
    log('route ' + url.pathname + ' failed: ' + String(e && e.stack))
    return send(res, 500, { error: String(e && e.message) })
  }
})

server.listen(cfg.port, '127.0.0.1', () => {
  try {
    writeFileSync(PID_PATH, String(process.pid), 'utf8')
  } catch {
    /* pid file is best effort */
  }
  log('daemon listening on 127.0.0.1:' + cfg.port)
  console.log('dsh-watch-eyes daemon on http://127.0.0.1:' + cfg.port)
})

process.on('SIGTERM', () => {
  worker.stop()
  process.exit(0)
})

// Never die silently: an unhandled rejection used to take the whole daemon down
// with no log line, which looked exactly like "the service vanished".
process.on('unhandledRejection', (e) => log('unhandled rejection: ' + String((e && e.stack) || e)))
process.on('uncaughtException', (e) => log('uncaught exception: ' + String((e && e.stack) || e)))

