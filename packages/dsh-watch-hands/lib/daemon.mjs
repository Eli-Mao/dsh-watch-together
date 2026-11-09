// dsh-watch-hands daemon: the OS input layer behind one loopback port.
//
// It exposes what a person does at a keyboard and mouse, in the vocabulary of
// INTENT rather than coordinates:
//
//   apps / windows        what is on screen, by title and process
//   focus / window        bring it forward, minimise, move it
//   find                  what controls exist inside it, by name
//   read                  what it is currently showing
//   click                 click a thing by its accessible NAME
//   type / key            type text (unicode-safe), send a chord
//   run                   launch a program
//
// Deliberately NOT in the vocabulary: raw pixel coordinates as the primary way
// in. A person does not remember that the save button is at 812,463; they read
// the button. Coordinates are accepted (clickAt) as an escape hatch, but the
// default path is the accessibility tree, which survives window moves, DPI
// changes and scroll.
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HandsWorker } from './worker.mjs'
import crypto from 'node:crypto'
import { DATA_DIR, DEFAULT_PORT, LOG_PATH, PID_PATH, loadConfig, saveConfig, log } from './shared.mjs'

const cfg = loadConfig()
const port = Number(process.env.DSH_HANDS_PORT || cfg.port || DEFAULT_PORT)
const hands = new HandsWorker()

const state = {
  started: Date.now(),
  actions: 0,
  // Every action is recorded with what it touched. This is the difference
  // between "a tool that can click anything" and "a tool you can audit": when
  // something goes wrong, the question is always "what did it touch".
  history: [],
  errors: [],
}

function remember(entry) {
  state.actions += 1
  state.history.push(entry)
  while (state.history.length > 120) state.history.shift()
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

const enc = (s) => Buffer.from(String(s), 'utf8').toString('base64')

// Is this window one the hands must never drive?
//
// Checking here, in the daemon, rather than in the worker: the guard is policy,
// and policy that lives inside the thing it constrains is policy that gets
// bypassed the moment a caller talks to the worker directly.
function guarded(win) {
  const g = cfg.guard || {}
  const hay = String((win && win.process) || '') + ' ' + String((win && win.title) || '')
  const low = hay.toLowerCase()
  for (const p of g.denyProcesses || []) if (low.includes(String(p).toLowerCase())) return 'process matches denied entry "' + p + '"'
  for (const d of g.deny || []) {
    const needle = String(d).toLowerCase()
    if (low.includes(needle)) return 'window matches denied entry "' + d + '"'
  }
  return null
}

// Read the window the caller means: an explicit hwnd always wins, then a hint
// (process or title substring), then whatever has focus. Same resolution order a
// person uses: "that window" -> "the one called X" -> "the one I am in".
async function resolveWindow(hwnd, hint, forWrite) {
  const win = await resolveWindowRaw(hwnd, hint)
  // Reading a window is harmless; WRITING to one is not. The guard applies to
  // focus/window/click/type/key/run, not to apps/find/read - a caller is allowed
  // to look at what it may not touch, and refusing the read would only make the
  // reason harder to discover.
  if (forWrite) {
    const why = guarded(win)
    if (why) throw new Error('refused: ' + why + ' (config guard.deny)')
  }
  return win
}

async function resolveWindowRaw(hwnd, hint) {
  if (hwnd) {
    const apps = await hands.send('APPS')
    const hit = (apps || []).find((a) => String(a.hwnd) === String(hwnd))
    return hit || { hwnd: Number(hwnd), title: '(unknown)' }
  }
  if (hint) {
    // The hint rides in base64 for the same reason every other name does:
    // PowerShell reads stdin as the ANSI codepage, so a Chinese window title sent
    // raw arrives as mojibake and matches nothing.
    const apps = await hands.send('WINDOWS|' + enc(hint))
    const list = Array.isArray(apps) ? apps : []
    if (!list.length) {
      const all = await hands.send('WINDOWS|')
      const names = (Array.isArray(all) ? all : []).slice(0, 12).map((a) => a.process + ' — ' + String(a.title).slice(0, 30))
      throw new Error('no window matching "' + hint + '". Open windows: ' + names.join(' | '))
    }
    return list[0]
  }
  const apps = await hands.send('APPS')
  const fg = (apps || []).find((a) => a.fg)
  if (!fg) throw new Error('no foreground window')
  return fg
}

// ------------------------------------------------------------------ external API
//
// Two surfaces, deliberately:
//   /apps, /click, ...        internal. Same-machine plugins, no ceremony.
//   /api/v1/*                 the contract other PROGRAMS are written against.
//
// The second one exists because a client needs three things the internal routes do
// not provide: a version it can refuse, a token it can hold, and a description it
// can read without opening our source. Changing the internal shape is then a
// refactor; changing v1 is a breaking change someone else has to agree to.
const API_BASE = (cfg.api && cfg.api.base) || '/api/v1'
const API_VERSION = '1'

// A token generated once and stored. Empty config means "make one now", because a
// shared secret nobody can read is worse than none: it gets pasted into configs.
function ensureToken() {
  if (cfg.api && cfg.api.token) return cfg.api.token
  const t = crypto.randomBytes(24).toString('hex')
  cfg.api = { ...(cfg.api || {}), token: t }
  try { saveConfig(cfg) } catch { /* read-only config: the token still works for this run */ }
  log('generated an API token (stored in config.json api.token)')
  return t
}

const isLoopback = (address) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

// The endpoint list, published so a client can discover the surface instead of
// being written against a README that drifts.
function apiDescriptor() {
  const E = (name, params, summary) => ({ name, params, summary })
  return {
    version: API_VERSION,
    base: API_BASE,
    // One sentence a client can show a user.
    about: 'Drive a Windows desktop the way a person does: find controls by their visible label, click them, type into them, read what a window shows.',
    // Coordinate contract: every coordinate in and out is PHYSICAL screen pixels.
    coordinates: 'physical screen pixels (virtual desktop origin included). /shot returns the map from image pixels to these.',
    auth: 'Send X-DSH-Hands-Token on non-loopback requests; loopback clients may omit it.',
    endpoints: [
      E('health', '—', 'daemon + worker state, action count, last error'),
      E('displays', '—', 'monitors and virtual desktop bounds'),
      E('apps', '—', 'top-level windows'),
      E('find', 'hint,name,limit,withText', 'controls inside a window, matched by accessible name'),
      E('read', 'hint,max', 'the text a window is showing'),
      E('shot', 'hint,width', 'screenshot + the image→screen coordinate map'),
      E('focus', 'hint,hwnd', 'bring a window forward'),
      E('window', 'op,hint,hwnd,rect', 'minimise/maximise/restore/close/move'),
      E('click', 'name,hint,hwnd', 'click a control by its visible name'),
      E('clickat', 'x,y,hint', 'click coordinates (refused when something covers the point)'),
      E('type', 'text,hint', 'type unicode text'),
      E('key', 'combo,hint', 'send a key chord'),
      E('wait', 'name,hint,timeout,gone', 'wait for a control to appear/disappear'),
      E('batch', 'actions,finish,hint', 'several steps in one call'),
      E('run', 'target', 'launch a program'),
      E('history', '—', 'what was recently done'),
    ],
    errorShape: { error: 'string', refused: 'boolean (policy blocks, not failures)' },
    statusCodes: { 200: 'ok', 403: 'refused by policy', 409: 'a control is covered by another window', 500: 'the action failed' },
  }
}

const server = http.createServer(async (req, res) => {
  const address = req.socket && req.socket.remoteAddress
  if (!isLoopback(address)) {
    // Not loopback: outside this machine's own tooling, so the token is mandatory.
    const want = ensureToken()
    const got = String(req.headers['x-dsh-watch-hands-token'] || '')
    if (got !== want) return send(res, 403, { error: 'token required (X-DSH-Hands-Token)', refused: true })
  } else if (cfg.api && cfg.api.requireTokenForLoopback) {
    const want = ensureToken()
    const got = String(req.headers['x-dsh-watch-hands-token'] || '')
    if (got !== want) return send(res, 403, { error: 'token required (config api.requireTokenForLoopback)', refused: true })
    // Deliberately no hint about whether the token was empty or wrong: a client
    // that gets "wrong token" learns a token exists, which is enough to keep
    // trying. One message for every rejection.
  } else {
    // Loopback without the token still has to look like a program on this
    // machine, not a web page (see browserRefusal). A caller that presents the
    // token passes on that alone: a page has no way to read it. Compare with the
    // token that already exists, never ensureToken(): a refused request must not
    // be able to mint one, write config.json or add a log line.
    const refusal = browserRefusal(req)
    const have = (cfg.api && cfg.api.token) || ''
    if (refusal && (!have || String(req.headers['x-dsh-watch-hands-token'] || '') !== have)) {
      return send(res, 403, { error: 'forbidden: ' + refusal, refused: true })
    }
  }

  // The versioned surface is the same handlers. Stripping the prefix here rather
  // than duplicating every route is what keeps v1 honest: there is one behaviour,
  // and the prefix is a promise about it, not a second implementation.
  let pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
  if (pathname.startsWith(API_BASE + '/')) pathname = pathname.slice(API_BASE.length)
  if (pathname === API_BASE || pathname === API_BASE + '/') pathname = '/descriptor'
  const url = new URL(req.url, 'http://127.0.0.1')
  url.pathname = pathname
  const q = Object.fromEntries(url.searchParams.entries())
  if (pathname === '/descriptor') return send(res, 200, apiDescriptor())
  try {
    if (url.pathname === '/health') {
      return send(res, 200, {
        ok: !!hands.child,
        pid: process.pid,
        uptimeMs: Date.now() - state.started,
        port,
        actions: state.actions,
        workerUptimeMs: hands.startedAt ? Date.now() - hands.startedAt : 0,
        queued: hands.queued,
        lastError: state.errors.length ? state.errors[state.errors.length - 1] : null,
        logPath: LOG_PATH,
      })
    }
    if (url.pathname === '/displays') {
      return send(res, 200, await hands.send('DISPLAYS'))
    }
    if (url.pathname === '/apps') {
      const apps = await hands.send('APPS')
      return send(res, 200, { apps: apps || [] })
    }
    if (url.pathname === '/windows') {
      const apps = await hands.send('WINDOWS|' + (q.hint || ''))
      return send(res, 200, { windows: apps || [] })
    }
    if (url.pathname === '/focus') {
      const win = await resolveWindow(q.hwnd, q.hint, true)
      const r = await hands.send('FOCUS|' + win.hwnd)
      remember({ at: Date.now(), action: 'focus', window: win.title, ok: !!r.focused })
      if (!r.focused) log('focus refused for ' + win.title + ': ' + String(r.reason || '').slice(0, 160))
      return send(res, 200, { ...r, window: win })
    }
    if (url.pathname === '/window') {
      const win = await resolveWindow(q.hwnd, q.hint, true)
      const op = String(q.op || 'restore')
      const extra = q.rect ? '|' + q.rect : ''
      const r = await hands.send('WINDOW|' + win.hwnd + '|' + op + extra)
      remember({ at: Date.now(), action: 'window:' + op, window: win.title })
      return send(res, 200, { ...r, window: win })
    }
    if (url.pathname === '/find') {
      const win = await resolveWindow(q.hwnd, q.hint)
      // Names go over the pipe in base64: PowerShell reads stdin as the ANSI
      // codepage, so a CJK label written raw arrives as mojibake.
      const r = await hands.send('FIND|' + enc(win.title) + '|' + (q.name ? enc(q.name) : '') + '|' + (q.limit || 120) + '|' + (q.withText === '1' ? '1' : '0'))
      return send(res, 200, { elements: r || [], window: win })
    }
    if (url.pathname === '/read') {
      const win = await resolveWindow(q.hwnd, q.hint)
      const r = await hands.send('READ|' + enc(win.title) + '|' + (q.max || 4000), 45000)
      remember({ at: Date.now(), action: 'read', window: win.title })
      return send(res, 200, { ...r, window: win })
    }
    if (url.pathname === '/menu') {
      const win = await resolveWindow(q.hwnd, q.hint)
      const r = await hands.send('MENU|' + enc(win.title))
      return send(res, 200, { items: r || [] })
    }
    if (url.pathname === '/click') {
      if (!q.name) return send(res, 400, { error: 'click needs name (the accessible label of the control)' })
      const win = await resolveWindow(q.hwnd, q.hint, true)
      const r = await hands.send('CLICK|' + enc(win.title) + '|' + enc(q.name))
      remember({ at: Date.now(), action: 'click:' + r.clicked, window: win.title })
      return send(res, 200, { ...r, window: win })
    }
    if (url.pathname === '/clickat') {
      const x = Number(q.x)
      const y = Number(q.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return send(res, 400, { error: 'clickat needs x and y' })
      const r = await hands.send('CLICKAT|' + x + '|' + y)
      // The point may be covered. If the window that would receive the click is not
      // the one the caller meant, that click goes to the wrong place: refuse it and
      // say what is in the way, instead of typing into, or clicking on, an overlay.
      let blocked = null
      if (q.hint || q.hwnd) {
        const want = await resolveWindow(q.hwnd, q.hint, true)
        if (r.hitHwnd && String(r.hitHwnd) !== String(want.hwnd)) {
          blocked = {
            wanted: want.title,
            actually: r.hitTitle || '(unknown window)',
            hint: 'something is covering that point (an always-on-top window). Move or hide it, or target a control by name instead of coordinates.',
          }
        }
      }
      remember({ at: Date.now(), action: 'clickAt:' + x + ',' + y, blocked: !!blocked })
      if (blocked) return send(res, 409, { ...r, blocked, error: 'covered: clicking here would hit "' + blocked.actually + '", not "' + String(blocked.wanted).slice(0, 40) + '"' })
      return send(res, 200, r)
    }
    if (url.pathname === '/type') {
      const text = String(q.text || '')
      if (!text) return send(res, 400, { error: 'type needs text' })
      // An explicit window is focused first: typing into "whatever had focus"
      // is how text ends up in the wrong application.
      if (q.hwnd || q.hint) {
        const win = await resolveWindow(q.hwnd, q.hint, true)
        await hands.send('FOCUS|' + win.hwnd)
        await new Promise((r2) => setTimeout(r2, cfg.settleMs))
      }
      const r = await hands.send('TYPE|' + enc(text) + '|' + (q.delay ?? cfg.typeDelayMs), Math.max(30000, text.length * 120))
      remember({ at: Date.now(), action: 'type:' + text.slice(0, 24), chars: text.length, window: q.hint })
      return send(res, 200, r)
    }
    if (url.pathname === '/key') {
      const combo = String(q.combo || '').trim()
      if (!combo) return send(res, 400, { error: 'key needs a combo, e.g. ctrl+s or enter' })
      if (!cfg.allow.destructiveKeys && /alt\+f4|ctrl\+w|win/i.test(combo)) {
        return send(res, 403, { error: 'destructive keys disabled by config (allow.destructiveKeys)' })
      }
      if (q.hwnd || q.hint) {
        const win = await resolveWindow(q.hwnd, q.hint, true)
        await hands.send('FOCUS|' + win.hwnd)
        await new Promise((r2) => setTimeout(r2, cfg.settleMs))
      }
      const r = await hands.send('KEY|' + combo)
      remember({ at: Date.now(), action: 'key:' + combo, window: q.hint })
      return send(res, 200, r)
    }
    if (url.pathname === '/run') {
      if (!cfg.allow.run) return send(res, 403, { error: 'launching disabled by config (allow.run)' })
      const target = String(q.target || '').trim()
      if (!target) return send(res, 400, { error: 'run needs target (a program path or command)' })
      const r = await hands.send('RUN|' + enc(target))
      remember({ at: Date.now(), action: 'run:' + target.slice(0, 40) })
      return send(res, 200, r)
    }
    if (url.pathname === '/shot') {
      // One screenshot, and the mapping between its pixels and screen pixels.
      //
      // Without the mapping the model has to do scale arithmetic, and it will get
      // it wrong exactly when it matters (a 150% display, a window on a second
      // monitor). Reporting physical.x/y/w/h beside the image makes "convert this
      // image pixel to a screen pixel" a pure linear map the caller can do.
      const hint = q.hint ? String(q.hint) : ''
      const file = join(DATA_DIR, 'shot-' + Date.now() + '.jpg')
      const r2 = await hands.send('SHOT|' + (hint ? enc(hint) : '') + '|' + enc(file) + '|' + Number(q.width || 1366), 45000)
      remember({ at: Date.now(), action: 'shot', window: r2.window || '(screen)' })
      return send(res, 200, {
        path: r2.path,
        width: r2.width,
        height: r2.height,
        physical: r2.physical,
        scale: r2.scale,
        window: r2.window || null,
        // The formula, spelled out, because a caller reading a coordinate off the
        // image needs it and should not have to derive it.
        toScreen: 'screenX = physical.x + round(imageX * physical.w / width)',
      })
    }
    // Wait for a control (or a window) instead of sleeping a guess.
    if (url.pathname === '/wait') {
      const win = await resolveWindow(q.hwnd, q.hint)
      const mode = q.gone === '1' ? 'gone' : 'appear'
      const r = await hands.send('WAITFIND|' + enc(win.title) + '|' + enc(q.name || '') + '|' + (q.timeout || 3000) + '|' + mode, Math.max(15000, Number(q.timeout || 3000) + 10000))
      remember({ at: Date.now(), action: 'wait:' + mode + ':' + (q.name || ''), window: win.title, ok: !!r.found })
      return send(res, 200, { ...r, mode, target: q.name || null })
    }
    if (url.pathname === '/batch') {
      // Several steps in ONE round trip.
      //
      // This is the biggest latency win available here, and it is not about any
      // single action being slow: it is that each step otherwise costs a full
      // model turn (decide -> call -> look -> decide). A three step sequence
      // ("click the box -> type -> press enter") is ~3 turns; batched it is one.
      //
      // Actions run in order and stop at the first failure, because continuing
      // after a miss is how a click lands somewhere nobody intended.
      let steps = []
      try {
        steps = JSON.parse(String(q.actions || '[]'))
      } catch {
        return send(res, 400, { error: 'actions must be a JSON array' })
      }
      if (!Array.isArray(steps) || steps.length === 0) return send(res, 400, { error: 'actions must be a non-empty array' })
      if (steps.length > 30) return send(res, 400, { error: 'at most 30 actions per batch' })
      const done = []
      let failed = null
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] || {}
        const t0 = Date.now()
        try {
          if (step.action === 'wait') {
            const win = await resolveWindow(step.hwnd, step.hint)
            const mode = step.gone ? 'gone' : 'appear'
            const w = await hands.send('WAITFIND|' + enc(win.title) + '|' + enc(step.name || '') + '|' + (step.timeout || 3000) + '|' + mode, Math.max(15000, Number(step.timeout || 3000) + 10000))
            if (!w.found) throw new Error('waited ' + w.waitedMs + 'ms, "' + (step.name || '') + '" never ' + (mode === 'gone' ? 'disappeared' : 'appeared'))
            done.push({ step: i + 1, action: 'wait', ok: true, ms: Date.now() - t0, waitedMs: w.waitedMs })
            continue
          }
          if (step.action === 'focus') {
            const win = await resolveWindow(step.hwnd, step.hint, true)
            const fr = await hands.send('FOCUS|' + win.hwnd)
            if (!fr.focused) throw new Error(String(fr.reason || 'focus refused'))
            done.push({ step: i + 1, action: 'focus', ok: true, ms: Date.now() - t0, window: win.title })
            continue
          }
          if (step.action === 'click') {
            if (!step.name) throw new Error('click needs name')
            const win = await resolveWindow(step.hwnd, step.hint, true)
            const cr = await hands.send('CLICK|' + enc(win.title) + '|' + enc(step.name))
            done.push({ step: i + 1, action: 'click', ok: true, ms: Date.now() - t0, clicked: cr.clicked, how: cr.how })
            continue
          }
          if (step.action === 'type') {
            if (!step.text) throw new Error('type needs text')
            if (step.hwnd || step.hint) {
              const win = await resolveWindow(step.hwnd, step.hint, true)
              const fr = await hands.send('FOCUS|' + win.hwnd)
              if (!fr.focused) throw new Error(String(fr.reason || 'focus refused'))
              await new Promise((r2) => setTimeout(r2, cfg.settleMs))
            }
            const tr = await hands.send('TYPE|' + enc(step.text) + '|' + (step.delay ?? cfg.typeDelayMs), Math.max(30000, step.text.length * 120))
            done.push({ step: i + 1, action: 'type', ok: true, ms: Date.now() - t0, chars: tr.typed })
            continue
          }
          if (step.action === 'key') {
            if (!step.combo) throw new Error('key needs combo')
            if (step.hwnd || step.hint) {
              const win = await resolveWindow(step.hwnd, step.hint, true)
              const fr = await hands.send('FOCUS|' + win.hwnd)
              if (!fr.focused) throw new Error(String(fr.reason || 'focus refused'))
              await new Promise((r2) => setTimeout(r2, cfg.settleMs))
            }
            await hands.send('KEY|' + step.combo)
            done.push({ step: i + 1, action: 'key', ok: true, ms: Date.now() - t0, combo: step.combo })
            continue
          }
          if (step.action === 'clickat') {
            await hands.send('CLICKAT|' + Number(step.x) + '|' + Number(step.y))
            done.push({ step: i + 1, action: 'clickat', ok: true, ms: Date.now() - t0 })
            continue
          }
          throw new Error('unknown batch action: ' + String(step.action))
        } catch (e) {
          failed = { step: i + 1, action: String(step.action), error: String(e && e.message).slice(0, 200) }
          break
        }
      }
      remember({ at: Date.now(), action: 'batch:' + steps.length, done: done.length, failed: failed ? failed.step : null })
      // The finish matters as much as the batch: asking for the text is far
      // cheaper than a screenshot plus a vision call, and it is exact.
      let tail = {}
      const finish = String(q.finish || 'text')
      if (!failed && finish === 'text') {
        try {
          const win = await resolveWindow(q.hwnd, q.hint)
          tail = { text: (await hands.send('READ|' + enc(win.title) + '|4000', 45000)).text, window: win.title }
        } catch { /* the batch still succeeded; the tail is best effort */ }
      }
      return send(res, 200, {
        ok: !failed,
        steps: done,
        failed,
        chars: done.reduce((a, d) => a + (d.chars || 0), 0),
        totalMs: done.reduce((a, d) => a + (d.ms || 0), 0),
        ...tail,
      })
    }
    if (url.pathname === '/history') {
      return send(res, 200, { actions: state.actions, history: state.history.slice(-25).reverse() })
    }
    if (url.pathname === '/stop') {
      send(res, 200, { stopping: true })
      setTimeout(() => {
        hands.stop()
        process.exit(0)
      }, 60)
      return
    }
    return send(res, 404, { error: 'no such route: ' + url.pathname })
  } catch (e) {
    const msg = String(e && e.message)
    // A guard refusal is policy, not a failure: it goes in the history (so the
    // attempt is auditable) but not in the error list, or every deliberate block
    // looks like a broken service.
    if (/^refused:/i.test(msg)) {
      remember({ at: Date.now(), action: 'refused:' + url.pathname, why: msg.slice(0, 120) })
      log('guard refused ' + url.pathname + ': ' + msg.slice(0, 140))
      return send(res, 403, { refused: true, error: msg })
    }
    state.errors.push({ at: Date.now(), text: msg.slice(0, 200) })
    log('route ' + url.pathname + ' failed: ' + msg)
    return send(res, 500, { error: msg })
  }
})

// Materialise the token at startup, not lazily: a client that asks the operator
// "what token?" before anything has connected otherwise finds no token at all.
ensureToken()

// A port that is taken is not a crash, it is a second instance.
//
// The unhandled 'error' event used to print a stack and leave the process
// limping: it kept its UIA worker alive (a PowerShell process plus an automation
// subscription) while answering nothing, and every CLI call then fought to start
// yet another one. Naming the situation and exiting is what makes "I started it
// twice" a one-line message instead of a pile of workers.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log('port ' + port + ' is already in use: another dsh-watch-hands is running')
    console.error('dsh-watch-hands: port ' + port + ' already in use (another instance is running)')
    hands.stop()
    process.exit(2)
  }
  log('server error: ' + String(e && e.stack))
  console.error('dsh-watch-hands: ' + String(e && e.message))
  hands.stop()
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  try {
    writeFileSync(PID_PATH, String(process.pid), 'utf8')
  } catch {
    /* pid file is best effort */
  }
  log('hands daemon listening on 127.0.0.1:' + port)
  console.log('dsh-watch-hands daemon on http://127.0.0.1:' + port)
})

// Warm the worker before the first real action: a cold PowerShell start is 1.2s
// and the first click should not pay for it.
hands.start().catch((e) => log('uia worker warm-up failed: ' + String(e && e.message)))

process.on('SIGTERM', () => {
  hands.stop()
  process.exit(0)
})

// Whatever way this process ends - clean exit, an uncaught throw, a signal - the
// PowerShell worker must not outlive it.
process.on('exit', () => {
  try { hands.killNow() } catch { /* nothing left to do */ }
})

process.on('unhandledRejection', (e) => log('unhandled rejection: ' + String((e && e.stack) || e)))
process.on('uncaughtException', (e) => log('uncaught exception: ' + String((e && e.stack) || e)))