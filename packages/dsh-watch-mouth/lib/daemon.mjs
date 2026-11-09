// dsh-watch-mouth daemon: synthesis + playback, and the mouth clock the avatar polls.
//
// Why this is its own service (docs/FINAL-ARCH.md §六): the eyes daemon used to
// carry the whole TTS stack while only ever speaking when it narrated. That made
// two unrelated failure modes share one process - a capture worker restart took
// the voice down with it, and a stuck synthesis blocked screen_look. One owner
// per capability also means exactly one place holds the audio device.
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { Speaker } from './tts.mjs'
import { DEFAULT_PORT, PID_PATH, loadConfig, log } from './shared.mjs'

const cfg = loadConfig()
const port = Number(process.env.DSH_MOUTH_PORT || cfg.port || DEFAULT_PORT)

const speaker = new Speaker(cfg.voice, cfg.prosody, { tts: cfg.tts, zhipu: {}, output: cfg.output })

// Every caller is supposed to hand over ONE short spoken line (the tool
// descriptions say 40 characters). Nothing enforced it, and a 400 character
// reply would hold the speaker for 20+ seconds: while it plays, the avatar
// cannot answer anything else, and every newer line supersedes it anyway.
//
// So the mouth enforces the contract it documents. Truncation happens at a
// sentence boundary when there is one inside the budget - cutting mid-phrase
// is worse than slightly over.
const MAX_SAY_CHARS = 120

function spokenForm(raw) {
  const text = String(raw || '').trim()
  if (text.length <= MAX_SAY_CHARS) return { text, truncated: false }
  // Prefer whole sentences. When even the FIRST sentence blows the budget, fall
  // back to clause boundaries, then to a hard slice - so a long unpunctuated
  // reply degrades in a readable way instead of stopping mid-word.
  const collect = (re) => {
    const parts = text.split(re).map((s) => s.trim()).filter(Boolean)
    let keep = ''
    for (const part of parts) {
      if ((keep + part).length > MAX_SAY_CHARS) break
      keep += part
    }
    return keep
  }
  let cut = collect(/(?<=[。！？.!?])/) || collect(/(?<=[，,、；;：:])/) || text.slice(0, MAX_SAY_CHARS)
  cut = cut.slice(0, MAX_SAY_CHARS).replace(/[，,、；;：:]$/, '').trim()
  return { text: cut, truncated: true, originalChars: text.length }
}

const state = {
  started: Date.now(),
  // What has been spoken lately. The ears side reads this to drop its own voice
  // coming back through the system-audio capture, which otherwise gets
  // transcribed as plot dialogue and commented on a second time.
  recent: [],
  errors: [],
}

function remember(text) {
  state.recent.push({ at: Date.now(), text: String(text).slice(0, 120) })
  while (state.recent.length > 30) state.recent.shift()
}

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

// Speaking is a queue with a replace policy, not a stack of overlapping lines.
//
// Two lines landing together used to interleave inside the worker (the second
// PCMOPEN stops the first mid-word). Queueing fixed that but made the avatar
// LAG: every new line waited for the previous one, so a chatty exchange fell
// further and further behind the moment it was answering.
//
// The rule that matches conversation: a NEW line supersedes anything still
// waiting, and interrupts what is playing now. Nobody wants the reply to a
// question that has already been replaced.
let chain = Promise.resolve()
const queue = { ticket: 0, interrupted: 0, replaced: 0 }

function enqueue(text, opts = {}) {
  if (opts.replace === false) {
    // append: this piece continues the audio already playing, so it must NOT open
    // a new PCM stream (opening one stops what is playing). The flag is consumed
    // by the next speaker.say().
    if (opts.append) speaker.appendNext = true
    const run = chain.then(() => speakNow(text))
    chain = run.then(() => undefined, () => undefined)
    return run
  }
  // Supersede: bump the ticket so any line still waiting declines to start, and
  // cut the CURRENT audio immediately - not after the previous synthesis ends.
  //
  // Stopping inside the chain was too late: speaker.say() returns when the last
  // frame is queued, which for a long line is over a second in, so the old line
  // kept talking and the new one only began after it. Cutting here is the whole
  // point of "a new line interrupts the previous one".
  const ticket = ++queue.ticket
  queue.replaced += 1
  // cut() invalidates the in-flight line SYNCHRONOUSLY and silences the worker
  // without waiting. Awaiting it here would put the new line behind a 4 second
  // stop timeout on a slow worker, which is worse than a brief overlap.
  try { speaker.cut() } catch { /* already quiet */ }
  const run = chain.then(async () => {
    if (ticket !== queue.ticket) return { spoken: false, reason: 'superseded', text }
    return await speakNow(text)
  })
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function speakNow(text) {
  remember(text)
  try {
    const out = await speaker.say(text)
    if (out && out.spoken === false) state.errors.push({ at: Date.now(), text: String(out.reason || 'not spoken').slice(0, 160) })
    return out
  } catch (e) {
    state.errors.push({ at: Date.now(), text: String(e && e.message).slice(0, 160) })
    log('say failed: ' + String(e && e.message))
    return { spoken: false, reason: String(e && e.message) }
  }
}

// Explicit "shut up": used by the avatar when a new line starts and by
// narration when it is stopped. Bumping the ticket is the only way to cancel a
// line that is already queued.
async function interrupt() {
  queue.ticket += 1
  queue.interrupted += 1
  try { await speaker.stop() } catch { /* already quiet */ }
  return { ok: true, interrupted: true, spoken: speaker.spoken, interruptedTotal: queue.interrupted, speaking: speaker.state().speaking }
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
        port,
        voice: speaker.voice,
        provider: cfg.tts.provider,
        model: cfg.tts.minimax?.model || cfg.tts.model,
        spoken: speaker.spoken,
        speaking: speaker.state().speaking,
        queue: { interrupted: queue.interrupted, replaced: queue.replaced },
        outputDevice: cfg.output.deviceName || 'system default',
        lastError: state.errors.length ? state.errors[state.errors.length - 1] : null,
        recent: state.recent.slice(-3),
      })
    }
    if (url.pathname === '/say') {
      const raw = String(q.text || '').trim()
      if (!raw) return send(res, 400, { spoken: false, error: 'text required' })
      const { text, truncated, originalChars } = spokenForm(raw)
      // queue=0 keeps the line in order behind the current one instead of
      // superseding it. Everyone else replaces: a live reply must not wait
      // behind a line nobody is listening to any more.
      // continue=1: this line is part of the SAME utterance as the one already
      // queued or playing. The caller is streaming a reply in pieces, so the
      // pieces must join up instead of cutting each other off.
      const cont = q.continue === '1'
      const opts = { replace: q.queue !== '1' }
      if (cont) speaker.appendNext = true
      const meta = truncated ? { truncated: true, originalChars } : {}
      // async=1 answers as soon as the line is queued. The avatar must not block
      // on synthesis: measured 300-800ms on the PCM path and 15s+ on a fallback.
      if (q.async === '1') {
        enqueue(text, opts)
        return send(res, 200, { accepted: true, text, async: true, voice: speaker.voice, ...meta })
      }
      const out = await enqueue(text, opts)
      return send(res, 200, { ...out, ...meta })
    }
    // Speak several fragments as ONE utterance.
    //
    // The mouth takes one line per /say, so a caller that is still generating text
    // has two bad options: wait for the end (0.5-2s of silence before the first
    // sound) or send pieces that cut each other off (only the last one is heard).
    // This is the third option: the pieces are concatenated in the worker's single
    // PCM stream, so the first fragment sounds ~200ms in and the sentence is still
    // one continuous line.
    //
    //   POST /say-stream   { chunks: ["这集其实挺无聊的，", "但我想看完。"] }
    //
    // POST rather than GET because the body carries a list and can be long; a
    // querystring would hit URL limits right where it matters (a long reply).
    if (url.pathname === '/say-stream') {
      let chunks = []
      try {
        const raw = await new Promise((resolve, reject) => {
          let body = ''
          req.on('data', (d) => { body += d; if (body.length > 1e6) reject(new Error('body too large')) })
          req.on('end', () => resolve(body))
          req.on('error', reject)
        })
        chunks = JSON.parse(raw || '{}').chunks || []
      } catch (e) {
        return send(res, 400, { spoken: false, error: 'bad body: ' + String(e && e.message).slice(0, 120) })
      }
      if (!Array.isArray(chunks) || chunks.length === 0) return send(res, 400, { spoken: false, error: 'chunks must be a non-empty array' })
      const t0 = Date.now()
      const spoken = []
      for (const raw of chunks) {
        const { text } = spokenForm(raw)
        if (!text) continue
        const out = await enqueue(text, { replace: false, append: spoken.length > 0 })
        spoken.push({ text, spoken: !!(out && out.spoken), durationMs: out && out.durationMs })
      }
      return send(res, 200, {
        spoken: spoken.length > 0,
        chunks: spoken,
        count: spoken.length,
        wallMs: Date.now() - t0,
      })
    }
    // Cancel whatever is queued or playing. The avatar calls this before its own
    // line (a new sentence should not wait for the old one to finish), and
    // narration calls it on stop.
    if (url.pathname === '/stop' && req.method === 'GET' && q.utterance === '1') {
      return send(res, 200, await interrupt())
    }
    if (url.pathname === '/stop-utterance') {
      return send(res, 200, await interrupt())
    }
    if (url.pathname === '/said') {
      return send(res, 200, { ok: true, recent: state.recent.slice(-12) })
    }
    // Polled by the avatar at 10-30 Hz. Answers "is the mouth open, how long
    // until it closes, and what is being said" from the utterance's own timing -
    // no audio analysis needed on the avatar side.
    if (url.pathname === '/mouth') {
      return send(res, 200, speaker.state())
    }
    if (url.pathname === '/devices') {
      return send(res, 200, await speaker.devices())
    }
    if (url.pathname === '/stop') {
      send(res, 200, { stopping: true })
      // Stop the sound before leaving: a killed worker leaves the MediaPlayer
      // holding the device, and the next start then speaks into a dead session.
      speaker.stop().catch(() => {})
      setTimeout(() => process.exit(0), 120)
      return
    }
    return send(res, 404, { error: 'no such route: ' + url.pathname })
  } catch (e) {
    log('route ' + url.pathname + ' failed: ' + String(e && e.stack))
    return send(res, 500, { spoken: false, error: String(e && e.message) })
  }
})

server.listen(port, '127.0.0.1', () => {
  try {
    writeFileSync(PID_PATH, String(process.pid), 'utf8')
  } catch {
    /* pid file is best effort */
  }
  log('mouth daemon listening on 127.0.0.1:' + port)
  console.log('dsh-watch-mouth daemon on http://127.0.0.1:' + port)
})

// Warm the playback worker and resolve the output device before the first line,
// so the first thing the user hears is not 15 seconds late.
speaker.ready().catch((e) => log('speaker warm-up failed: ' + String(e && e.message)))

process.on('SIGTERM', () => {
  speaker.stop().catch(() => {})
  process.exit(0)
})

// Never die silently: an unhandled rejection used to take the whole daemon down
// with no log line, which looked exactly like "the voice vanished".
process.on('unhandledRejection', (e) => log('unhandled rejection: ' + String((e && e.stack) || e)))
process.on('uncaughtException', (e) => log('uncaught exception: ' + String((e && e.stack) || e)))
