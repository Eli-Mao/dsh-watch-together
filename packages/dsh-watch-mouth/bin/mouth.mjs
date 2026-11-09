#!/usr/bin/env node
// Standalone CLI so the mouth is usable without a dsh restart.
import { call, ensureDaemon, qs } from '../lib/client.mjs'
import { CONFIG_PATH, DEFAULT_PORT, loadConfig, saveConfig, zhipuFor } from '../lib/shared.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const flags = {}
const positional = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1 } else { flags[key] = '1' }
  } else positional.push(a)
}
const json = (v) => process.stdout.write(JSON.stringify(v, null, 1) + '\n')

try {
  if (cmd === 'say') {
    const text = positional.join(' ')
    if (!text) throw new Error('usage: mouth say "要念的话"')
    json(await call('/say' + qs({ text }), 90000))
  } else if (cmd === 'said') {
    json(await call('/said', 10000))
  } else if (cmd === 'mouth') {
    json(await call('/mouth', 5000))
  } else if (cmd === 'voice') {
    // What will actually come out of the speakers, and what it costs.
    const cfg = loadConfig()
    const t = cfg.tts || {}
    const configured = {
      minimax: !!(t.minimax && t.minimax.apiKey),
      openai: !!(t.openai && t.openai.apiKey),
      azure: !!(t.azure && t.azure.apiKey),
      glm: !!zhipuFor(cfg).apiKey,
      edge: true,
    }
    const order = t.provider === 'openai'
      ? ['openai', 'minimax', 'azure', 'glm', 'edge']
      : ['minimax', 'openai', 'azure', 'glm', 'edge']
    const willUse = order.find((k) => configured[k]) || 'edge'
    json({
      configuredProvider: t.provider || 'auto',
      keysPresent: configured,
      willUse,
      voice: t.voice,
      note: willUse === 'edge'
        ? 'Edge is free and needs no key, but Microsoft may refuse the handshake; a keyed vendor is more reliable'
        : 'using a keyed vendor: per-character cost',
      setup: {
        ownVendor: 'mouth config set tts.openai.baseUrl / .apiKey / .model / .voice (any OpenAI-compatible /v1/audio/speech)',
        minimax: 'mouth config set tts.minimax.apiKey and tts.minimax.groupId',
        edge: 'no setup: works with no key at all',
      },
    })
  } else if (cmd === 'devices') {
    json(await call('/devices', 40000))
  } else if (cmd === 'status') {
    json(await ensureDaemon())
  } else if (cmd === 'stop') {
    try { json(await call('/stop', 5000)) } catch { json({ stopped: 'already down' }) }
  } else if (cmd === 'config') {
    const cfg = loadConfig()
    if (positional[0] === 'set') {
      const dotted = positional[1]
      const value = positional.slice(2).join(' ')
      if (!dotted) throw new Error('usage: mouth config set <dotted.key> <value>')
      const parts = dotted.split('.')
      let node = cfg
      for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] = node[parts[i]] ?? {}; node = node[parts[i]] }
      const last = parts[parts.length - 1]
      if (value === 'true') node[last] = true
      else if (value === 'false') node[last] = false
      else if (value === 'null') node[last] = null
      else if (value !== '' && !Number.isNaN(Number(value)) && /^-?[0-9.]+$/.test(value)) node[last] = Number(value)
      else node[last] = value
      saveConfig(cfg)
      json({ saved: dotted, value: node[last], configPath: CONFIG_PATH })
    } else json(cfg)
  } else {
    process.stdout.write([
      'dsh-watch-mouth',
      '',
      '  mouth say "要念的话"        # 直接朗读一句',
      '  mouth said                  # 最近说过什么（耳朵用它剔掉自己的回声）',
      '  mouth mouth                 # 当前口型时钟（Live2D 轮询用）',
      '  mouth devices               # 播放设备表 + 语音当前走哪个',
      '  mouth status | stop | config [set <dotted.key> <value>]',
      '',
      '  port ' + DEFAULT_PORT + ' (config: ' + CONFIG_PATH + ')',
      '',
    ].join('\n'))
  }
} catch (e) {
  process.stderr.write('mouth: ' + String((e && e.message) || e) + '\n')
  process.exit(1)
}
