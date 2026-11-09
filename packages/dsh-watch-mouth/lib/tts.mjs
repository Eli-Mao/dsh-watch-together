// Speech engine for dsh-watch-mouth.
//
// Primary: Zhipu glm-tts over the same key the vision/ASR side already uses.
// It streams raw PCM while the sentence is still being synthesised, so playback
// starts on the first chunk (~850ms measured) instead of after the last one.
// Measured 12 back-to-back calls: 0 failures, no 429, p50 ~1.3s for a full
// response but the first audio arrives much earlier.
//
// Fallback: Microsoft Edge neural voices (free, no key). That endpoint went
// hard-unavailable on 2026-10-24 (every websocket handshake answered HTTP 200
// instead of 101), so it is no longer trusted as the first choice - only as a
// per-utterance fallback while it happens to work.
//
// Playback lives in a resident PowerShell worker (speak-worker.ps1): MediaPlayer
// for finished files, NAudio for the streamed PCM path. The worker ships with
// this plugin; the eyes daemon no longer owns any audio output.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, STATE_DIR, log } from './shared.mjs'

const WORKER = fileURLToPath(new URL('./speak-worker.ps1', import.meta.url))
// Utterances are per-run artefacts for inspection, so they live with the project
// rather than in the home directory alongside machine settings.
const AUDIO_DIR = join(DATA_DIR, 'audio')
const KEEP_UTTERANCES = 12
const CONNECT_TRIES = 3
const GLM_PCM_RATE = 24000
const GLM_PCM_BITS = 16
const GLM_PCM_CHANNELS = 1
const GLM_BYTES_PER_SEC = (GLM_PCM_RATE * GLM_PCM_BITS * GLM_PCM_CHANNELS) / 8

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// MiniMax accepts seven emotions on speech-2.8-hd (verified against the API).
// Picking one per line from the text is free and beats a fixed setting: a
// joke delivered in "sad" reads as broken, and a heavy scene in "happy" is
// worse. Anything ambiguous stays neutral so the voice never emotes wrongly.
const EMOTION_RULES = [
  ['angry', /(气死|火大|过分|凭什么|恶心|垃圾|离谱|卧槽|妈的)/],
  ['sad', /(难受|难过|心疼|可惜|遗憾|走了|死了|再见|告别|哭|泪|最后|其实挺惨)/],
  ['surprised', /(居然|竟然|没想到|我去|我的天|啊\?|什么鬼|还能这样)/],
  ['fearful', /(吓|恐怖|害怕|不敢|阴森|瘆人|危险)/],
  ['happy', /(哈哈|笑死|好玩|有意思|不错|好看|舒服|开心|太棒|可爱|绝了)/],
  ['disgusted', /(恶心|油腻|下头|受不了)/],
]

export function pickEmotion(text, fallback = 'neutral') {
  const s = String(text || '')
  for (const [emotion, re] of EMOTION_RULES) if (re.test(s)) return emotion
  return fallback
}

// SiliconFlow names its preset voices per model: "FunAudioLLM/CosyVoice2-0.5B:anna",
// not "anna" (https://docs.siliconflow.cn/cn/userguide/capabilities/text-to-speech).
// Configs written with the bare name, and users who type just the name, get the
// configured model put in front here. Other vendors, and ids that already carry
// a colon (prefixed presets, uploaded "speech:..." voices), go through as they are.
function openaiVoice(voice, base, model) {
  const v = String(voice || 'anna')
  if (v.includes(':')) return v
  let host = ''
  try { host = new URL(base).hostname.toLowerCase() } catch { /* not a URL: leave the voice alone */ }
  const sf = /(^|\.)siliconflow\.(cn|com)$/.test(host)
  return sf ? model + ':' + v : v
}

export class Speaker {
  constructor(voice, prosody, opts = {}) {
    this.voice = voice || 'zh-CN-XiaoyiNeural'
    this.prosody = { rate: '+0%', pitch: '+0Hz', volume: '100', ...(prosody || {}) }
    this.tts = { provider: 'glm', ...(opts.tts || {}) }
    this.zhipu = opts.zhipu || {}
    // output.deviceName: route this program's speech into a specific playback
    // device (Voicemeeter Input, VB-Cable) without touching the Windows default.
    // Name, not index: WinMM numbers shift whenever a device is plugged in.
    this.output = opts.output || {}
    this.outDevice = -1
    this.engine = null           // Edge socket (fallback only)
    this.child = null
    this.workerReady = null
    this.waiting = []
    this.counter = 0
    this.spoken = 0
    this.lastText = null
    this.lastDurationMs = 0
    this.blockedUntil = 0
    this.connectFails = 0
    // Chunked speech: several /say calls that are ONE utterance.
    //
    // A caller streaming tokens sends the reply in pieces. Without this flag each
    // piece would open a new PCM stream, and opening one STOPS the previous - so
    // only the last fragment would ever be heard. `appendNext` says "this one
    // continues the audio already playing".
    this.appendNext = false
    // When a reply is streamed in pieces, each piece extends the mouth clock
    // instead of resetting it. Without this the avatar animates only the last
    // fragment: elapsed/remaining kept describing one piece of seven.
    this.appendUntil = 0
  }

  // Mark the next say() as a continuation. Cleared after it is used.
  queueContinuation() {
    this.appendNext = true
  }

  // Utterance dirs are u<prefix>-<n>; the prefix keeps two Speakers in one
  // process (or files left by a killed daemon) from colliding.
  dirName() {
    if (!this.prefix) this.prefix = Math.random().toString(36).slice(2, 6)
    this.counter += 1
    return 'u' + this.prefix + '-' + this.counter
  }

  // ---- worker ----------------------------------------------------------

  startWorker() {
    if (this.workerReady) return this.workerReady
    this.workerReady = new Promise((resolve, reject) => {
      this.child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      const rl = createInterface({ input: this.child.stdout })
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('speak worker never became ready')) }
      }, 25000)
      rl.on('line', (line) => {
        if (line === 'READY') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // Resolve the named device only after the worker answers READY: the
          // list has to come from the same process that will play the audio.
          this.configureOutput().then(
            () => resolve(true),
            (e) => { log('speak worker: output setup failed: ' + String(e && e.message)); resolve(true) },
          )
          return
        }
        if (line.startsWith('WARN|')) { log('speak worker: ' + line); return }
        if (this.collecting && this.collecting.line(line)) return
        const next = this.waiting.shift()
        if (!next) return
        if (line.startsWith('ERR|')) next.reject(new Error(line.slice(4)))
        else next.resolve(line)
      })
      this.child.stderr.on('data', (d) => log('speak worker stderr: ' + String(d).slice(0, 400)))
      this.child.on('exit', (code) => {
        log('speak worker exited ' + code)
        this.child = null
        this.workerReady = null
        for (const p of this.waiting.splice(0)) p.reject(new Error('speak worker exited'))
      })
    }).catch((e) => {
      this.workerReady = null
      throw e
    })
    return this.workerReady
  }

  // Every command that expects a reply registers one waiter. DEVICES answers
  // with a burst of DEV| lines plus a terminator, so it needs its own collector
  // instead of the one-shot waiting queue.
  listDevices(timeoutMs) {
    return new Promise((resolve, reject) => {
      const devs = []
      const timer = setTimeout(() => { this.collecting = null; reject(new Error('DEVICES timeout')) }, timeoutMs ?? 15000)
      this.collecting = {
        line: (line) => {
          if (line.startsWith('DEV|')) {
            const rest = line.slice(4)
            const sep = rest.indexOf('|')
            if (sep > 0) devs.push({ index: Number(rest.slice(0, sep)), name: rest.slice(sep + 1) })
            return true
          }
          if (line === 'DEVICES-END') { clearTimeout(timer); this.collecting = null; resolve(devs); return true }
          if (line.startsWith('ERR|')) { clearTimeout(timer); this.collecting = null; reject(new Error(line.slice(4))); return true }
          return false
        },
      }
      this.child.stdin.write('DEVICES\n')
    })
  }

  // Pick the playback device once per worker. A miss is a loud WARN plus the
  // system default - never a silent fallback, that is how "her voice is in the
  // call but the game leaks in too" happens.
  async configureOutput() {
    const want = String(this.output?.deviceName || '').trim()
    const wanted = Number.isInteger(this.output?.deviceNumber) ? this.output.deviceNumber : null
    if (!want && wanted === null) { this.outDevice = -1; return -1 }
    if (!this.child) return -1
    let index = wanted
    if (want) {
      const devs = await this.listDevices()
      const hit = devs.find((d) => d.name.toLowerCase().includes(want.toLowerCase()))
      if (!hit) {
        log('WARN output device not found: ' + want + ' (falling back to the system default)')
        index = -1
      } else {
        index = hit.index
      }
    }
    const answer = this.nextLine(10000, 'device')
    this.child.stdin.write('DEVICE|' + index + '\n')
    await answer
    this.outDevice = index
    log(
      index >= 0
        ? 'output device: ' + (want || '(by number)') + ' (' + index + ')'
        : 'output device: system default',
    )
    return index
  }

  nextLine(timeoutMs, what) {
    return new Promise((resolve, reject) => {
      // A timed-out waiter used to stay in the queue, so the next reply was
      // handed to a promise nobody watches and every later command slipped one
      // answer behind. Splice it out instead.
      const entry = {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(entry)
        if (i >= 0) this.waiting.splice(i, 1)
        reject(new Error(what + ' timeout'))
      }, timeoutMs)
      this.waiting.push(entry)
    })
  }

  async playFile(file) {
    const p = this.nextLine(25000, 'speak')
    this.child.stdin.write('SAY|' + file + '\n')
    return await p
  }

  // Close a streamed utterance. The waiter is registered before the write so a
  // fast PCMDONE cannot land while nobody is listening, and a slow one returns
  // null rather than failing a line that already played.
  async finishCurrent() {
    const p = this.nextLine(20000, 'pcm close')
    this.child.stdin.write('PCMCLOSE\n')
    try {
      return await p
    } catch (e) {
      log('PCMCLOSE: ' + String(e && e.message))
      return null
    }
  }

  // /devices on the daemon: show the mapping the worker actually sees.
  async devices() {
    await this.ready()
    const list = await this.listDevices()
    return { outDevice: this.outDevice, configured: this.output?.deviceName || null, devices: list }
  }

  // ---- glm-tts (primary) -----------------------------------------------

  // SSE frames carry base64 PCM in choices[0].delta.content. Hand the bytes to
  // the worker the moment each frame lands.
  async speakGlm(text) {
    const base = String(this.zhipu.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '')
    const key = this.zhipu.apiKey
    if (!key) throw new Error('glm-tts: no apiKey')
    const body = {
      model: this.tts.model || 'glm-tts',
      input: text,
      voice: this.tts.voice || 'female',
      speed: this.tts.speed ?? 1.1,
      response_format: 'pcm',
      stream: true,
    }
    const t0 = Date.now()
    const res = await fetch(base + '/audio/speech', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + key,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.tts.timeoutMs ?? 60000),
    })
    if (res.status !== 200) {
      const detail = await res.text().catch(() => '')
      const err = new Error('glm-tts HTTP ' + res.status + ' ' + detail.slice(0, 160))
      err.status = res.status
      throw err
    }

    const open = this.nextLine(15000, 'pcm open')
    this.child.stdin.write('PCMOPEN|' + GLM_PCM_RATE + '|' + GLM_PCM_BITS + '|' + GLM_PCM_CHANNELS + '|' + (this.appendNext ? '1' : '0') + '\n')
    this.appendNext = false
    await open

    const dec = new TextDecoder()
    const reader = res.body.getReader()
    let acc = ''
    let bytes = 0
    let firstAt = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += dec.decode(value, { stream: true })
      let nl
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl).trim()
        acc = acc.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (raw === '' || raw === '[DONE]') continue
        let chunk = null
        try {
          const j = JSON.parse(raw)
          chunk = j.choices?.[0]?.delta?.content
        } catch {
          continue
        }
        if (typeof chunk !== 'string' || chunk === '') continue
        const buf = Buffer.from(chunk, 'base64')
        if (buf.length === 0) continue
        if (firstAt === 0) firstAt = Date.now() - t0
        // base64 inside the line: see speak-worker.ps1 for why raw bytes are unsafe
        this.child.stdin.write('CHUNK64|' + buf.toString('base64') + '\n')
        bytes += buf.length
      }
    }
    const doneLine = await this.finishCurrent()
    const durationMs = Math.round((bytes / GLM_BYTES_PER_SEC) * 1000)
    return {
      provider: 'glm',
      ttfaMs: firstAt,
      synthMs: Date.now() - t0,
      bytes,
      durationMs,
      workerDur: Number(String(doneLine).split('|')[1]) || 0,
    }
  }

  // ---- MiniMax T2A v2 ---------------------------------------------------
  //
  // Measured on this machine: the endpoint answers in ~270ms with an auth error,
  // so reachability is fine and a key is the only missing piece. T2A returns hex
  // PCM (or a hex MP3) inside JSON, and with stream:true it emits SSE frames per
  // sentence - the same shape as glm-tts, so the PCM path already fits.

  async speakMinimax(text, emotion) {
    const mm = this.tts.minimax || {}
    if (!mm.apiKey) throw new Error('minimax: no apiKey')
    const group = mm.groupId ? '?GroupId=' + encodeURIComponent(mm.groupId) : ''
    const url = String(mm.baseUrl || 'https://api.minimax.chat').replace(/\/+$/, '') + '/v1/t2a_v2' + group
    const format = mm.format || 'pcm'
    const body = {
      model: mm.model || 'speech-2.8-turbo',
      text,
      stream: true,
      voice_setting: {
        voice_id: mm.voiceId || 'Chinese (Mandarin)_BashfulGirl',
        speed: mm.speed ?? 1.0,
        vol: mm.vol ?? 1,
        pitch: mm.pitch ?? 2,
        // Measured on speech-2.8-hd: happy/sad/angry/fearful/disgusted/
        // surprised/neutral all accept, and they genuinely change delivery
        // (the same line ran 1.8s angry vs 3.4s fearful).
        ...(emotion && emotion !== 'auto' ? { emotion } : {}),
      },
      audio_setting: {
        sample_rate: GLM_PCM_RATE,
        bitrate: mm.bitrate || 128000,
        format,
        channel: 1,
      },
    }
    const t0 = Date.now()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + mm.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.tts.timeoutMs ?? 60000),
    })
    if (res.status !== 200) {
      const detail = await res.text().catch(() => '')
      const err = new Error('minimax HTTP ' + res.status + ' ' + detail.slice(0, 160))
      err.status = res.status
      throw err
    }

    const open = this.nextLine(15000, 'pcm open')
    this.child.stdin.write('PCMOPEN|' + GLM_PCM_RATE + '|' + GLM_PCM_BITS + '|' + GLM_PCM_CHANNELS + '|' + (this.appendNext ? '1' : '0') + '\n')
    this.appendNext = false
    await open

    const dec = new TextDecoder()
    const reader = res.body.getReader()
    let acc = ''
    let bytes = 0
    let firstAt = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += dec.decode(value, { stream: true })
      let nl
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl).trim()
        acc = acc.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (raw === '' || raw === '[DONE]') continue
        let hex = null
        let finalInfo = null
        try {
          const j = JSON.parse(raw)
          hex = j.data && j.data.audio
          // The terminal frame carries extra_info AND re-sends the whole
          // utterance from the beginning: measured on three lengths, summed
          // bytes came out at exactly 2x the declared audio_length. Playing it
          // again would repeat every line, so it is metadata only.
          if (j.extra_info && j.extra_info.audio_length) finalInfo = j.extra_info
        } catch {
          continue
        }
        if (finalInfo) { this.minimaxInfo = finalInfo; continue }
        if (typeof hex !== 'string' || hex.length < 4) continue
        const buf = Buffer.from(hex, 'hex')
        if (buf.length === 0) continue
        if (firstAt === 0) firstAt = Date.now() - t0
        // base64 inside the line: see speak-worker.ps1 for why raw bytes are unsafe
        this.child.stdin.write('CHUNK64|' + buf.toString('base64') + '\n')
        bytes += buf.length
      }
    }
    const doneLine = await this.finishCurrent()
    return {
      provider: 'minimax',
      workerDur: Number(String(doneLine || '').split('|')[1]) || 0,
      ttfaMs: firstAt,
      synthMs: Date.now() - t0,
      bytes,
      durationMs: Math.round((bytes / GLM_BYTES_PER_SEC) * 1000),
    }
  }

  // ---- OpenAI-compatible /v1/audio/speech -------------------------------
  //
  // SiliconFlow, DashScope's compatible mode and most domestic vendors expose
  // this shape: { model, input, voice, speed, response_format }. Cheap, keyed,
  // and no handshake games - the intended primary once a key exists.

  async speakOpenAI(text, file) {
    const o = this.tts.openai || {}
    if (!o.apiKey) throw new Error('openai-tts: no apiKey')
    const base = String(o.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    const fmt = o.format || 'mp3'
    const model = o.model || 'FunAudioLLM/CosyVoice2-0.5B'
    const res = await fetch(base + '/audio/speech', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + o.apiKey,
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: openaiVoice(o.voice, base, model),
        speed: o.speed ?? 1.1,
        response_format: fmt,
      }),
      signal: AbortSignal.timeout(this.tts.timeoutMs ?? 60000),
    })
    if (res.status !== 200) {
      const detail = await res.text().catch(() => '')
      const err = new Error('openai-tts HTTP ' + res.status + ' ' + detail.slice(0, 160))
      err.status = res.status
      throw err
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const target = fmt === 'wav' ? file.replace(/\.mp3$/, '.wav') : file
    await new Promise((resolve, reject) => {
      const out = createWriteStream(target)
      out.on('error', reject)
      out.on('close', resolve)
      out.end(buf)
    })
    await this.playFile(target)
    let durationMs = 0
    if (fmt === 'wav' && buf.length > 44) durationMs = Math.round((buf.readUInt32LE(40) / 48000) * 1000)
    else durationMs = Math.round((buf.length * 8) / 48)
    return { provider: 'openai-tts', synthMs: 0, durationMs, bytes: buf.length }
  }

  // ---- Azure Speech (paid, same voices Edge borrows) --------------------
  //
  // Edge's free read-aloud endpoint serves Microsoft's own neural voices; Azure
  // sells exactly the same voices with a key and an SLA. When a key is present
  // this is the provider to use: identical timbre to what the user picked, no
  // handshake games, no 429 surprises.

  async speakAzure(text, file) {
    const az = this.tts.azure || {}
    if (!az.apiKey) throw new Error('azure: no apiKey')
    const region = az.region || 'eastasia'
    const fmt = az.format || 'audio-24khz-48kbitrate-mono-mp3'
    const base = 'https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1'
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': az.apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': fmt,
        'User-Agent': 'dsh-watch-eyes',
      },
      body: this.ssml(text),
      signal: AbortSignal.timeout(this.tts.timeoutMs ?? 60000),
    })
    if (res.status !== 200) {
      const detail = await res.text().catch(() => '')
      const err = new Error('azure HTTP ' + res.status + ' ' + detail.slice(0, 160))
      err.status = res.status
      throw err
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await new Promise((resolve, reject) => {
      const out = createWriteStream(file)
      out.on('error', reject)
      out.on('close', resolve)
      out.end(buf)
    })
    await this.playFile(file)
    let durationMs = 0
    try {
      durationMs = Math.round((buf.length * 8) / 48)
    } catch { /* keep 0 */ }
    return { provider: 'azure', synthMs: 0, durationMs, bytes: buf.length }
  }

  // ---- Edge (fallback) --------------------------------------------------

  ssml(text) {
    const esc = String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    return (
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' +
      this.voice.slice(0, 5) +
      '"><voice name="' +
      this.voice +
      '"><prosody rate="' +
      this.prosody.rate +
      '" pitch="' +
      this.prosody.pitch +
      '" volume="' +
      this.prosody.volume +
      '">' +
      esc +
      '</prosody></voice></speak>'
    )
  }

  async connectEngine() {
    const mod = await import('msedge-tts')
    const now = Date.now()
    if (now < this.blockedUntil) await sleep(this.blockedUntil - now)
    let lastError = null
    for (let i = 0; i < CONNECT_TRIES; i++) {
      const engine = new mod.MsEdgeTTS()
      try {
        await engine.setMetadata(this.voice, mod.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        this.engine = engine
        this.blockedUntil = 0
        this.connectFails = 0
        return
      } catch (e) {
        lastError = e
        try { engine.close() } catch { /* already dead */ }
        this.connectFails += 1
        const limited = /\b429\b/.test(String(e && e.message))
        const wait = limited
          ? Math.min(60000, 2000 * Math.pow(2, this.connectFails - 1)) + Math.round(Math.random() * 1500)
          : 400
        this.blockedUntil = Date.now() + wait
        await sleep(wait)
      }
    }
    throw lastError ?? new Error('edge tts connect failed')
  }

  dropEngine() {
    try { this.engine?.close() } catch { /* already dead */ }
    this.engine = null
  }

  async speakEdge(text, file) {
    if (!this.engine) await this.connectEngine()
    const { audioStream } = await this.engine.rawToStream(this.ssml(text))
    await new Promise((resolve, reject) => {
      const out = createWriteStream(file)
      const timer = setTimeout(() => reject(new Error('synth timeout')), 20000)
      audioStream.on('error', (e) => { clearTimeout(timer); reject(e) })
      out.on('error', (e) => { clearTimeout(timer); reject(e) })
      out.on('close', () => { clearTimeout(timer); resolve(true) })
      audioStream.pipe(out)
    })
    await this.playFile(file)
    let durationMs = 0
    try {
      // CBR mono MP3 at 48 kbps: 8 bits per millisecond.
      durationMs = Math.round((statSync(file).size * 8) / 48)
    } catch { /* keep 0 */ }
    return { provider: 'edge', synthMs: 0, durationMs }
  }

  // ---- public -----------------------------------------------------------

  async ready() {
    await this.startWorker()
    this.startKeepalive()
  }

  // A socket nobody talks on for minutes can be closed by either side; the next
  // real line would then pay a whole reconnect (and risk a 429) right when the
  // user is waiting to hear something.
  startKeepalive() {
    if (this.keepaliveTimer) return
    this.keepaliveTimer = setInterval(() => {
      if (!this.engine) return
      if (Date.now() - (this.lastSynthAt || 0) < 240000) return
      this.engine
        .rawToStream(this.ssml('。'))
        .then(({ audioStream }) => { audioStream.on('data', () => {}); audioStream.resume() })
        .catch((e) => { log('tts keepalive failed: ' + String(e && e.message)); this.dropEngine() })
    }, 60000)
    this.keepaliveTimer.unref?.()
  }

  // tts.minimax.emotion: a fixed id, 'auto' to read the line, or 'off' to let
  // the voice stay neutral.
  emotionFor(text) {
    const mode = this.tts.minimax?.emotion ?? 'auto'
    if (mode === 'off') return null
    if (mode !== 'auto') return mode
    return pickEmotion(text)
  }

  async say(text) {
    const clean = String(text || '').trim()
    if (clean === '') return { spoken: false, reason: 'empty' }
    // Every utterance carries the generation it started in. stop() bumps it, so
    // a line that was interrupted can tell that it lost and must NOT claim the
    // mouth (its lastText/endsAt would otherwise describe audio the user never
    // heard, and the avatar would animate a line that was already cut).
    this.generation = (this.generation || 0)
    const gen = this.generation
    const abandoned = () => this.generation !== gen
    await this.ready()
    if (abandoned()) return { spoken: false, reason: 'interrupted-before-start', text: clean }
    // Was this call a continuation of the previous utterance? Read it BEFORE the
    // providers run, because opening the PCM stream consumes the flag.
    const wasAppend = !!this.appendNext
    mkdirSync(AUDIO_DIR, { recursive: true })
    const dir = join(AUDIO_DIR, this.dirName())
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'audio.mp3')
    this.lastSynthAt = Date.now()
    const t0 = Date.now()
    let info = null
    // Azure (same Xiaoyi voice) > glm-tts > Edge. Each later entry is a real
    // downgrade in timbre, so the order is deliberate.
    // Azure and domestic keyed vendors carry a real neural voice; glm-tts is the
    // current stopgap; Edge is last because its free endpoint now refuses most
    // handshakes.
    const preferred = this.tts.provider || 'auto'
    const order =
      preferred === 'minimax'
        ? ['minimax', 'openai-tts', 'azure', 'glm', 'edge']
        : preferred === 'openai'
          ? ['openai-tts', 'minimax', 'azure', 'glm', 'edge']
          : ['minimax', 'openai-tts', 'azure', 'glm', 'edge']
    const errors = []
    for (const provider of order) {
      // A plain network reset is common on this endpoint and costs nothing to
      // retry: nothing has been spoken yet, so the user hears one extra pause.
      const tries = provider === 'glm' || provider === 'minimax' ? 2 : 1
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          if (provider === 'azure') {
            if (!this.tts.azure || !this.tts.azure.apiKey) throw new Error('azure: not configured')
            info = await this.speakAzure(clean, file)
          } else if (provider === 'openai-tts') {
            if (!this.tts.openai || !this.tts.openai.apiKey) throw new Error('openai-tts: not configured')
            info = await this.speakOpenAI(clean, file)
          } else if (provider === 'minimax') {
            if (!this.tts.minimax || !this.tts.minimax.apiKey) throw new Error('minimax: not configured')
            info = await this.speakMinimax(clean, this.emotionFor(clean))
          } else if (provider === 'glm') {
            info = await this.speakGlm(clean)
          } else {
            info = await this.speakEdge(clean, file)
          }
          break
        } catch (e) {
          const transient = /fetch failed|ECONNRESET|socket hang up|terminated/i.test(String(e && e.message))
          errors.push(provider + (attempt > 1 ? '#' + attempt : '') + ': ' + String(e && e.message).slice(0, 120))
          log('tts ' + provider + ' failed: ' + String(e && e.message))
          if (provider === 'edge') this.dropEngine()
          try { this.child.stdin.write('STOP\n') } catch { /* best effort */ }
          if (!transient || attempt === tries) break
          await sleep(300 + Math.round(Math.random() * 300))
        }
      }
      if (info) break
    }
    if (!info) {
      this.spoken += 0
      return { spoken: false, reason: 'all providers failed', errors }
    }
    // The line was cut while it was still being synthesised. Its audio already
    // went to the worker and was stopped there; claiming the mouth now would
    // hand the avatar a clock for sound nobody heard.
    if (abandoned()) return { spoken: false, reason: 'interrupted', text: clean }
    const synthMs = info.synthMs ?? (Date.now() - t0)
    const durationMs = info.durationMs || 0
    // A continuation EXTENDS the clock; it does not restart it.
    //
    // Chunks of one reply are concatenated in the worker's single PCM buffer, so
    // the audio that is still to be heard is (previous remainder + this piece).
    // Setting endsAt = now + duration described only the last piece: measured, a
    // 7.1s reply reported a 1.0s clock and the avatar stopped moving early.
    if (wasAppend) {
      const prevRemain = Math.max(0, (this.speakEndsAt || 0) - Date.now())
      this.speakEndsAt = Date.now() + prevRemain + durationMs
    } else {
      this.speakStartedAt = t0 + (info.ttfaMs || synthMs)
      this.speakEndsAt = Date.now() + Math.max(0, durationMs - (info.ttfaMs || 0))
    }
    this.spoken += 1
    this.lastText = clean
    this.lastDurationMs = durationMs
    this.trim()
    return {
      spoken: true,
      text: clean,
      provider: info.provider,
      ttfaMs: info.ttfaMs ?? null,
      synthMs,
      durationMs,
      voice:
        info.provider === 'minimax'
          ? (this.tts.minimax && this.tts.minimax.voiceId) || 'minimax'
          : info.provider === 'glm' || info.provider === 'openai-tts'
            ? this.tts.voice || this.tts.openai?.voice || 'female'
            : this.voice,
      azureConfigured: !!(this.tts.azure && this.tts.azure.apiKey),
      startedAt: this.speakStartedAt,
      endsAt: this.speakEndsAt,
    }
  }

  // Live state for lipsync / Live2D. Polled by the avatar, so keep it cheap.
  state() {
    const now = Date.now()
    const ends = this.speakEndsAt || 0
    return {
      speaking: ends > now,
      text: ends > now ? this.lastText : null,
      voice: this.voice,
      provider: this.tts.provider,
      startedAt: this.speakStartedAt || 0,
      endsAt: ends,
      remainingMs: Math.max(0, ends - now),
      elapsedMs: this.speakStartedAt ? Math.max(0, Math.min(now, ends) - this.speakStartedAt) : 0,
      spoken: this.spoken,
      lastDurationMs: this.lastDurationMs,
    }
  }

  trim() {
    try {
      const dirs = readdirSync(AUDIO_DIR)
        .filter((d) => d.startsWith('u'))
        .map((d) => ({ d, m: statSync(join(AUDIO_DIR, d)).mtimeMs }))
      dirs.sort((a, b) => b.m - a.m)
      for (const extra of dirs.slice(KEEP_UTTERANCES)) rmSync(join(AUDIO_DIR, extra.d), { recursive: true, force: true })
    } catch {
      /* housekeeping must never break speech */
    }
  }

  // Cut the current utterance. Returns once the worker has actually stopped, so
  // a caller that interrupts and immediately speaks again cannot have the old
  // audio tail bleeding into the new line.
  //
  // Registers a waiter: STOPPED used to land as an unclaimed line and get handed
  // to whatever wait was next in the queue - which shifted every later answer by
  // one and made a whole line time out.
  // Cut the current utterance.
  //
  // The generation bump happens HERE and synchronously, before the worker is
  // asked to stop. Bumping it after the await was a real bug: a caller that cut
  // and immediately spoke again captured the OLD generation, then the late bump
  // landed and the brand-new line declared itself interrupted and never played.
  // Order matters: invalidate first, then silence.
  cut() {
    this.generation = (this.generation || 0) + 1
    this.speakEndsAt = Date.now() - 1
    this.lastText = null
    if (!this.child) return Promise.resolve({ stopped: false, reason: 'no worker' })
    const p = this.nextLine(4000, 'stop')
    try {
      this.child.stdin.write('STOP\n')
    } catch {
      return Promise.resolve({ stopped: false, reason: 'worker gone' })
    }
    // A slow worker is not an error here: the next line still plays.
    return p.then(
      () => ({ stopped: true }),
      () => ({ stopped: true, slow: true }),
    )
  }

  async stop() {
    return await this.cut()
  }
}

export async function listVoices() {
  const mod = await import('msedge-tts')
  try {
    const engine = new mod.MsEdgeTTS()
    const v = await engine.getVoices()
    engine.close()
    return v
  } catch (e) {
    return { error: String(e && e.message) }
  }
}