// dsh-watch-panel — host half.
//
// The control panel for the watch-together stack. All the real work is in the
// browser half (lib/client.js), which draws a floating panel; this side serves
// the API it talks to and the assets it needs.
//
// Route prefix is /dsh-watch, NOT /api: the /api prefix belongs to
// @deepseek-ai/dsh-client-connection, which runs connection.admit() first and
// 401s any request without a browser session cookie. Because matching prefers
// the longest prefix, a plugin under /api/<name> never gets a turn. A distinct
// prefix sidesteps that handshake entirely.
//
// Sidestepping it also skipped the admission that came with it, which
// admitRequest below puts back.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { STATUS_CODES } from 'node:http'

export const name = 'dsh-watch-panel'
export const inject = ['webServer']

const BASE = '/dsh-watch'

// Where the sibling plugins actually live.
//
// A plugin installed from npm is a dependency of the profile, not a directory at
// a fixed drive letter. So: an explicit override if one is set, otherwise the
// package directory beside this package. Guessing at one machine's absolute
// layout made every panel button shell out to a CLI that did not exist, which
// reads as "the CLI is broken" rather than "the path is wrong".
// Three levels up from lib/index.js is the directory that holds the sibling
// packages: node_modules for an npm install, or packages/ for a checkout.
const PKG_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const requireHere = createRequire(import.meta.url)

// Resolving a sibling package has to go through the package manager, not
// through a path guess: npm hoists, pnpm does not, and a junction install puts
// things somewhere else entirely. createRequire handles all three; the path
// fallbacks are for the layout where the packages really do sit side by side
// (a git checkout used as-is).
function pkgDir(name) {
  try {
    return dirname(requireHere.resolve(name + '/package.json'))
  } catch {
    /* not resolvable as a dependency: fall through to the sibling layouts */
  }
  const beside = join(PKG_ROOT, name)
  if (existsSync(beside)) return beside
  if (process.env.DSH_PLUGIN_ROOT) {
    const pinned = join(process.env.DSH_PLUGIN_ROOT, name)
    if (existsSync(pinned)) return pinned
  }
  return beside
}

// The face (avatar window) is an optional extra: it is an Electron app too large
// for npm, so it ships separately. When it is absent the panel reports it DOWN
// instead of running a path that cannot exist.
const FACE_CLI = process.env.DSH_FACE_CLI || join(homedir(), '.dsh-watch', 'face', 'bin', 'face.mjs')

const CLI = {
  eyes: join(pkgDir('dsh-watch-eyes'), 'bin', 'eyes.mjs'),
  mouth: join(pkgDir('dsh-watch-mouth'), 'bin', 'mouth.mjs'),
  ears: join(pkgDir('dsh-watch-ears'), 'bin', 'ears.mjs'),
  browser: join(pkgDir('dsh-watch-browser'), 'bin', 'browser.mjs'),
  face: FACE_CLI,
  companion: join(pkgDir('dsh-watch-ears'), 'bin', 'companion.mjs'),
}

// Which interpreter to run these CLIs with.
//
// Bare 'node' is not on this machine's PATH (it ships inside the DSH runtime), so
// it has to be named. But process.execPath is NOT it: this code runs inside the
// DSH host process, whose execPath is DeepSeek Harness.exe (Electron). Spawning
// that with a .mjs argument starts a second Electron app, not a script, and every
// panel button failed with an empty output - which reads as "the CLI broke".
//
// Order: an explicit override, then the node binary that ships beside the host's
// runtime, then the host itself with ELECTRON_RUN_AS_NODE (works, but heavier).
function resolveNode() {
  if (process.env.DSH_NODE) return { cmd: process.env.DSH_NODE, env: {} }
  const beside = [
    join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    join(dirname(process.execPath), 'resources', 'runtime', 'bin', 'node.exe'),
  ]
  for (const p of beside) if (existsSync(p)) return { cmd: p, env: {} }
  return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

const NODE_BIN = resolveNode()
const NODE = NODE_BIN.cmd

// Which of the two mutually exclusive subjects is selected. Remembered in memory
// only: it drives the panel's own display and the hint it shows the user.
const state = { mode: 'video' }

const SERVICES = {
  mouth:   { label: '嘴 · 合成与播放', port: 37716, path: '/health', start: [CLI.mouth, 'status'],   stop: [CLI.mouth, 'stop'] },
  eyes:    { label: '眼 · 抓屏与视觉', port: 37711, path: '/health', start: [CLI.eyes, 'status'],    stop: [CLI.eyes, 'stop'] },
  ears:    { label: '耳 · 听觉与推送', port: 37712, path: '/health', start: [CLI.ears, 'status'],    stop: [CLI.ears, 'stop'] },
  browser: { label: '手 · 浏览器控制', port: 37713, path: '/health', start: [CLI.browser, 'status'], stop: [CLI.browser, 'stop'] },
  face:    { label: '脸 · 形象与气泡', port: 37714, path: '/status', start: [CLI.face, 'window'],   stop: [CLI.face, 'stop'], optional: true },
  chrome:  { label: 'Chrome · 隔离实例', port: 9222, path: null,     start: [CLI.browser, 'launch-cdp'], stop: [CLI.browser, 'stop'] },
}

function run(cmd, args, timeoutMs) {
  // A command that points at a package that is not installed is not a failure
  // of the service: say so plainly, so the panel shows "not installed" rather
  // than an empty stderr that reads like a crash.
  if (!existsSync(cmd)) {
    return Promise.resolve({ ok: false, out: 'not installed: ' + cmd })
  }
  return new Promise((resolve) => {
    // The interpreter's own environment decides whether it behaves like node;
    // callers pass NODE (already resolved) so this only adds the override.
    execFile(cmd, args, {
      timeout: timeoutMs || 30000,
      windowsHide: true,
      env: { ...process.env, ...NODE_BIN.env },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (String(stdout || '') + String(stderr || '')).slice(0, 4000) })
    })
  })
}

async function probe(svc) {
  const s = SERVICES[svc]
  if (!s.path) {
    // Chrome: no safe HTTP health endpoint, so just see if the debug port accepts.
    const net = await import('node:net')
    return await new Promise((resolve) => {
      const t0 = Date.now()
      const sock = new net.Socket()
      let done = false
      const finish = (up) => {
        if (done) return
        done = true
        try { sock.destroy() } catch { /* gone */ }
        resolve({ up, ms: Date.now() - t0 })
      }
      sock.setTimeout(1200)
      sock.once('connect', () => finish(true))
      sock.once('error', () => finish(false))
      sock.once('timeout', () => finish(false))
      sock.connect(s.port, '127.0.0.1')
    })
  }
  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2200)
    const res = await fetch('http://127.0.0.1:' + s.port + s.path, { signal: ctrl.signal })
    clearTimeout(timer)
    const body = await res.json().catch(() => ({}))
    return { up: res.ok, ms: Date.now() - t0, detail: body }
  } catch {
    return { up: false, ms: Date.now() - t0, detail: null }
  }
}

async function allStatus() {
  const out = {}
  await Promise.all(Object.keys(SERVICES).map(async (k) => {
    const p = await probe(k)
    out[k] = { ...p, label: SERVICES[k].label, port: SERVICES[k].port }
  }))
  return out
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

// Who may call these routes.
//
// The web server dispatches by longest prefix and admits nothing itself: the
// browser-session check belongs to the connection service, inside its own /api
// route. A route under /dsh-watch is therefore reached by anything that reaches
// the web server, a web page in the user's browser included (an <img> GET, or a
// fetch through a DNS-rebinding name), and every route here starts or drives
// something on a plain GET.
//
// So ask the connection service for the verdict it gives /api: its Host/Origin
// fence plus the browser session cookie, which the panel's own same-origin
// fetches already carry. requestRejection is the call meant for "another Web
// route"; admit is the same check in the shape some releases expose. If the
// host has no connection service, fall back to the structural part of that
// fence: a loopback Host, no cross-site Fetch-Metadata, and an Origin or Referer
// naming the same authority as the Host. The desktop app relays its
// dsh-app://app page to the loopback server and leaves that Referer behind,
// without the browser markers, so that one is accepted as it is.
//
// A failing check refuses (503), it never waves the request through.
//
// Same approach as dsh-see-now's src/settings-trust.js (Apache-2.0); the code
// here is this plugin's own.
//
// URL keeps the brackets on an IPv6 hostname (new URL('http://[::1]:80').hostname
// is '[::1]'), so that is the form to match.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function connectionOf(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  } catch {
    return undefined
  }
}

function sameAuthority(value, host) {
  let u
  try {
    u = new URL(value)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  try {
    return new URL(u.protocol + '//' + host).host === u.host
  } catch {
    return false
  }
}

function isDesktopRelay(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'dsh-app:' && u.hostname === 'app' && u.port === '' && u.username === '' && u.password === ''
  } catch {
    return false
  }
}

function structuralRejection(req) {
  const h = req.headers || {}
  const host = String(h.host || '').trim().toLowerCase()
  if (host === '' || /[@/\\?#\s]/u.test(host)) return 403
  let hostname
  try {
    hostname = new URL('http://' + host).hostname
  } catch {
    return 403
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return 403
  if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  for (const name of ['origin', 'referer']) {
    const v = h[name]
    if (typeof v !== 'string' || v.trim() === '') continue
    if (name === 'referer' && isDesktopRelay(v)) {
      if (h.origin !== undefined || h['sec-fetch-site'] !== undefined) return 403
      continue
    }
    if (!sameAuthority(v.trim(), host)) return 403
  }
  return undefined
}

// Returns the HTTP status to refuse with, or undefined to let the request in.
function admitRequest(req, connection) {
  try {
    if (connection && typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req) || undefined
    }
    if (connection && typeof connection.admit === 'function') {
      const admission = connection.admit(req)
      return (admission && typeof admission === 'object' && admission.rejection) || undefined
    }
  } catch {
    return 503
  }
  return structuralRejection(req)
}

// The body names the refusal the status already gives: 401 is the missing
// session, 503 a check that failed, anything else what HTTP calls it.
function refusalText(code) {
  if (code === 401) return 'not signed in'
  return String(STATUS_CODES[code] || 'refused').toLowerCase()
}

async function handle(req, res, sub, q) {
  if (sub === '/status') return json(res, 200, await allStatus())

  if (sub === '/svc') {
    const s = SERVICES[q.svc]
    if (!s) return json(res, 400, { ok: false, error: 'unknown service ' + q.svc })
    if (q.act !== 'start' && q.act !== 'stop') return json(res, 400, { ok: false, error: 'act must be start or stop' })
    const cmd = q.act === 'start' ? s.start : s.stop
    const r = await run(NODE, cmd, 90000)
    return json(res, 200, { ok: r.ok, out: r.out, action: q.act + ' ' + q.svc })
  }

  if (sub === '/all') {
    const act = q.act === 'stop' ? 'stop' : 'start'
    // Dependency order: the mouth first (everything that speaks needs it),
    // reverse on the way down so nothing is animated while its voice vanishes.
    const order = act === 'stop' ? ['face', 'ears', 'browser', 'mouth', 'eyes'] : ['mouth', 'eyes', 'ears', 'browser', 'face', 'chrome']
    const lines = []
    for (const svc of order) {
      const s = SERVICES[svc]
      const cmd = act === 'stop' ? s.stop : s.start
      const r = await run(NODE, cmd, 90000)
      lines.push(svc + ': ' + (r.ok ? 'ok' : 'failed') + (r.out ? ' — ' + r.out.trim().split('\n')[0].slice(0, 110) : ''))
    }
    return json(res, 200, { ok: true, lines })
  }

  // Which mode the user wants. The pusher itself is started by a session (only
  // it can spawn the subagent that receives pushes), so the panel's job is to
  // remember the choice and report it back, not to pretend it started anything.
  // Gaming mode: the GPU belongs to the game, so speech-to-text moves off the
  // local Whisper worker and onto SiliconFlow's paid Qwen3-ASR (411ms, ~0.8元/h).
  // This one really does take effect immediately - the ears daemon switches at
  // runtime - so unlike /mode the panel is not just recording a preference.
  // Speaking frequency. This one really is live: the ears daemon owns the pusher
  // settings and hands them down to the running pusher on its next poll (~2s).
  if (sub === '/pace') {
    const ears = SERVICES.ears && SERVICES.ears.port
    if (!ears) return json(res, 500, { ok: false, error: 'ears service unknown' })
    try {
      const url = 'http://127.0.0.1:' + ears + '/tuning' + (q.set ? '?pace=' + encodeURIComponent(q.set) : '')
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
      return json(res, 200, { ok: true, ...(await r.json()) })
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message).slice(0, 160) })
    }
  }

  if (sub === '/asr') {
    const ears = SERVICES.ears && SERVICES.ears.port
    if (!ears) return json(res, 500, { ok: false, error: 'ears service unknown' })
    const base = 'http://127.0.0.1:' + ears + '/asr/backend'
    try {
      const url = base + (q.set ? '?set=' + encodeURIComponent(q.set) : '')
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const body = await r.json()
      return json(res, 200, { ok: true, ...body, gaming: body.current === 'cloud-sf' })
    } catch (e) {
      return json(res, 200, { ok: false, error: String(e && e.message).slice(0, 160) })
    }
  }

  if (sub === '/mode') {
    if (q.set === 'video' || q.set === 'screen') {
      state.mode = q.set
      return json(res, 200, { ok: true, mode: state.mode, hint: state.mode === 'screen' ? '看屏幕：让她盯着前台窗口' : '看番：让她读字幕追剧情' })
    }
    return json(res, 200, { ok: true, mode: state.mode || 'video' })
  }

  if (sub === '/watch') {
    const act = q.act
    const map = {
      arm:   [NODE, [CLI.companion, 'arm'], 120000],
      play:  [NODE, [CLI.companion, 'play'], 60000],
      pause: [NODE, [CLI.companion, 'pause'], 30000],
      off:   [NODE, [CLI.companion, 'off'], 60000],
      check: [NODE, [CLI.companion, 'check'], 60000],
    }
    if (act === 'say') {
      const text = String(q.text || '').trim()
      if (!text) return json(res, 400, { ok: false, error: 'text required' })
      const args = [CLI.face, 'say', text]
      if (q.emotion) args.push('--emotion', q.emotion)
      const r = await run(NODE, args, 45000)
      return json(res, 200, { ok: r.ok, out: r.out })
    }
    const entry = map[act]
    if (!entry) return json(res, 400, { ok: false, error: 'unknown watch action ' + act })
    const r = await run(entry[0], entry[1], entry[2])
    return json(res, 200, { ok: r.ok, out: r.out })
  }

  // The floating panel's actual code. It has to be served from here because the
  // module loader is the only way a client plugin reaches the page, and a 404
  // here is INVISIBLE: the inject row swallows onerror on purpose (a failing
  // script-src row rejects __DSH_BOOT_READY__ and takes the whole app down), so
  // a missing bundle shows up as "the panel button just is not there".
  if (sub === '/client.js' || sub === '/client.css') {
    const file = join(HERE, sub.slice(1))
    if (!existsSync(file)) return json(res, 404, { ok: false, error: 'asset missing: ' + sub })
    res.writeHead(200, {
      'content-type': sub.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
    })
    return res.end(readFileSync(file))
  }

  return json(res, 404, { ok: false, error: 'no route ' + sub })
}

export function apply(ctx) {
  // A missing service must not turn into a host startup exception.
  if (!ctx || !ctx.webServer) return

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      let sub = '/'
      let q = {}
      try {
        const u = new URL(req.url || '/', 'http://x')
        sub = u.pathname.slice(BASE.length).replace(/\/+$/u, '') || '/'
        q = Object.fromEntries(u.searchParams.entries())
      } catch { /* keep defaults */ }
      const refused = admitRequest(req, connectionOf(ctx))
      if (refused) return json(res, refused, { ok: false, error: refusalText(refused) })
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
      try {
        return await handle(req, res, sub, q)
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message).slice(0, 300) })
      }
    },
  }))

  // The loader row the page applies. Inline, and the <script> is built by hand
  // with onerror swallowed on purpose: a script-src row whose load fails rejects
  // __DSH_BOOT_READY__ and takes the whole app down (the issue #154 failure),
  // and this row is collected once at host start with no refresh path, so it can
  // outlive the route it points at.
  const injectRow =
    '(function(){try{' +
    'if(window.__dshWatchPanel)return;window.__dshWatchPanel=1;' +
    'var d=document.body||document.head||document.documentElement;if(!d)return;' +
    // No <link> row: the bundle injects its own <style> (CSS is a string inside
    // client.js). A stylesheet href that 404s on every load is pure noise, and
    // it used to make "is the panel loaded?" unanswerable from the network tab.
    'var s=document.createElement("script");s.src="/dsh-watch/client.js";' +
    's.onerror=function(){};d.appendChild(s);' +
    '}catch(e){}})()'

  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      const exists = table.some((row) => row && typeof row.text === 'string' && row.text.indexOf('/dsh-watch/client.js') >= 0)
      if (exists) return
      table.push({ kind: 'script', text: injectRow })
    } catch { /* never break index rendering */ }
  }))
}
