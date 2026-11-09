// dsh-watch-ears daemon: owns the recorders and the listening loop, answers over
// loopback. Listening runs here rather than in an agent turn so it is
// continuous instead of once per turn.
import http from 'node:http'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { Listener } from './listener.mjs'
import { Recorder } from './recorder.mjs'
import { transcribe, backendReport, getBackend, setBackend } from './asr.mjs'
import { join } from 'node:path'
import { AUDIO_DIR, CONFIG_PATH, ensureStateDir, loadConfig, log } from './shared.mjs'
// CONFIG_PATH still documents the file the running daemon read; it is reported
// in /health so an operator can edit the right JSON without guessing.

const cfg = loadConfig()
ensureStateDir()
const listener = new Listener(cfg)

const state = {
  started: Date.now(),
  oneShots: 0,
  injected: 0,
  // How often the companion is allowed to speak. null means "whatever the pusher
  // was started with", so the panel can stay out of the way when it has no opinion.
  //
  //   pace      'quiet' | 'normal' | 'chatty'   one human-readable dial
  //   regular   seconds between routine digests
  //   salient   minimum seconds between noteworthy beats
  //   coalesce  merge speech that arrives within this many seconds
  tuning: { pace: null, regular: null, salient: null, coalesce: null },
}

// There is no conversation brain here any more.
//
// /converse drove a chat model directly, bypassing the agent turn - which is
// the path docs/FINAL-ARCH.md retired: the brain is the session, its subagent
// is the mouth. converse.mjs, cfg.brain and the /converse/* routes are gone, and
// the recorder hook that fed them is gone with them. Nothing in this daemon now
// talks to a model; it only hears, transcribes and answers queries.

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload, null, 1))
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

async function hearOnce(source, seconds, prompt, cutMs) {
  const rec = new Recorder(source)
  const path = join(AUDIO_DIR, 'oneshot-' + Date.now() + '.wav')
  try {
    const silenceMs = cutMs !== undefined && cutMs !== '' ? Number(cutMs) : (cfg.capture.silenceCutMs || 0)
    const t0 = Date.now()
    const r = await rec.record(seconds, path, { silenceMs, threshold: cfg.capture.speechThreshold })
    const wallMs = Date.now() - t0
    state.oneShots += 1
    if (r.peak < cfg.capture.silencePeak) {
      return { source, seconds, peak: r.peak, silent: true, text: '' }
    }
    const a = await transcribe(cfg, path, { prompt })
    return { source, seconds, peak: Number(r.peak.toFixed(4)), bytes: r.bytes, text: a.text, ms: a.ms, silent: false, wallMs, audioMs: r.ms, speechMs: r.speechMs, silenceCut: r.silenceCut, noiseFloor: Number((r.noiseFloor || 0).toFixed(5)), threshold: Number((r.threshold || 0).toFixed(5)) }
  } finally {
    rec.stop()
    try { const { rmSync } = await import('node:fs'); rmSync(path, { force: true }) } catch { /* best effort */ }
  }
}

// The live observation log, newest last.
//
// Only files that overlap the requested window are read, so a long session does
// not rescan the whole day. A malformed line is skipped rather than failing the
// read: one bad write must not blind the reader until midnight.
function readLive(sinceMs, limit) {
  const dir = join(AUDIO_DIR, '..', 'live')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()
  } catch {
    return []
  }
  const rows = []
  for (const f of files) {
    const dayStart = Date.parse(f.replace('.ndjson', '') + 'T00:00:00Z')
    if (!Number.isFinite(dayStart)) continue
    // Skip any day that cannot contain points in the window.
    if (dayStart + 86400000 < sinceMs) continue
    let text = ''
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let obj = null
      try { obj = JSON.parse(line) } catch { continue }
      if (!obj || !obj.at) continue
      if (Date.parse(obj.at) < sinceMs) continue
      rows.push(obj)
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return rows.slice(-limit)
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
        asrBackend: getBackend(cfg),
    // Why it is on that backend, and whether the other one is even possible.
    // "It works on the author's machine" is answered by this block, not by
    // guessing from a log.
    asr: backendReport(cfg),
        listening: listener.running,
        heard: listener.lines.length,
        transcribed: listener.stats.transcribed,
        skipped: listener.stats.skipped,
        errors: listener.stats.errors,
        // The full counter block, under the name callers already guess. Two shapes
        // for the same numbers is how a health check ends up reporting "0 pending"
        // on a busy daemon: /health flattened them while /listen/status nested
        // them, and a reader that picked the wrong one saw all zeros.
        stats: { ...listener.stats },
        model: cfg.asr.model,
        backend: cfg.asr.backend || 'auto',
        // CONFIG_PATH, not a path derived from DATA_DIR: the settings file lives
        // under the home state dir while recordings live under the workspace, and
        // the old expression pointed at a config.json that never existed there.
        configPath: CONFIG_PATH,
      })
    }
    // Switch the speech backend while the daemon keeps running.
    //
    // Gaming needs the GPU, local Whisper needs the GPU, and the user flips this
    // mid-match - so a config edit plus restart is not a usable interface.
    if (url.pathname === '/asr/backend') {
      if (q.set) {
        const r = setBackend(q.set, cfg)
        log('asr backend: ' + r.previous + ' -> ' + r.backend)
        return send(res, r.ok ? 200 : 400, { ...r, current: getBackend(cfg) })
      }
      return send(res, 200, { current: getBackend(cfg), configured: cfg.asr.backend })
    }
    if (url.pathname === '/devices') {
      const rec = new Recorder('loop')
      try {
        const d = await rec.devices()
        return send(res, 200, d)
      } finally {
        rec.stop()
      }
    }
    if (url.pathname === '/hear') {
      const source = q.source === 'mic' ? 'mic' : 'loop'
      const seconds = Math.min(Math.max(Number(q.seconds) || 6, 1), 25)
      return send(res, 200, await hearOnce(source, seconds, q.prompt, q.cut))
    }
    // The always-awake loop reads this every few seconds. It must stay tiny:
    // a few hundred tokens, only what is new since the caller's last look, so
    // the caller's context does not grow just because it keeps watching.
    // Pull the observation window instead of being pushed every fragment.
    //
    // The parent session cannot receive inbox deliveries (the host rejects a root
    // session as "another parent session"), so it reads this file on its own
    // clock. Returning the same shape as /digest keeps both paths interchangeable.
    if (url.pathname === '/live') {
      const seconds = Math.min(Math.max(Number(q.seconds) || 120, 5), 3600)
      const limit = Math.min(Math.max(Number(q.max) || 200, 1), 2000)
      const sinceMs = Number(q.since) || (Date.now() - seconds * 1000)
      const out = { now: Date.now(), since: sinceMs, mic: [], video: [], brain: [], count: 0 }
      try {
        const rows = readLive(sinceMs, limit)
        for (const r of rows) {
          if (r.source === 'loop') out.video.push(r)
          else if (r.source === 'mic') out.mic.push(r)
          else out.brain.push(r)
        }
        out.count = rows.length
      } catch (e) {
        out.error = String(e && e.message).slice(0, 200)
      }
      return send(res, 200, out)
    }
    if (url.pathname === '/digest') {
      const seconds = Math.min(Math.max(Number(q.seconds) || 30, 5), 600)
      const sinceMs = Number(q.since) || 0
      const max = Math.min(Math.max(Number(q.max) || 8, 1), 30)
      // Long poll. A caller that already knows where it got to can hold the
      // request open and be answered the instant something arrives, instead of
      // sleeping a fixed interval and adding that interval to every reply.
      const waitMs = Math.min(Math.max(Number(q.wait) || 0, 0), 5000)
      let all = listener.recent(seconds)
      if (waitMs > 0 && sinceMs > 0) {
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          if (all.some((l) => Date.parse(l.at) > sinceMs)) break
          await new Promise((r) => setTimeout(r, 120))
          all = listener.recent(seconds)
        }
      }
      const fresh = sinceMs > 0 ? all.filter((l) => Date.parse(l.at) > sinceMs) : all
      // 'at' must be present: the pusher filters by Date.parse(l.at) and a
      // time-only 't' makes that filter reject every single line.
      // Each line carries the loudness measured over its own segment. The
      // subtitle scorer needs it: '爸爸抱抱' whispered and '爸爸抱抱' through
      // tears are different beats, and only the audio can tell them apart.
      const lvl = (peak) => {
        const v = Number(peak) || 0
        if (v >= 0.35) return 2      // shouting, an explosion, a score swelling
        if (v >= 0.15) return 1      // emphatic
        return 0
      }
      const cut = (l) => ({
        t: String(l.at).slice(11, 19),
        at: l.at,
        text: String(l.text).slice(0, 90),
        loud: lvl(l.peak),
        peak: l.peak === undefined ? null : Number(l.peak),
      })
      const newest = all.length > 0 ? Date.parse(all[all.length - 1].at) : 0
      return send(res, 200, {
        now: Date.now(),
        windowSec: seconds,
        listening: listener.running,
        video: fresh.filter((l) => l.source === 'loop').slice(-max).map(cut),
        mic: fresh.filter((l) => l.source === 'mic').slice(-max).map(cut),
        videoTotal: all.filter((l) => l.source === 'loop').length,
        micTotal: all.filter((l) => l.source === 'mic').length,
        silenceSec: newest > 0 ? Math.round((Date.now() - newest) / 1000) : null,
        stats: listener.stats,
        waited: Date.now(),
        // Live speaking-frequency settings. The pusher polls this every tick, so
        // carrying them here means a change takes effect within ~2 seconds and
        // costs no extra request.
        tuning: state.tuning,
      })
    }
    // ---- danmaku (live chat) -------------------------------------------
    //
    // Read from the PAGE, not from OCR or an official API:
    //
    //   OCR of the chat panel  - measured 897ms and returned pure garbage on a dense
    //                            screen; Windows OCR is built for clean glyphs, not
    //                            for a scrolling wall of avatars and medals.
    //   open-platform API      - needs app credentials and a websocket subscription,
    //                            and it is per-site.
    //   the page's own DOM     - the live room already renders every message as a
    //                            node; one querySelectorAll returns them all, exact,
    //                            in ~9ms, with no login for public rooms.
    //
    // So the ears ask the browser plugin what the chat panel currently says.
    if (url.pathname === '/danmaku') {
      const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100)
      if (!q.url) return send(res, 400, { error: 'need url (the live room page to read)' })
      const js = "(function(){var els=Array.prototype.slice.call(document.querySelectorAll('#chat-items .danmaku-item'));" +
        "return els.slice(-" + limit + ").map(function(e){" +
        "var u=e.querySelector('.danmaku-item-left .user-name');" +
        "var c=e.querySelector('.danmaku-item-right');" +
        "return {user: u?u.textContent.replace(/:$/,'').trim():'', text: c?c.textContent.trim():''}})})()"
      const r = await fetch('http://127.0.0.1:37713/do?action=eval&text=' + encodeURIComponent(js), { signal: AbortSignal.timeout(15000) })
      const body = await r.json().catch(() => ({}))
      const raw = Array.isArray(body.value) ? body.value : []
      const lines = raw
        .map((x) => ({ user: String(x.user || '').replace(/\s*:$/, '').trim(), text: String(x.text || '').trim() }))
        .filter((x) => x.text && x.text.length >= 1)
      // A live room repeats the same message while it is on screen; keep only lines
      // that were not in the previous poll, or the reader would "reply" to the same
      // comment every tick.
      // reset=1 forgets what was already returned. Needed after a pusher restart:
      // the daemon outlives the pusher, so a fresh pusher would otherwise inherit a
      // seen-set that already contains everything on screen and sit silent.
      if (q.reset === '1') { state.danmakuSeen = new Set(); state.danmakuLast = [] }
      const seen = state.danmakuSeen || new Set()
      const fresh = lines.filter((x) => !seen.has(x.user + '\u0000' + x.text))
      state.danmakuSeen = new Set(lines.map((x) => x.user + '\u0000' + x.text))
      state.danmakuLast = lines
      return send(res, 200, { ok: true, url: q.url, total: lines.length, fresh, lines })
    }
    // Self-test seam: run a WAV file through the SAME transcribe path the
    // listener uses, without a microphone. This exists because "listening=true,
    // transcribed=0" cannot be told apart from a dead ASR by looking at counters,
    // and a quiet room produces exactly that. Passing a file proves the chain.
    if (url.pathname === '/transcribe') {
      if (!q.path) throw new Error('need path')
      const a = await transcribe(cfg, q.path, q.prompt ? { prompt: q.prompt } : {})
      return send(res, 200, { ok: !a.error, text: a.text, ms: a.ms, backend: getBackend(cfg), used: a.cloud || (a.local ? 'local' : 'cloud'), local: !!a.local })
    }
    if (url.pathname === '/heard') {
      const lines = listener.recent(q.seconds)
      return send(res, 200, { count: lines.length, lines })
    }
    // Test seam: pretend the microphone heard something, so a pusher's digest
    // path can be exercised end to end without a human in the room.
    if (url.pathname === '/inject') {
      state.injected += 1
      const line = { at: new Date().toISOString(), source: q.source === 'loop' ? 'loop' : 'mic', text: String(q.text || ''), peak: 0.5, ms: 0, injected: true }
      listener.push(line)
      return send(res, 200, { injected: line })
    }
    // Live speaking frequency.
    //
    // 「说话频率」is really three dials: how often a routine digest goes out, how
    // close together two noteworthy beats may be, and how much speech gets coalesced
    // into one line. Humans think about it as one dial, so pace maps to all three.
    if (url.pathname === '/tuning') {
      if (q.pace) {
        const P = {
          // quiet: speak rarely, let the scene breathe
          quiet: { regular: 120, salient: 60, coalesce: 18 },
          // normal: talk during the interesting parts
          normal: { regular: 45, salient: 25, coalesce: 12 },
          // chatty: react to almost everything
          chatty: { regular: 20, salient: 12, coalesce: 6 },
        }
        const preset = P[q.pace]
        if (!preset) return send(res, 400, { ok: false, error: 'pace must be quiet|normal|chatty' })
        state.tuning.pace = q.pace
        state.tuning.regular = preset.regular
        state.tuning.salient = preset.salient
        state.tuning.coalesce = preset.coalesce
        log('tuning: pace=' + q.pace + ' regular=' + preset.regular + 's salient=' + preset.salient + 's')
        return send(res, 200, { ok: true, tuning: state.tuning })
      }
      // Fine control: any subset of the raw seconds.
      if (q.regular) state.tuning.regular = Math.min(Math.max(Number(q.regular), 10), 600)
      if (q.salient) state.tuning.salient = Math.min(Math.max(Number(q.salient), 8), 300)
      if (q.coalesce) state.tuning.coalesce = Math.min(Math.max(Number(q.coalesce), 3), 60)
      if (q.regular || q.salient || q.coalesce) {
        state.tuning.pace = 'custom'
        log('tuning: custom ' + JSON.stringify(state.tuning))
        return send(res, 200, { ok: true, tuning: state.tuning })
      }
      return send(res, 200, { ok: true, tuning: state.tuning })
    }
    if (url.pathname === '/listen/start') {
      return send(res, 200, listener.start(q))
    }
    if (url.pathname === '/listen/stop') {
      return send(res, 200, listener.stop())
    }
    if (url.pathname === '/listen/status') {
      return send(res, 200, listener.status())
    }
    if (url.pathname === '/stop') {
      send(res, 200, { stopping: true })
      setTimeout(() => {
        listener.stop()
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
  try { writeFileSync(join(AUDIO_DIR, '..', 'daemon.pid'), String(process.pid), 'utf8') } catch { /* best effort */ }
  log('ears daemon listening on 127.0.0.1:' + cfg.port)
  console.log('dsh-watch-ears daemon on http://127.0.0.1:' + cfg.port)
})

process.on('SIGTERM', () => {
  listener.stop()
  process.exit(0)
})

// Never die silently: an unhandled rejection used to take the whole daemon down
// with no log line, which looked exactly like "the service vanished".
process.on('unhandledRejection', (e) => log('unhandled rejection: ' + String((e && e.stack) || e)))
process.on('uncaughtException', (e) => log('uncaught exception: ' + String((e && e.stack) || e)))

