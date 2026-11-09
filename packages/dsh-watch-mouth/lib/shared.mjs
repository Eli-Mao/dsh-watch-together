// dsh-watch-mouth shared paths, config load/save, logging. Node builtins only.
//
// The mouth is deliberately independent of the eyes: it owns synthesis and
// playback only, so the avatar can keep talking while the capture worker is
// being restarted, and the eyes daemon no longer carries a 30KB TTS stack it
// never used for anything but speaking.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATE_DIR = join(homedir(), '.dsh-watch-mouth')
// Data (recordings, screenshots, frames) is a per-run artefact, not a setting,
// but a published plugin cannot assume a workspace path that only exists on the
// machine it was written on. It lives beside the config, and the env var moves
// it for anyone who wants it elsewhere.
export const DATA_DIR = process.env.DSH_MOUTH_DATA || join(STATE_DIR, 'data')
export const CONFIG_PATH = join(STATE_DIR, 'config.json')
export const LOG_PATH = join(STATE_DIR, 'daemon.log')
export const PID_PATH = join(STATE_DIR, 'daemon.pid')
export const DEFAULT_PORT = 37716

export function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
}

// Read a JSON file that may carry a UTF-8 BOM.
//
// PowerShell's `Set-Content -Encoding UTF8` on Windows PowerShell 5.1 writes a
// BOM, and a user editing config.json in Notepad may too. JSON.parse rejects
// the leading U+FEFF, and the loader then silently falls back to DEFAULTS -
// so "I set the port/key and it ignored me" is the symptom, with no error
// logged anywhere the user would look.
function readJson(file) {
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
}

// Append one line, rotating first if the file has grown past `MAX_LOG_BYTES`.
//
// These logs are append-only and nobody prunes them: the browser daemon's log
// reached 13.9 MB, and a 429 storm or a capture loop can add a line per frame.
// A log that big is not read carefully, it is skipped - which is the same as not
// having one. Rotation keeps the last ~2 MB and one previous file, which is
// enough to explain an outage and small enough to open.
const MAX_LOG_BYTES = 2 * 1024 * 1024

function rotateIfBig() {
  try {
    const st = statSync(LOG_PATH)
    if (st.size < MAX_LOG_BYTES) return
    // Keep exactly one generation: .1 is the previous file, overwritten each
    // time. A dated chain of archives would need a policy for deleting them,
    // and there is no operator here to run one.
    renameSync(LOG_PATH, LOG_PATH + '.1')
  } catch {
    /* no file yet, or a rename race with another writer: appending still works */
  }
}

export function log(line) {
  try {
    ensureStateDir()
    rotateIfBig()
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* diagnostics must never break a spoken line */
  }
}

export function defaultConfig() {
  return {
    port: DEFAULT_PORT,
    // Xiaoyi + a little speed/height: Xiaoxiao reads like a news anchor here.
    voice: 'zh-CN-XiaoyiNeural',
    prosody: { rate: '+15%', pitch: '+8Hz', volume: '100' },
    // Azure sells the exact voices Edge lends out for free (Xiaoyi included).
    // Fill tts.azure.apiKey to make it primary; until then MiniMax carries the
    // voice and Edge is only a last resort.
    tts: {
      // Which synthesiser to use: 'auto' | 'minimax' | 'openai' | 'azure' | 'glm' | 'edge'
      //
      // 'auto' tries them in cost order and uses the first one that has a key,
      // falling back to Edge (free, no key). A specific value pins it: useful
      // when a user brings their OWN vendor and does not want anything else
      // tried first.
      provider: 'auto',
      // Set by the user to name their own OpenAI-compatible endpoint. Any
      // vendor that speaks /v1/audio/speech works; the defaults below are only
      // examples, not a preference.
      baseUrlExample: 'https://api.siliconflow.cn/v1',
      voiceExample: 'FunAudioLLM/CosyVoice2-0.5B:anna',
      model: 'glm-tts',
      voice: 'female',
      speed: 1.1,
      timeoutMs: 60000,
      azure: { apiKey: '', region: 'eastasia', format: 'audio-24khz-48kbitrate-mono-mp3' },
      // MiniMax T2A v2: hex-PCM over SSE, same streaming shape as glm-tts.
      minimax: {
        apiKey: '',
        groupId: '',
        baseUrl: 'https://api.minimaxi.com',
        model: 'speech-2.8-turbo',
        voiceId: 'Chinese (Mandarin)_BashfulGirl',
        speed: 1.1,
        vol: 1,
        pitch: 3,
        emotion: 'auto',
        format: 'pcm',
        bitrate: 128000,
      },
      // Any OpenAI-compatible /v1/audio/speech vendor: SiliconFlow, DashScope
      // compat mode, Minimax-compatible gateways. Fill apiKey + voice.
      openai: {
        apiKey: '',
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        // SiliconFlow preset voices are named per model ("<model>:<voice>").
        voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',
        speed: 1.1,
        format: 'mp3',
      },
    },
    // Route this program's own speech (and nothing else) into a named playback
    // device. Empty name = system default, which is also what keeps other apps
    // out of the mixer: never change the Windows default device to do this.
    output: {
      deviceName: '',
      deviceNumber: null,
    },
  }
}

// TTS vendors need a key, and a fresh install has an empty config. Read the
// environment first so a headless install can be configured without editing
// JSON by hand; the values land in the config on first run and stay there.
function seedTtsFromEnv(cfg) {
  const minimax = process.env.MINIMAX_API_KEY || ''
  const sil = process.env.SILICONFLOW_API_KEY || ''
  const azure = process.env.AZURE_SPEECH_KEY || ''
  if (minimax) { cfg.tts.provider = 'minimax'; cfg.tts.minimax.apiKey = minimax }
  if (cfg.tts.minimax.groupId === '' && process.env.MINIMAX_GROUP_ID) cfg.tts.minimax.groupId = process.env.MINIMAX_GROUP_ID
  if (sil) cfg.tts.openai.apiKey = sil
  if (azure) cfg.tts.azure.apiKey = azure
  return cfg
}

// Providers need their keys somewhere. The mouth does not call any model, but it
// does call speech vendors, and those keys historically live in the eyes config.
// Import them once on first run so a fresh install speaks without a second
// place to paste a key - after that the mouth owns its own config.
function seedFromEyes(cfg) {
  try {
    const eyes = join(homedir(), '.dsh-watch-eyes', 'config.json')
    if (!existsSync(eyes)) return cfg
    const j = readJson(eyes)
    if (j.output && cfg.output.deviceName === '' && j.output.deviceName) cfg.output = { ...cfg.output, ...j.output }
    const t = j.tts || {}
    for (const k of ['provider', 'model', 'voice', 'speed']) if (t[k] !== undefined && cfg.tts[k] === undefined) cfg.tts[k] = t[k]
    for (const k of ['azure', 'minimax', 'openai']) if (t[k] && !cfg.tts[k]?.apiKey) cfg.tts[k] = { ...cfg.tts[k], ...t[k] }
    return cfg
  } catch {
    return cfg
  }
}

export function loadConfig() {
  const base = defaultConfig()
  try {
    if (!existsSync(CONFIG_PATH)) {
      const seeded = seedTtsFromEnv(seedFromEyes(base))
      saveConfig(seeded)
      return seeded
    }
    const user = readJson(CONFIG_PATH)
    return {
      ...base,
      ...user,
      prosody: { ...base.prosody, ...(user.prosody ?? {}) },
      output: { ...base.output, ...(user.output ?? {}) },
      tts: {
        ...base.tts,
        ...(user.tts ?? {}),
        azure: { ...base.tts.azure, ...((user.tts ?? {}).azure ?? {}) },
        openai: { ...base.tts.openai, ...((user.tts ?? {}).openai ?? {}) },
        minimax: { ...base.tts.minimax, ...((user.tts ?? {}).minimax ?? {}) },
      },
    }
  } catch (e) {
    log('config load failed, using defaults: ' + String(e && e.message))
    return base
  }
}

export function saveConfig(cfg) {
  ensureStateDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}
