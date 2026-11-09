// Speech to text.
//
// Two backends, chosen by cfg.asr.backend:
//   cloud - the Zhipu transcription endpoint (original path)
//   local - a resident faster-whisper process on CUDA
//
// The cloud path ran out of quota (HTTP 429 / code 1113) and that silently
// broke BOTH sources the ears capture: the user's microphone and the loopback
// of whatever is playing. Local Whisper fixes both at once, and it is faster
// (150-250ms against 350-700ms), so it is the better default when it exists.
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { log } from './shared.mjs'

const WORKER_PY = fileURLToPath(new URL('./whisper-worker.py', import.meta.url))

// Model load measured on this machine: 8.7-10.1s warm GPU, 16.5s when two
// workers competed. A cold page cache or a busy card needs more, so the budget
// is generous - but a slow load is reported as slow, not as "broken".
const READY_BUDGET_MS = 150000

// Configuration is read from cfg.asr.local so a machine without a whisper
// install simply leaves it out and keeps using the cloud.
//
// There is no universal python location, and guessing at one vendor layout
// would make "local ASR is on" mean "that one tree happens to exist". Order:
// an explicit path, then $DSH_WHISPER_PYTHON, then a bare 'python' the way a
// user would have it on PATH. A machine with none of these keeps the cloud
// backend and says so, instead of dying with ENOENT deep in a spawn.

function defaultPython() {
  if (process.env.DSH_WHISPER_PYTHON) return process.env.DSH_WHISPER_PYTHON
  return 'python'
}

function localCfg(cfg) {
  const l = cfg.asr.local || {}
  return {
    python: l.python || defaultPython(),
    model: l.model || 'large',
    // Where the checkpoints are. Empty = let the worker look in the standard
    // caches; a value overrides it. This is the knob that used to be a
    // hard-coded path in the worker.
    models: l.models || '',
    language: l.language || 'zh',
    timeoutMs: l.timeoutMs || 60000,
  }
}

// One warm worker for the whole process. Loading the model costs ~4.4s on CUDA,
// which per utterance would be worse than the cloud; kept alive it is free.
class LocalWhisper {
  constructor() {
    this.child = null
    this.ready = null
    this.waiting = []
    this.loadMs = 0
  }

  // One worker, and never two.
  //
  // A rejected start used to leave the child alive: the promise rejected on the
  // ready timeout but nothing killed the process. Measured 2026-11-01 after a
  // failed listening session: eight python processes still resident, 1.4GB +
  // 0.86GB + 0.67GB of VRAM held. Every later load then competed for the GPU,
  // took 16.5s instead of 9s, timed out too, and left another orphan - the
  // leak made the next failure more likely, which is why "whisper did not
  // become ready" looked permanent instead of transient.
  start(cfg) {
    if (this.ready) return this.ready
    if (this.starting) return this.starting
    const lc = localCfg(cfg)
    this.starting = new Promise((resolve, reject) => {
      const env = { ...process.env, WHISPER_MODEL: lc.model }
      if (lc.models) env.DSH_WHISPER_MODELS = lc.models
      // Without this, Python on Windows writes stdout in the locale encoding
      // (cp936) while this side reads UTF-8: every Chinese transcript arrived as
      // mojibake. The worker also reconfigures its own stdout, but this covers
      // any python it starts.
      env.PYTHONIOENCODING = 'utf-8'
      env.PYTHONUTF8 = '1'
      const child = spawn(lc.python, [WORKER_PY], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env })
      this.child = child
      const rl = createInterface({ input: child.stdout })
      let settled = false
      const fail = (why) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Killing is part of failing: an orphan holds the GPU and makes the
        // NEXT start slower, which turns one hiccup into a dead sense.
        try { child.kill() } catch { /* already gone */ }
        this.child = null
        this.ready = null
        this.starting = null
        reject(new Error(why))
      }
      const timer = setTimeout(() => {
        fail('whisper worker did not become ready in ' + Math.round(READY_BUDGET_MS / 1000) + 's (load is ~9s on CUDA; a slower card or a cold disk needs more)')
      }, READY_BUDGET_MS)
      rl.on('line', (raw) => {
        const line = String(raw).trim()
        let msg = null
        try { msg = JSON.parse(line) } catch { return }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          if (msg.ready) {
            this.loadMs = msg.loadMs || 0
            this.device = msg.device || 'unknown'
            this.ready = Promise.resolve(true)
            resolve(true)
          } else {
            try { child.kill() } catch { /* gone */ }
            this.child = null
            this.ready = null
            this.starting = null
            reject(new Error('whisper worker: ' + (msg.error || 'unknown')))
          }
          return
        }
        const next = this.waiting.shift()
        if (next) next(msg)
      })
      child.stderr.on('data', (d) => log('whisper worker stderr: ' + String(d).slice(0, 300)))
      child.on('exit', (code) => {
        log('whisper worker exited ' + code)
        if (this.child === child) this.child = null
        this.ready = null
        this.starting = null
        for (const w of this.waiting.splice(0)) w({ error: 'worker exited' })
      })
    })
    return this.starting
  }

  async transcribe(cfg, wavPath, opts) {
    // If the user chose local, a failure here must say WHY local cannot run,
    // not surface a spawn error from three layers down.
    const probe = probeLocal(cfg)
    if (!probe.ok) return { text: '', ms: 0, error: 'local ASR unavailable: ' + probe.why }
    await this.start(cfg)
    const lc = localCfg(cfg)
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(handler)
        if (i >= 0) this.waiting.splice(i, 1)
        resolve({ text: '', ms: lc.timeoutMs, error: 'timeout' })
      }, lc.timeoutMs)
      const handler = (msg) => {
        clearTimeout(timer)
        if (msg.error) { log('whisper failed: ' + msg.error); resolve({ text: '', ms: 0, error: msg.error }); return }
        resolve({ text: String(msg.text || '').trim(), ms: msg.ms || 0, local: true, duration: msg.duration })
      }
      this.waiting.push(handler)
      const req = { wav: wavPath, language: opts?.language || lc.language }
      // A segment with almost no speech time should not be retried without VAD:
      // that retry is exactly what turns room tone into an invented sentence.
      if (opts && opts.fallbackVad === false) req.fallbackVad = false
      this.child.stdin.write(JSON.stringify(req) + '\n')
    })
  }

  stop() {
    try { this.child?.stdin.write('QUIT\n') } catch { /* gone */ }
    try { this.child?.kill() } catch { /* gone */ }
    this.child = null
    this.ready = null
  }
}

export const localWhisper = new LocalWhisper()

// The live backend choice.
//
// config.json says what to use at startup, but the user flips this WHILE playing:
// local Whisper needs the GPU, and a game needs it more. Editing a JSON file and
// restarting the daemon mid-match is not a thing anyone will do, so the choice
// lives in memory and is changed over HTTP.
let activeBackend = null

// What the config asks for, unless nothing in it can actually run.
//
// A fresh install has no local model and no cloud key. Defaulting to 'local'
// then means every utterance starts a python that does not exist, waits for it
// to fail, and falls back - a spawn per sentence to learn the same thing. Probe
// once: if there is no python on this machine, the honest default is cloud
// (which fails fast with "no key" instead of spawning anything).
let localCapable = null

// Can this machine run the local model at all?
//
// Three things have to line up, and each failure reads differently to the user:
//   - a python that exists (or 'python' on PATH)
//   - faster_whisper importable in that python
//   - a checkpoint directory that actually holds the model
// A machine missing ANY of them can still use the cloud backend, so this
// answers "is local possible", never "should local be used".
function probeLocal(cfg) {
  if (localCapable !== null) return localCapable
  const lc = localCfg(cfg)
  localCapable = (() => {
    try {
      // Distinguish the two failures before running anything: "there is no
      // python" and "python exists but cannot import faster_whisper" need
      // different instructions, and reporting the second for the first sends
      // the user to install a package in a python that was never found.
      const py = lc.python === 'python' ? 'python' : lc.python
      if (lc.python !== 'python') {
        if (!existsSync(lc.python)) return { ok: false, why: 'python not found at the configured path: ' + lc.python }
      } else {
        try {
          execFileSync('python', ['-c', 'import sys'], { stdio: 'ignore', timeout: 15000 })
        } catch {
          return { ok: false, why: 'no python on PATH (install python, or set asr.local.python / DSH_WHISPER_PYTHON)' }
        }
      }
      try {
        // stderr must be captured: 'ignore' discards it, and the module name
        // that failed to import is in there.
        execFileSync(py, ['-c', 'import faster_whisper'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000 })
      } catch (e) {
        // execFileSync puts the interpreter's own output in e.stderr; e.message
        // is only "Command failed: python -c ...", which says nothing useful.
        const err = (e && (e.stderr || e.message)) || ''
        const m = String(err)
        if (/ModuleNotFound|No module named ['"]?faster_whisper/i.test(m)) {
          return { ok: false, why: 'faster-whisper is not installed in that python (pip install faster-whisper)' }
        }
        if (/onnxruntime/i.test(m)) {
          return { ok: false, why: 'python has faster-whisper but not onnxruntime (pip install onnxruntime) - VAD needs it' }
        }
        return { ok: false, why: 'python ran but faster-whisper failed to import: ' + m.replace(/\s+/g, ' ').slice(0, 120) }
      }
      return { ok: true }
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (/ENOENT|not found/i.test(msg)) return { ok: false, why: 'python not found (set asr.local.python, or DSH_WHISPER_PYTHON)' }
      if (/faster_whisper|ModuleNotFound/i.test(msg)) return { ok: false, why: 'faster-whisper is not installed in that python (pip install faster-whisper)' }
      return { ok: false, why: msg.slice(0, 120) }
    }
  })()
  return localCapable
}

// Which backend actually runs.
//
// `asr.backend` is the user's decision, and it has three values:
//
//   'local'  - use the local model; refuse loudly if it cannot run
//   'cloud'  - use the vendor API; needs asr.apiKey
//   'auto'   - local when this machine can run it, cloud otherwise (default)
//
// 'auto' is the default because it is the only one that is right on both a
// machine with a GPU and a machine without one. But it must never be SILENT:
// status reports which one it picked and why, so "it works on his box but not
// mine" has an answer.
export function backendReport(cfg) {
  const wanted = activeBackend || cfg.asr.backend || 'auto'
  const probe = probeLocal(cfg)
  const runtime = getBackend(cfg)
  // cloud-sf is keyed by asr.siliconflow.apiKey; asr.apiKey belongs to the
  // other vendor and says nothing about whether SiliconFlow can be called.
  const sf = runtime === 'cloud-sf'
  const keyName = sf ? 'asr.siliconflow.apiKey' : 'asr.apiKey'
  const keySetCloud = String((sf ? (cfg.asr.siliconflow || {}).apiKey : cfg.asr.apiKey) || '').trim() !== ''
  return {
    wanted,
    running: runtime,
    localPossible: probe.ok,
    localWhy: probe.ok ? null : probe.why,
    cloudKeySet: keySetCloud,
    note: runtime === 'local'
      ? 'using the local model (no API cost)'
      : keySetCloud
        ? 'using the vendor API (per minute cost)'
        : 'using the vendor API but ' + keyName + ' is EMPTY - ' + (sf ? 'every segment falls back to the local model' : 'transcription will fail'),
  }
}

export function getBackend(cfg) {
  const wanted = activeBackend || cfg.asr.backend || 'auto'
  if (wanted === 'local') return 'local'
  if (wanted === 'cloud') return 'cloud'
  if (wanted === 'cloud-sf') return 'cloud-sf'
  // auto
  return probeLocal(cfg).ok ? 'local' : 'cloud'
}

export function setBackend(name, cfg) {
  const allowed = ['local', 'cloud', 'cloud-sf']
  const next = allowed.includes(name) ? name : null
  if (!next) return { ok: false, error: 'backend must be one of ' + allowed.join(', ') }
  const before = getBackend(cfg)
  activeBackend = next
  return { ok: true, backend: next, previous: before }
}

export async function transcribe(cfg, wavPath, opts = {}) {
  const backend = getBackend(cfg)

  if (backend === 'cloud-sf') {
    let sfError = 'no text'
    try {
      const out = await transcribeSiliconFlow(cfg, wavPath, opts)
      if (out && out.text) return out
      if (out && out.empty) return out
    } catch (e) {
      sfError = String(e && e.message).slice(0, 160)
      log('siliconflow asr failed: ' + sfError.slice(0, 120))
    }
    // Never leave the user deaf: fall back to local if the network or key fails.
    // The local path can also throw (worker start timeout); fold that into the
    // same result so the SiliconFlow error is not lost with it.
    let out
    try {
      out = await localWhisper.transcribe(cfg, wavPath, opts)
    } catch (e) {
      out = { error: String(e && e.message).slice(0, 160) }
    }
    if (!out.error) return { text: out.text, ms: out.ms, bytes: 0, local: true, fallback: true }
    // Both failed: say so for both. The local error alone ("python not found")
    // hides the failure of the backend the user actually picked.
    return { text: '', ms: 0, error: 'siliconflow: ' + sfError + '; local: ' + (out.error || 'failed') }
  }

  if (backend === 'local') {
    const out = await localWhisper.transcribe(cfg, wavPath, opts)
    if (!out.error) return { text: out.text, ms: out.ms, bytes: 0, local: true }
    log('local asr failed, falling back to cloud: ' + out.error)
  }
  return await transcribeCloud(cfg, wavPath, opts)
}

// SiliconFlow: the free tier exists so gaming mode costs nothing.
//
// SenseVoiceSmall answered "行，收工。" on the same clip local Whisper read
// exactly, at 394ms and ¥0. Qwen3-ASR-1.7B is 157ms but paid, so the switch
// defaults to the free one and only uses Qwen when the user asks for speed.
async function transcribeSiliconFlow(cfg, wavPath, opts = {}) {
  const p = cfg.asr.siliconflow || {}
  const key = p.apiKey || ''
  if (!key) throw new Error('no asr.siliconflow.apiKey configured')
  const buf = readFileSync(wavPath)
  const form = new FormData()
  form.append('model', opts.model || p.model || 'FunAudioLLM/SenseVoiceSmall')
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'segment.wav')
  const t0 = Date.now()
  const res = await fetch(String(p.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '') + '/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key },
    body: form,
    signal: AbortSignal.timeout(p.timeoutMs ?? 60000),
  })
  const text = await res.text()
  const ms = Date.now() - t0
  if (res.status !== 200) {
    log('sf asr failed ' + res.status + ': ' + text.slice(0, 240))
    throw new Error('SF ASR HTTP ' + res.status + ' ' + text.slice(0, 160))
  }
  let body = null
  try { body = JSON.parse(text) } catch { /* keep null */ }
  const out = String(body?.text ?? '').trim()
  return { text: out, ms, bytes: buf.length, cloud: 'siliconflow', model: opts.model || p.model || 'FunAudioLLM/SenseVoiceSmall', empty: out.length === 0 }
}

async function transcribeCloud(cfg, wavPath, opts = {}) {
  const p = cfg.asr
  if (!p.apiKey) throw new Error('no asr.apiKey configured')
  const buf = readFileSync(wavPath)
  const form = new FormData()
  form.append('model', p.model)
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'segment.wav')
  if (Array.isArray(cfg.hotwords) && cfg.hotwords.length > 0) form.append('hotwords', JSON.stringify(cfg.hotwords))
  if (opts.prompt) form.append('prompt', opts.prompt)
  const t0 = Date.now()
  const res = await fetch(String(p.baseUrl).replace(/\/+$/, '') + '/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + p.apiKey },
    body: form,
    signal: AbortSignal.timeout(p.timeoutMs ?? 90000),
  })
  const text = await res.text()
  const ms = Date.now() - t0
  if (res.status !== 200) {
    log('asr failed ' + res.status + ': ' + text.slice(0, 300))
    throw new Error('ASR HTTP ' + res.status + ' ' + text.slice(0, 200))
  }
  let body = null
  try { body = JSON.parse(text) } catch { /* keep null */ }
  return { text: String(body?.text ?? '').trim(), ms, bytes: buf.length, usage: body?.usage ?? null }
}
