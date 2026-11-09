// dsh-watch-ears host half: hearing tools.
//
// Registration stays a plain descriptor object so this file needs nothing but
// its own modules. All the work happens in the resident daemon, which keeps the
// PowerShell capture workers and the listening loop running between tool calls.
import { call, ensureDaemon, qs } from './client.mjs'
import { CONFIG_PATH } from './shared.mjs'
import { Pusher } from './push.mjs'

// Pushers are named, not singular. Two sessions on one host (watching a video
// here, tuning a voice project there) each need their own target, and a single
// host-wide pusher made the second start silently take over the first.
const pushers = new Map()
let ctxRef = null
function getPusher(ctx, id) {
  const key = String(id || 'default')
  if (!pushers.has(key)) pushers.set(key, new Pusher(ctx, { id: key }))
  return pushers.get(key)
}

export const name = 'dsh-watch-ears'
// 'agents' and 'subagents' are required for watch_push: the inbox delivery
// seam lives on them, and cordis refuses to hand over an undeclared service
// ("cannot get property without inject"). Same set AgentTeams declares.
export const inject = ['tools', 'agents', 'subagents']

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} }
const text = (s) => [{ type: 'text', text: s }]

function renderLines(lines, empty) {
  if (!Array.isArray(lines) || lines.length === 0) return empty
  return lines.map((l) => String(l.at).slice(11, 19) + '  [' + (l.source === 'mic' ? '我' : '视频') + ']  ' + l.text).join('\n')
}

const hearNowTool = {
  name: 'hear_now',
  description:
    'Listen to the room right now for a few seconds and return what was said. source=loop hears what the computer is playing (a video, a call); source=mic hears the person at the microphone. Use it when the user asks whether you can hear something, or to transcribe a short spoken message. For continuous listening use hearing action=start.',
  parameters: {
    type: 'object',
    properties: {
      seconds: { type: 'number', description: 'How long to listen (1-25, default 6).' },
      source: { type: 'string', enum: ['loop', 'mic'], description: 'loop = system audio (default), mic = microphone.' },
      prompt: { type: 'string', description: 'Optional context hint passed to the recogniser.' },
    },
    required: [],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (v && v.text) return text('[' + v.source + '] ' + v.text)
      // Speech was there but could not be transcribed: that is a failure, not
      // silence, and calling it silence sends the reader after the microphone.
      if (v && v.error) return text('(' + v.source + ' 识别失败：' + v.error + ')')
      return text('(' + (v && v.source) + ' 静音，peak ' + (v && v.peak) + ')')
    },
  },
  timeoutMs: 180000,
  isConcurrencySafe: () => false,
  async execute(args) {
    return await call('/hear' + qs({ source: args?.source, seconds: args?.seconds, prompt: args?.prompt }), 170000)
  },
}

const hearRecentTool = {
  name: 'hear_recent',
  description:
    'Read back what the resident listener has heard recently, split by source: [视频] is what the computer played, [我] is what the person said. Use it to catch up after a pause, or to find out whether the user has said anything since you last replied.',
  parameters: {
    type: 'object',
    properties: { seconds: { type: 'number', description: 'How far back to look (default 300 seconds).' } },
    required: [],
  },
  output: { schema: OUTPUT_SCHEMA, render: (_a, v) => text(renderLines(v && v.lines, '没有听到任何内容（监听未开启，或这段时间是静音）')) },
  timeoutMs: 60000,
  isConcurrencySafe: () => true,
  async execute(args) {
    return await call('/heard' + qs({ seconds: args?.seconds }), 45000)
  },
}

const hearingTool = {
  name: 'hearing',
  description:
    'Control continuous hearing. While it runs the resident daemon keeps recording and transcribing BOTH the system audio and the microphone, with no agent turn in the loop, so nothing is missed while you are thinking. action=start begins it, action=stop ends it, action=status reports live counters and the last lines heard.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start, stop or status.' },
      segment: { type: 'number', description: 'Seconds per transcription segment (2-25, default 6). Shorter is more responsive and costs slightly more.' },
      sources: { type: 'string', description: 'Comma separated: loop (system audio), mic (microphone). Default both.' },
    },
    required: ['action'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => {
      if (!v) return text('no result')
      const s = v.stats ?? {}
      const head = 'hearing ' + (v.running ? 'RUNNING' : 'stopped') + ' sources=[' + (v.sources ?? []).join(',') + '] segment=' + v.segmentSeconds + 's' +
        '  segments=' + (s.segments ?? 0) + ' skipped=' + (s.skipped ?? 0) + ' transcribed=' + (s.transcribed ?? 0) + ' errors=' + (s.errors ?? 0) +
        (v.error ? '  (last error: ' + v.error + ')' : '')
      const body = renderLines(v.last, '')
      return text(body ? head + '\n' + body : head)
    },
  },
  timeoutMs: 150000,
  isConcurrencySafe: () => false,
  async execute(args) {
    const action = args && args.action
    if (action === 'start') return await call('/listen/start' + qs({ segment: args.segment, sources: args.sources }), 140000)
    if (action === 'stop') return await call('/listen/stop', 90000)
    return await call('/listen/status', 90000)
  },
}

const pushTool = {
  name: 'watch_push',
  description:
    'Wake a session only when something is actually worth reacting to. While it runs, the host polls the ears digest every few seconds and, on a salient event (the user spoke, or the video moved on), splices a compact message into the target session inbox so that session runs one small turn and decides whether to speak. This is the always-listening / occasionally-speaking mode: it costs a fraction of a reminder loop because the target is woken by events, not by a clock. action=probe first if delivery ever fails; it reports the live host API.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'status', 'probe'], description: 'start, stop, status, or probe (diagnose the host delivery API).' },
      id: { type: 'string', description: 'Name of this pusher (default "default"). Use a distinct name per session so two sessions can run at once; omitting it on stop/status acts on "default".' },
      watcherPrompt: { type: 'string', description: 'Only for action=start with no target: the prompt for the watcher this call spawns.' },
      target: { type: 'string', description: 'Session id to wake (usually a subagent you spawned).' },
      parent: { type: 'string', description: 'Optional parent session id if auto-resolution fails.' },
      every: { type: 'number', description: 'Poll seconds (2-60, default 4).' },
      micOnly: { type: 'boolean', description: 'Only wake when the user speaks (ignore video).' },
      bell: {
        type: 'boolean',
        description: 'The target is a silent bell (a subagent that does nothing). The push then carries no speaking instruction, so the bell only ends its turn and the parent session is woken. Use this for the single-memory architecture.',
      },
      mode: {
        type: 'string',
        enum: ['video', 'screen'],
        description: 'What to watch. video = the page <video> plus burned-in subtitles (an episode). screen = the foreground window, no subtitles (anything else). Mutually exclusive.',
      },
      videoEvery: { type: 'number', description: 'Minimum seconds between video-driven wakes (10-600, default 120). Every wake costs the target session a full turn, so this is the main cost dial.' },
    },
    required: ['action'],
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_a, v) => [{ type: 'text', text: renderPush(v) }],
  },
  timeoutMs: 60000,
  isConcurrencySafe: () => true,
  async execute(args, exec) {
    const action = args && args.action
    const p = getPusher(ctxRef, args && args.id)
    if (exec) p.callerAgent = exec.agent ?? exec.caller ?? p.callerAgent
    if (action === 'probe') return probeHost(ctxRef)
    if (action === 'start') return p.start(args)
    if (action === 'stop') return p.stop()
    const st = p.status()
    st.others = [...pushers.keys()].filter((k) => k !== p.id)
    return st
  },
}

function probeHost(ctx) {
  const out = { hasContext: !!ctx, subagentsKeys: [], agentsKeys: [], methods: {}, liveAgents: [] }
  try {
    const s = ctx && ctx.subagents
    if (s) out.subagentsKeys = Object.keys(s)
    out.methods = {
      followup: typeof (s && s.followup),
      deliver: typeof (s && s.deliver),
      queue: typeof (s && s.queue),
      sendMessage: typeof (s && s.sendMessage),
      steer: typeof (s && s.steer),
    }
  } catch (e) { out.subagentsError = String(e && e.message) }
  try {
    const a = ctx && ctx.agents
    if (a) out.agentsKeys = Object.keys(a)
    if (a && typeof a.list === 'function') {
      out.liveAgents = a.list().slice(0, 12).map((ag) => ({
        id: String((ag && ag.session && ag.session.id) || ''),
        parent: String((ag && ag.session && ag.session.header && ag.session.header.parentSession) || ''),
        status: String((ag && ag.status) || ''),
      }))
    }
  } catch (e) { out.agentsError = String(e && e.message) }
  // The host validates tool output as lossless JSON; a live Agent or a branded
  // session id is neither, so round-trip through JSON before returning.
  try { return JSON.parse(JSON.stringify(out)) } catch { return { error: 'probe produced non-serialisable data' } }
}

function renderPush(v) {
  if (!v) return 'no result'
  if (v.subagentsKeys) {
    return [
      'host probe',
      '  subagents methods: ' + JSON.stringify(v.methods),
      '  subagents keys: ' + (v.subagentsKeys || []).join(', '),
      '  agents keys: ' + (v.agentsKeys || []).join(', '),
      '  live agents:',
    ].concat((v.liveAgents || []).map((a) => '    ' + a.id + '   parent=' + (a.parent || '-') + '   ' + (a.status || ''))).join('\n')
  }
  const s = v.stats || {}
  const head = 'watch_push ' + (v.running ? 'RUNNING' : 'stopped') + ' every=' + v.every + 's target=' + (v.target || '-') +
    ' delivery=' + (v.delivery || '-') + '  ticks=' + (s.ticks || 0) + ' injected=' + (s.injected || 0) + ' skipped=' + (s.skipped || 0) + ' errors=' + (s.errors || 0) +
    (v.lastError ? '\n  lastError: ' + v.lastError : '')
  const body = (v.last || []).map((p) => '  ' + String(p.at).slice(11, 19) + ' via ' + p.via + '  ' + p.text).join('\n')
  return body ? head + '\n' + body : head
}

export function apply(ctx) {
  ensureDaemon().catch(() => {
    /* the first tool call reports the real error */
  })
  ctxRef = ctx
  try {
    getPusher(ctx, 'default')
  } catch (error) {
    ctx.logger?.warn?.('dsh-watch-ears: pusher unavailable: ' + String(error && error.message))
  }
  for (const tool of [hearNowTool, hearRecentTool, hearingTool, pushTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.('dsh-watch-ears: could not register ' + tool.name + ': ' + String(error && error.message))
    }
  }
  ctx.logger?.info?.('dsh-watch-ears ready (config ' + CONFIG_PATH + ')')
}