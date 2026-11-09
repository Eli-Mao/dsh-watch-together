// Continuous listening: per source, record a segment, transcribe it, keep the
// text. Loopback is the video, microphone is the user. A near-silent segment is
// dropped before upload so an idle room costs nothing.
import { join } from 'node:path'
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { Recorder } from './recorder.mjs'
import { transcribe } from './asr.mjs'
import { AUDIO_DIR, log } from './shared.mjs'

const KEEP_SEGMENTS = 24

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A recogniser handed room tone invents punctuation or a stray glyph. Only keep
// something that actually carries a letter, a digit or a CJK character.
function useful(text) {
  const t = String(text ?? '').trim()
  if (t.length < 2) return false
  return /[\p{L}\p{N}]/u.test(t)
}

export class Listener {
  constructor(cfg) {
    this.cfg = cfg
    this.running = false
    this.recorders = new Map()
    this.lines = []
    this.seq = 0
    this.startedAt = 0
    this.stats = { segments: 0, skipped: 0, transcribed: 0, errors: 0, asrMs: 0, chars: 0, junk: 0, repeats: 0 }
    this.error = null
    // Continuity: the recogniser's own previous line is passed back as context
    // so a sentence crossing a segment boundary is not chopped in half.
    this.tail = new Map()
  }

  recordersFor(sources) {
    const list = []
    for (const s of sources) {
      if (!this.recorders.has(s)) this.recorders.set(s, new Recorder(s))
      list.push([s, this.recorders.get(s)])
    }
    return list
  }

  start(opts = {}) {
    if (this.running) return this.status()
    this.cfg.capture.segmentSeconds = Math.min(Math.max(Number(opts.segment) || this.cfg.capture.segmentSeconds || 6, 2), 25)
    const sources = String(opts.sources || this.cfg.capture.sources.join(',')).split(',').map((s) => s.trim()).filter((s) => s === 'loop' || s === 'mic')
    this.sources = sources.length > 0 ? sources : ['loop']
    this.running = true
    this.startedAt = Date.now()
    this.error = null
    // Each start is a new generation. Without this, a stop-then-start leaves
    // the previous pump loop alive against a recorder that was already killed,
    // and two loops fight over one capture process.
    this.generation = (this.generation ?? 0) + 1
    const gen = this.generation
    ensureAudioDir()
    for (const [src, rec] of this.recordersFor(this.sources)) {
      this.pump(src, rec, gen).catch((e) => {
        this.error = src + ': ' + String(e && e.message)
        log('listener pump died: ' + this.error)
      })
    }
    return this.status()
  }

  // Recording and transcription are pipelined on purpose. The naive version
  // awaited the upload before starting the next recording, which left a hole of
  // one ASR round trip between segments and swallowed whole words.
  async pump(source, rec, gen) {
    const begin = () => {
      this.seq += 1
      const path = join(AUDIO_DIR, source + '-' + this.seq + '.wav')
      return { path, p: rec.record(this.cfg.capture.segmentSeconds, path, { silenceMs: this.cfg.capture.silenceCutMs, threshold: this.cfg.capture.speechThreshold }) }
    }
    let cur = begin()
    while (this.running && this.generation === gen) {
      let r = null
      let failed = null
      try {
        r = await cur.p
      } catch (e) {
        failed = e
      }
      const finished = cur
      cur = this.running ? begin() : null
      try {
        if (failed) throw failed
        this.stats.segments += 1
        // "Did anyone say anything" is a question about SPEECH, not about
        // loudness. Peak alone answered it badly in both directions: a quiet
        // speaker (peak 0.008-0.015 against a 0.02 floor) was skipped entirely,
        // and a door slam passed the floor with zero words in it.
        //
        // So a segment qualifies if it holds enough speech time OR is loud. The
        // speech time comes from the recorder, which already runs endpointing
        // for exactly this reason.
        const floor = source === 'mic'
          ? (this.cfg.capture.silencePeakMic ?? 0.02)
          : this.cfg.capture.silencePeak
        const minSpeechMs = Number(this.cfg.capture.minSpeechMs) || 300
        const worthIt = r.peak >= floor || (Number(r.speechMs) || 0) >= minSpeechMs
        if (worthIt) {
          // Only let the worker retry without VAD when the recorder actually
          // measured speech. A loud door slam passes the peak floor with zero
          // speech time, and retrying without VAD is how Whisper invents a
          // sentence out of a slamming door.
          const spoke = (Number(r.speechMs) || 0) >= minSpeechMs || r.peak >= floor
          const a = await transcribe(this.cfg, finished.path, {
            prompt: this.tail.get(source),
            fallbackVad: spoke && (Number(r.speechMs) || 0) >= minSpeechMs,
          })
          // cloud-sf reports a failure as {text:'', error} rather than throwing;
          // without this it was counted as junk and status showed errors=0.
          if (a.error) throw new Error(a.error)
          this.stats.transcribed += 1
          this.stats.asrMs += a.ms
          if (useful(a.text) && !this.isRepeat(source, a.text)) {
            this.stats.chars += a.text.length
            this.tail.set(source, a.text.slice(-120))
            this.push({ at: new Date().toISOString(), source, text: a.text, peak: Number(r.peak.toFixed(4)), ms: a.ms })
          } else {
            this.stats.junk += 1
          }
        } else {
          this.stats.skipped += 1
        }
      } catch (e) {
        this.stats.errors += 1
        this.error = source + ': ' + String(e && e.message)
        log('listen error: ' + this.error)
      } finally {
        safeUnlink(finished.path)
        trimAudio()
      }
      if (!cur) break
      if (failed) await sleep(800)
    }
  }

  // Is this the same line we just recorded from this source?
  //
  // Whisper loops on near-silence: the same invented line comes back every few
  // seconds ("字幕志愿者 杨茜茜" 4x in 90s, all from a quiet microphone). Keeping
  // it means the watcher reads a credit card as dialogue, and the user hears the
  // same remark repeated. A person CAN say the same thing twice, so the window
  // is short and the comparison is exact: a genuine repeat a minute later still
  // gets through.
  isRepeat(source, text) {
    const prev = this.lastPush?.get(source)
    const now = Date.now()
    if (prev && now - prev.at < 45000 && prev.text === text) {
      this.stats.repeats = (this.stats.repeats || 0) + 1
      return true
    }
    if (!this.lastPush) this.lastPush = new Map()
    this.lastPush.set(source, { at: now, text })
    return false
  }

  push(line) {
    this.lines.push(line)
    if (this.lines.length > 400) this.lines.shift()
    log('heard[' + line.source + '] ' + line.text.slice(0, 120))
    // Append to the live log BEFORE any hook can throw: this file is the only
    // channel the parent session has (the host refuses inbox delivery to a root
    // session), so a lost write means a lost observation.
    try {
      this.appendLive(line)
    } catch (e) {
      log('live log write failed: ' + String(e && e.message))
    }
    try { this.onLine?.(line) } catch (e) { log('onLine hook failed: ' + String(e && e.message)) }
  }

  // The observation stream on disk, one JSON object per line.
  //
  // Why a file instead of the pusher's inbox: measured on this host, delivering
  // to the ROOT session fails with 'belongs to another parent session'. A file
  // has no such gate, survives a daemon restart, and lets the reader decide its
  // own cadence - which is exactly what "no subagent" needs.
  appendLive(line) {
    if (!this.livePath) {
      const dir = join(AUDIO_DIR, '..', 'live')
      mkdirSync(dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      this.livePath = join(dir, day + '.ndjson')
    }
    appendFileSync(this.livePath, JSON.stringify(line) + '\n', 'utf8')
  }

  recent(seconds) {
    const cut = Date.now() - Math.max(Number(seconds) || 120, 5) * 1000
    return this.lines.filter((l) => Date.parse(l.at) >= cut)
  }

  stop() {
    this.running = false
    this.generation = (this.generation ?? 0) + 1
    for (const rec of this.recorders.values()) rec.stop()
    this.recorders.clear()
    return this.status()
  }

  status() {
    return {
      running: this.running,
      sources: this.sources ?? [],
      segmentSeconds: this.cfg.capture.segmentSeconds,
      uptimeMs: this.running ? Date.now() - this.startedAt : 0,
      stats: this.stats,
      error: this.error,
      last: this.lines.slice(-15),
    }
  }
}

function ensureAudioDir() {
  try { mkdirSync(AUDIO_DIR, { recursive: true }) } catch { /* best effort */ }
}

function safeUnlink(path) {
  try { rmSync(path, { force: true }) } catch { /* best effort */ }
}

function trimAudio() {
  try {
    const files = readdirSync(AUDIO_DIR)
      .filter((f) => f.endsWith('.wav') || f.endsWith('.native.wav'))
      .map((f) => ({ f, m: statSync(join(AUDIO_DIR, f)).mtimeMs }))
    files.sort((a, b) => b.m - a.m)
    for (const extra of files.slice(KEEP_SEGMENTS * 2)) safeUnlink(join(AUDIO_DIR, extra.f))
  } catch { /* housekeeping must never break listening */ }
}
