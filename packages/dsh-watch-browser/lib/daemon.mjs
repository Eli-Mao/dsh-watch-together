// dsh-watch-browser daemon: owns one persistent Chromium context and answers commands
// over loopback. A persistent profile keeps logins between runs.
import http from 'node:http'
import { readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureStateDir, loadConfig, log, SHOT_DIR, USER_DATA_DIR } from './shared.mjs'

const cfg = loadConfig()
ensureStateDir()

const state = { started: Date.now(), context: null, page: null, launching: null, actions: 0, lastError: null, lastAction: null }

async function launch() {
  if (state.context) return state.context
  if (state.launching) return state.launching
  state.launching = (async () => {
    if (cfg.cdpUrl) {
      // Attach to a browser the operator launched with --remote-debugging-port.
      // The existing context carries their real logins.
      log('connecting over CDP to ' + cfg.cdpUrl)
      const { chromium } = await import('playwright-core')
      const browser = await chromium.connectOverCDP(cfg.cdpUrl)
      state.browser = browser
      state.mode = 'cdp'
      const context = browser.contexts()[0] ?? (await browser.newContext())
      state.context = context
      state.page = context.pages().find((pg) => !pg.isClosed()) ?? (await context.newPage())
      browser.on('disconnected', () => {
        log('CDP browser disconnected')
        state.browser = null
        state.context = null
        state.page = null
        state.launching = null
      })
      return context
    }
    log('launching chromium (persistent)')
    const { chromium } = await import('playwright-core')
    // Prefer a browser that is already installed over downloading one: the
    // channel list is tried in order and the bundled Chromium is the fallback.
    const channels = [cfg.channel, 'msedge', 'chrome', null].filter((c, i, a) => a.indexOf(c) === i)
    let context = null
    let lastError = null
    for (const channel of channels) {
      const options = {
        headless: cfg.headless === true,
        viewport: null,
        args: [
          '--start-maximized',
          // Without this a video opened by a script will not start with sound.
          '--autoplay-policy=no-user-gesture-required',
          '--disable-features=CalculateNativeWinOcclusion',
        ],
      }
      if (channel) options.channel = channel
      try {
        context = await chromium.launchPersistentContext(USER_DATA_DIR, options)
        log('launched with channel=' + String(channel))
        state.channel = channel ?? 'bundled'
        break
      } catch (e) {
        lastError = e
        log('channel ' + String(channel) + ' failed: ' + String(e && e.message).slice(0, 200))
      }
    }
    if (!context) throw lastError ?? new Error('no usable chromium channel')
    context.on('close', () => {
      log('context closed')
      state.context = null
      state.page = null
      state.launching = null
    })
    state.context = context
    state.page = context.pages()[0] ?? (await context.newPage())
    // A tab the operator opens becomes the tab we drive.
    context.on('page', (p) => {
      state.page = p
      log('new tab became current: ' + String(p.url()).slice(0, 80))
    })
    return context
  })().catch((e) => {
    state.launching = null
    state.lastError = String(e && e.message)
    throw e
  })
  return state.launching
}

// Resolve the tab the operator is actually looking at, every time.
// The old version cached pages()[0] once and then kept driving that tab, so
// switching to another video made every read and every play/pause land on the
// stale tab instead. A background tab reports visibilityState === 'hidden';
// the foreground one reports 'visible'.
// Pages that count as "an episode": a player with subtitles and a story.
//
// Live rooms are deliberately NOT here. A live stream has no duration, no fixed
// subtitle band and no episode structure, so it belongs to the "watch the screen"
// mode instead of pretending to be 看番. That is a product decision, not a
// technical limit - the iframe-aware video finder below still finds the stream.
const VIDEO_URL = /\/video\/|\/bangumi\/play\//

async function allPages() {
  await launch()
  return state.context.pages().filter((p) => !p.isClosed())
}

async function visiblePage() {
  const pages = await allPages()
  for (const p of pages) {
    try { if ((await p.evaluate(() => document.visibilityState)) === 'visible') return p } catch { /* mid-navigation */ }
  }
  return pages[pages.length - 1] ?? null
}

// "Start" means play the video I prepared. If the operator is looking at some
// other tab, bring the video tab forward instead of refusing: refusing was
// technically right but useless, because it left the user stuck.
// Resolve the tab that actually holds a video. subtitle and frame need this as
// much as play does: after a browser restart Chrome restores every tab, the
// first one is often a home page, and "current tab" then has no <video> at all.
// Find the <video> the user is actually watching, including inside same-origin
// iframes.
//
// Bilibili's live rooms put the player in an iframe (live.bilibili.com/blanc/...).
// A top-level querySelector then returns zero videos, which silently made every
// sample fail (hashChecks 0, subMiss climbing) while the stream played fine.
// Cross-origin frames stay unreachable by design, so the walk stops there and
// reports what it skipped instead of pretending the page has no video.
const FIND_VIDEO = `(() => {
  const seen = []
  const walk = (doc, label) => {
    let found = null
    try {
      found = doc.querySelector('video')
    } catch (e) { return null }
    if (found) return { video: found, doc, label }
    const frames = doc.querySelectorAll('iframe')
    for (let i = 0; i < frames.length; i++) {
      seen.push(String(frames[i].src || '').slice(0, 90))
      let inner = null
      try { inner = frames[i].contentDocument } catch (e) { inner = null }
      if (!inner) continue
      const hit = walk(inner, label + ' > iframe[' + i + ']')
      if (hit) return hit
    }
    return null
  }
  const hit = walk(document, 'top')
  if (!hit) return { found: false, frames: seen.slice(0, 8) }
  return { found: true, label: hit.label, paused: hit.video.paused, t: hit.video.currentTime, dur: hit.video.duration || null }
})()`

// Run a snippet against whichever document holds the video.
// Page-side helper, installed before any sampling action runs.
//
// Every sampling path used to do (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video')) at the top
// level. Bilibili's live room keeps its player in a same-origin iframe, so that
// returned null and the whole vision pipeline silently produced nothing while
// the stream played normally. A cross-origin frame is unreachable by design; we
// skip those and keep looking.
async function ensureVideoFinder(page) {
  try {
    const installed = await page.evaluate(() => typeof window.__dshFindVideo === 'function')
    if (installed) return true
  } catch { /* page may be mid-navigation */ }
  try {
    await page.evaluate(() => {
      window.__dshFindVideo = function () {
        var walk = function (doc) {
          var v = null
          try { v = doc.querySelector('video') } catch (e) { return null }
          if (v) return v
          var frames = doc.querySelectorAll('iframe')
          for (var i = 0; i < frames.length; i++) {
            var inner = null
            try { inner = frames[i].contentDocument } catch (e) { inner = null }
            if (!inner) continue
            var hit = walk(inner)
            if (hit) return hit
          }
          return null
        }
        return walk(document)
      }
    })
    return true
  } catch {
    return false
  }
}

async function evalInVideoDoc(page, body) {
  return await page.evaluate((src) => {
    const find = (doc) => {
      let v = null
      try { v = doc.querySelector('video') } catch (e) { return null }
      if (v) return v
      const frames = doc.querySelectorAll('iframe')
      for (let i = 0; i < frames.length; i++) {
        let inner = null
        try { inner = frames[i].contentDocument } catch (e) { inner = null }
        if (!inner) continue
        const hit = find(inner)
        if (hit) return hit
      }
      return null
    }
    // eslint-disable-next-line no-new-func
    return new Function('video', 'doc', src)(find(document), document)
  }, body)
}

async function videoPage(q) {
  const picked = await videoPageRaw(q)
  // Install the iframe-aware finder before returning: every sampling action
  // relies on window.__dshFindVideo, and forgetting one silent-zeros a channel.
  if (picked && picked.page) {
    try { await ensureVideoFinder(picked.page) } catch { /* best effort */ }
  }
  return picked
}

async function videoPageRaw(q) {
  const pages = await allPages()
  if (pages.length === 0) return { page: null, reason: 'no pages open' }
  if (q && q.tab) {
    const needle = String(q.tab).toLowerCase()
    for (const p of pages) {
      const u = p.url().toLowerCase()
      const t = String(await p.title().catch(() => '')).toLowerCase()
      if (u.includes(needle) || t.includes(needle)) return { page: p, reason: 'matched --tab' }
    }
  }
  const cur = state.page && !state.page.isClosed() ? state.page : null
  if (cur && VIDEO_URL.test(cur.url())) return { page: cur, reason: 'current tab is a video' }
  // The URL is a hint, not the truth. A player can live inside a same-origin
  // iframe under a page whose URL is not /video/ at all (bilibili's space page
  // embeds one), and then the URL filter says "no video tab open" while /state -
  // which asks the DOM - happily reports a playing video. Ask each candidate
  // whether it HAS a video before believing the URL.
  let videos = pages.filter((p) => VIDEO_URL.test(p.url()))
  if (videos.length === 0) {
    const withVideo = []
    for (const pg of pages) {
      const has = await pg.evaluate(() => !!(window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video')))
        .catch(() => false)
      if (has) withVideo.push(pg)
    }
    if (withVideo.length === 1) return { page: withVideo[0], reason: 'only tab containing a <video> (url did not match)' }
    if (withVideo.length > 1) {
      // Prefer the one we are already driving: it is the one the operator sees.
      const hit = cur && withVideo.includes(cur)
      if (hit) return { page: cur, reason: 'current tab has a <video>' }
      return { page: null, reason: 'multiple tabs contain a <video>', candidates: withVideo.map((p) => p.url().slice(0, 90)) }
    }
    return { page: null, reason: 'no video tab open' }
  }
  if (videos.length === 1) return { page: videos[0], reason: 'switched to the only video tab' }
  if (videos.length > 1) {
    const hit = cur && videos.includes(cur)
    if (hit) return { page: cur, reason: 'current tab is one of the video tabs' }
    return { page: null, reason: 'multiple video tabs', candidates: videos.map((p) => p.url().slice(0, 90)) }
  }
  return { page: null, reason: 'no video tab open' }
}

async function playTargetPage(q) {
  const pages = await allPages()
  if (pages.length === 0) return { page: await state.context.newPage(), reason: 'opened a new tab' }
  if (q && q.tab) {
    const needle = String(q.tab).toLowerCase()
    for (const p of pages) {
      const u = p.url().toLowerCase()
      const t = String(await p.title().catch(() => '')).toLowerCase()
      if (u.includes(needle) || t.includes(needle)) return { page: p, reason: 'matched --tab' }
    }
  }
  const vis = await visiblePage()
  if (vis && VIDEO_URL.test(vis.url())) return { page: vis, reason: 'already on the video tab' }
  const videos = pages.filter((p) => VIDEO_URL.test(p.url()))
  if (videos.length === 1) {
    await videos[0].bringToFront().catch(() => {})
    await new Promise((r) => setTimeout(r, 600))
    return { page: videos[0], reason: 'switched to the only video tab' }
  }
  if (videos.length > 1) return { page: null, reason: 'multiple video tabs', candidates: videos.map((p) => p.url().slice(0, 90)) }
  return { page: null, reason: 'no video tab open' }
}

// Which tab are we driving?
//
// visibilityState is useless here: a CDP-attached Chrome reports 'visible' for
// EVERY tab, so "pick the visible one" always returned tab 0 and every read
// landed on the wrong page. The current tab is therefore explicit:
//   - a newly opened tab becomes current immediately
//   - play sets it to the video tab it picked
//   - goto keeps it on the page it drove
//   - /do?...&tab=<substring> switches it deliberately
async function page() {
  await launch()
  if (state.page && !state.page.isClosed()) return state.page
  const pages = state.context.pages().filter((p) => !p.isClosed())
  state.page = pages[pages.length - 1] ?? (await state.context.newPage())
  return state.page
}

async function mediaState(p) {
  return await p.evaluate(() => {
    const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
    if (!v) return { found: false }
    return {
      found: true,
      paused: v.paused,
      muted: v.muted,
      volume: Number(v.volume.toFixed(2)),
      currentTime: Number(v.currentTime.toFixed(2)),
      duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
      readyState: v.readyState,
      src: String(v.currentSrc || v.src || '').slice(0, 160),
    }
  }).catch(() => ({ found: false }))
}

async function doAction(q) {
  const action = String(q.action || '').toLowerCase()
  // Answer this before touching the browser at all: in call mode no browser is
  // even attached, and going through page() first turned every subtitle probe
  // into a multi-second wait or an error.
  if (action === 'subtitle' && cfg.subtitles === false) {
    return { action, found: false, reason: 'subtitles disabled by config' }
  }
  if (q.tab && action !== 'play') {
    const needle = String(q.tab).toLowerCase()
    for (const cand of await allPages()) {
      const u = cand.url().toLowerCase()
      const t = String(await cand.title().catch(() => '')).toLowerCase()
      if (u.includes(needle) || t.includes(needle)) { state.page = cand; break }
    }
  }
  let p = await page()
  state.actions += 1
  state.lastAction = action
  const wait = Math.min(Math.max(Number(q.ms) || 0, 0), 120000)

  if (action === 'goto' || action === 'open') {
    if (!q.url) throw new Error('goto needs url')
    await p.goto(q.url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => log('goto warn: ' + String(e && e.message).slice(0, 200)))
    if (wait) await p.waitForTimeout(wait)
    return { action, url: p.url(), title: await p.title() }
  }
  if (action === 'click') {
    if (!q.selector) throw new Error('click needs selector')
    await p.click(q.selector, { timeout: 30000 })
    if (wait) await p.waitForTimeout(wait)
    return { action, url: p.url() }
  }
  if (action === 'fill' || action === 'type') {
    if (!q.selector) throw new Error('fill needs selector')
    await p.fill(q.selector, String(q.text ?? ''), { timeout: 30000 })
    if (wait) await p.waitForTimeout(wait)
    return { action, filled: true }
  }
  if (action === 'press') {
    if (q.selector) await p.press(q.selector, String(q.text || 'Enter'), { timeout: 30000 })
    else await p.keyboard.press(String(q.text || 'Enter'))
    if (wait) await p.waitForTimeout(wait)
    return { action, pressed: String(q.text || 'Enter') }
  }
  if (action === 'eval') {
    if (!q.text) throw new Error('eval needs text (javascript)')
    const value = await p.evaluate(q.text)
    return { action, value: value === undefined ? null : value }
  }
  if (action === 'wait') {
    await p.waitForTimeout(wait || 1000)
    return { action, waited: wait || 1000 }
  }
  if (action === 'play') {
    // A JS-only .play() is an untrusted event and a site player may simply
    // refuse to resume. Click the picture like a person first, then insist.
    const picked = await playTargetPage(q)
    if (!picked.page) return { action, media: { found: false }, refused: true, reason: picked.reason, candidates: picked.candidates ?? [] }
    p = picked.page
    state.page = p
    const el = await p.$('video')
    if (el) {
      const isPaused = await p.evaluate(() => { const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video')); return !v || v.paused })
      // The click that satisfies the gesture requirement is only safe on a real
      // video page. On a search results or home page the <video> element is a
      // hover preview, and clicking it follows the link and navigates away.
      const onVideoPage = await p.evaluate(() => /\/video\/|\/bangumi\/play\//.test(location.pathname)).catch(() => false)
      if (isPaused && onVideoPage) {
        await el.click({ position: { x: 240, y: 160 }, force: true }).catch(() => {})
        await p.waitForTimeout(900)
      }
      const out = await p.evaluate(() => {
        const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
        if (!v) return { found: false }
        v.muted = false
        v.play().catch(() => {})
        return { found: true, paused: v.paused, muted: v.muted, currentTime: Number(v.currentTime.toFixed(2)) }
      })
      if (wait) await p.waitForTimeout(wait)
      const after = await mediaState(p)
      return { action, media: after, clicked: isPaused && onVideoPage, onVideoPage, reason: picked.reason, url: p.url().slice(0, 100) }
    }
    if (wait) await p.waitForTimeout(wait)
    return { action, media: await mediaState(p) }
  }
  if (action === 'pause' || action === 'seek' || action === 'mute' || action === 'volume') {
    const value = Number(q.value)
    const res = await p.evaluate(
      ({ action, value }) => {
        const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
        if (!v) return { found: false }
        if (action === 'play') { v.muted = false; v.play().catch(() => {}); }
        else if (action === 'pause') v.pause()
        else if (action === 'seek') v.currentTime = Number.isFinite(value) ? value : v.currentTime + 15
        else if (action === 'mute') v.muted = !v.muted
        else if (action === 'volume') v.volume = Math.min(Math.max(value, 0), 1)
        return { found: true, paused: v.paused, muted: v.muted, currentTime: Number(v.currentTime.toFixed(2)) }
      },
      { action, value },
    )
    if (wait) await p.waitForTimeout(wait)
    return { action, media: res }
  }
  // Grab pixels straight out of the <video> element through a canvas.
  //
  // This replaces screenshot-clipping entirely: it is always exactly the video,
  // never depends on window position, scaling, scroll or which monitor it is
  // on, and it costs ~40ms instead of a 300ms+ screenshot round trip. The cheap
  // 8x8 luminance hash it returns lets the caller watch CONTINUOUSLY for almost
  // nothing, and only pay for a vision call when the picture actually changes.
  if (action === 'videohash' || action === 'videojpeg') {
    const pickedV = await videoPage(q)
    if (!pickedV.page) return { action, found: false, reason: pickedV.reason, candidates: pickedV.candidates ?? [] }
    p = pickedV.page
    state.page = p
    const wantJpeg = action === 'videojpeg'
    const res = await p.evaluate(({ maxW, want }) => {
      const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
      if (!v || !v.videoWidth) return { found: false, reason: 'video not ready' }
      const scale = Math.min(1, maxW / v.videoWidth)
      const w = Math.max(32, Math.round(v.videoWidth * scale))
      const h = Math.max(18, Math.round(v.videoHeight * scale))
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d')
      try { g.drawImage(v, 0, 0, w, h) } catch (e) { return { found: false, reason: 'drawImage failed: ' + String(e && e.message) } }
      const s = document.createElement('canvas')
      s.width = 8; s.height = 8
      const sg = s.getContext('2d')
      sg.drawImage(v, 0, 0, 8, 8)
      const d = sg.getImageData(0, 0, 8, 8).data
      let sum = 0
      const lum = []
      for (let i = 0; i < 64; i++) {
        const l = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
        lum.push(l); sum += l
      }
      const avg = sum / 64
      let bits = ''
      for (let i = 0; i < 64; i++) bits += lum[i] >= avg ? '1' : '0'
      // `ended` matters: a finished episode is paused at currentTime === duration,
      // which is indistinguishable from "paused mid-scene" by the flags alone. A
      // watcher that cannot tell them apart keeps waiting for a video that will
      // never resume, and says nothing about an episode that is over.
      const out = {
        found: true, hash: bits, w, h, vw: v.videoWidth, vh: v.videoHeight,
        t: Number(v.currentTime.toFixed(2)),
        paused: v.paused,
        ended: !!v.ended || (v.duration > 0 && v.currentTime >= v.duration - 0.25),
        duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
      }
      if (want) out.jpeg = c.toDataURL('image/jpeg', 0.82)
      return out
    }, { maxW: Number(q.width) || 960, want: wantJpeg })
    if (!res || !res.found) return { action, found: false, reason: (res && res.reason) || 'unknown' }
    if (wantJpeg && res.jpeg) {
      const b64 = String(res.jpeg).replace(/^data:image\/jpeg;base64,/, '')
      const { writeFileSync } = await import('node:fs')
      const path = join(SHOT_DIR, 'vf-' + Date.now() + '.png')
      writeFileSync(path, Buffer.from(b64, 'base64'))
      delete res.jpeg
      res.path = path
    }
    return { action, ...res }
  }
  // Cheap existence check for the subtitle band: crop it and hash the bottom
  // portion WITHOUT calling any model. Two flags matter - did ANY text appear,
  // and did it change since last time. Only then is an OCR call worth paying
  // for, which lets the sampler poll far more often than it could otherwise.
  if (action === 'subhash') {
    const pickedS = await videoPage(q)
    if (!pickedS.page) return { action, found: false, reason: pickedS.reason, candidates: pickedS.candidates ?? [] }
    p = pickedS.page
    state.page = p
    const fracS = Math.min(Math.max(Number(q.frac) || 0.2, 0.06), 0.5)
    const res = await p.evaluate((frac) => {
      const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
      if (!v || !v.videoWidth) return { found: false, reason: 'video not ready' }
      // Portrait frames need a taller band.
      //
      // A 0.2 fraction of a 480px-tall vertical video is 96px starting at y=384,
      // which lands on knees and furniture, not on the subtitle. Subtitles in a
      // vertical letterboxed frame sit inside the letterbox, typically the
      // bottom 25-35%. Asking for a fraction that is right for 16:9 and wrong
      // for 9:16 is why every poll came back hasText:false while the OCR path
      // would have read a perfectly good line.
      const portrait = v.videoHeight > v.videoWidth
      const fracEff = portrait ? Math.max(frac, 0.3) : frac
      const r = v.getBoundingClientRect()
      const scale = Math.min(1, 960 / v.videoWidth)
      const cw = Math.max(64, Math.round(v.videoWidth * scale))
      const ch = Math.max(18, Math.round(v.videoHeight * scale))
      const c = document.createElement('canvas')
      c.width = cw; c.height = ch
      const g = c.getContext('2d')
      try { g.drawImage(v, 0, 0, cw, ch) } catch (e) { return { found: false, reason: 'draw failed' } }
      // bottom band only
      const by = Math.round(ch * (1 - fracEff))
      const bh = ch - by
      if (bh < 8) return { found: false, reason: 'band too thin' }

      // Measure the band at DOUBLE resolution.
      //
      // This is the fix for "it can see the picture but never the subtitle".
      // Downscaled to 960 wide, a 360x480 portrait video is not downscaled at
      // all - and its subtitle glyphs are ~10px tall. Edge counts on 10px text
      // are noise (one real subtitle frame scored edgeDensity 0.0167 against a
      // rule that demanded 0.018), so every poll answered "no text" while a
      // perfectly readable line sat on screen. Measured on this machine over 20
      // real frames, at 2x:
      //
      //   with subtitle : bright 0.016-0.024  hot rows 0.09-0.16  run 25 rows
      //   without       : bright 0.0006-0.001 hot rows 0.03-0.06  run  7 rows
      //
      // The decisive shape is the RUN: subtitles are one contiguous block of
      // text rows; artwork scatters. 25 against 7 is not a tuned threshold,
      // it is a gap.
      const UP = 2
      const bandW = cw * UP
      const bandH2 = bh * UP
      const up = document.createElement('canvas')
      up.width = bandW; up.height = bandH2
      const ug = up.getContext('2d')
      ug.imageSmoothingEnabled = true
      ug.imageSmoothingQuality = 'high'
      ug.drawImage(c, 0, by, cw, bh, 0, 0, bandW, bandH2)
      const band = ug.getImageData(0, 0, bandW, bandH2).data
      let bright = 0
      let brightSum = 0
      const n = bandW * bandH2
      const lum = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        const l = 0.299 * band[i * 4] + 0.587 * band[i * 4 + 1] + 0.114 * band[i * 4 + 2]
        lum[i] = l
        brightSum += l
        if (l > 190) bright++
      }
      // Strong horizontal edges per row: text is full of vertical strokes.
      const rowEdge = new Int32Array(bandH2)
      for (let y = 0; y < bandH2; y++) {
        let e2 = 0
        const base2 = y * bandW
        let prev = lum[base2]
        for (let x = 1; x < bandW; x++) {
          const cur = lum[base2 + x]
          if (Math.abs(cur - prev) > 60) e2++
          prev = cur
        }
        rowEdge[y] = e2
      }
      let edges = 0
      let peak = 0
      for (let y = 0; y < bandH2; y++) { edges += rowEdge[y]; if (rowEdge[y] > peak) peak = rowEdge[y] }
      const hotBar = peak * 0.5
      let hot = 0
      let run = 0
      let bestRun = 0
      for (let y = 0; y < bandH2; y++) {
        if (peak > 0 && rowEdge[y] > hotBar) {
          hot++
          run++
          if (run > bestRun) bestRun = run
        } else run = 0
      }
      const brightRatio = bright / n
      const edgeDensity = edges / Math.max(1, n)
      const rowCoverage = hot / Math.max(1, bandH2)
      const hotRun = bestRun
      // hotRun is the signal; the other two are only sanity rails.
      //
      // Measured on the same episode: real subtitle frames scored hotRun 18, 24,
      // 27, 32; frames without scored 1, 4, 5, 7. So 15 sits in a gap, not on a
      // slope. rowCoverage used to be 0.08 and rejected a genuine frame at 0.075
      // - a band this tight leaks into "sometimes it misses a line", which is
      // worse than an occasional wasted vision call (the OCR is already rate
      // limited). brightRatio's floor is only there to reject a black frame.
      const looksLikeText = hotRun >= 15 && rowCoverage > 0.04 && brightRatio > 0.0015

      // 2) coarse 16-bit hash of the band, to detect a change
      const hc = document.createElement('canvas')
      hc.width = 32; hc.height = 8
      hc.getContext('2d').drawImage(c, 0, by, cw, bh, 0, 0, 32, 8)
      const hd = hc.getContext('2d').getImageData(0, 0, 32, 8).data
      let hs = 0
      for (let i = 0; i < 256; i++) {
        hs += 0.299 * hd[i * 4] + 0.587 * hd[i * 4 + 1] + 0.114 * hd[i * 4 + 2]
      }
      const havg = hs / 256
      let bits = ''
      for (let i = 0; i < 256; i++) {
        const l = 0.299 * hd[i * 4] + 0.587 * hd[i * 4 + 1] + 0.114 * hd[i * 4 + 2]
        bits += l >= havg ? '1' : '0'
      }
      return {
        found: true,
        hash: bits,
        hasText: looksLikeText,
        brightRatio: Number(brightRatio.toFixed(4)),
        fracUsed: Number(fracEff.toFixed(2)),
        portrait,
        edgeDensity: Number(edgeDensity.toFixed(4)),
        rowCoverage: Number(rowCoverage.toFixed(3)),
        hotRun,
        bandAvgLum: Math.round(brightSum / n),
        t: Number(v.currentTime.toFixed(2)),
        paused: v.paused,
      }
    }, fracS)
    return { action, ...res }
  }
  // Canvas crop of the subtitle band.
  //
  // page.screenshot forces the browser to re-composite a frame: it flashes and
  // briefly stalls playback, and at one OCR every ~2 seconds that is a dozen
  // repaints a minute. drawImage on the <video> element reads the decoded frame
  // directly - ~13ms versus ~170ms - with no repaint at all. The captions in this
  // player are burned into the video, so the canvas crop contains them.
  if (action === 'subocr') {
    const pickedO = await videoPage(q)
    if (!pickedO.page) return { action, found: false, reason: pickedO.reason }
    p = pickedO.page
    state.page = p
    const fracO = Math.min(Math.max(Number(q.frac) || 0.2, 0.06), 0.5)
    const scaleO = Math.min(Math.max(Number(q.scale) || 2, 1), 4)
    const resO = await p.evaluate(({ frac: fracRaw, sc }) => {
      const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
      if (!v || !v.videoWidth) return { found: false, reason: 'video not ready' }
      const frac = v.videoHeight > v.videoWidth ? Math.max(fracRaw, 0.3) : fracRaw
      const w = Math.round(v.videoWidth * sc)
      const h = Math.round(v.videoHeight * sc)
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d')
      g.imageSmoothingEnabled = true
      g.imageSmoothingQuality = 'high'
      try { g.drawImage(v, 0, 0, w, h) } catch (e) { return { found: false, reason: 'draw blocked' } }
      const bandY = Math.round(h * (1 - frac))
      const bandH = h - bandY
      const out = document.createElement('canvas')
      out.width = w; out.height = bandH
      out.getContext('2d').drawImage(c, 0, bandY, w, bandH, 0, 0, w, bandH)
      return { found: true, png: out.toDataURL('image/png'), w, bandH, t: Number(v.currentTime.toFixed(2)) }
    }, { frac: fracO, sc: scaleO })
    if (!resO || !resO.found) return { action, found: false, reason: (resO && resO.reason) || 'unknown' }
    const b64o = String(resO.png).replace(/^data:image\/png;base64,/, '')
    const { writeFileSync: wfo } = await import('node:fs')
    const pathO = join(SHOT_DIR, 'so-' + Date.now() + '.png')
    wfo(pathO, Buffer.from(b64o, 'base64'))
    return { action, found: true, path: pathO, width: resO.w, band: resO.bandH, scale: scaleO, t: resO.t }
  }
  if (action === 'subcanvas') {
    const pickedC = await videoPage(q)
    if (!pickedC.page) return { action, found: false, reason: pickedC.reason }
    p = pickedC.page
    state.page = p
    const fracC = Math.min(Math.max(Number(q.frac) || 0.2, 0.06), 0.5)
    const maxWC = Number(q.width) || 1460
    const resC = await p.evaluate(({ frac, maxW }) => {
      const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
      if (!v || !v.videoWidth) return { found: false, reason: 'video not ready' }
      const scale = Math.min(1, maxW / v.videoWidth)
      const w = Math.max(64, Math.round(v.videoWidth * scale))
      const h = Math.max(18, Math.round(v.videoHeight * scale))
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const g = c.getContext('2d')
      try { g.drawImage(v, 0, 0, w, h) } catch (e) { return { found: false, reason: 'draw blocked' } }
      const bandY = Math.round(h * (1 - frac))
      const bandH = h - bandY
      const out = document.createElement('canvas')
      out.width = w; out.height = bandH
      out.getContext('2d').drawImage(c, 0, bandY, w, bandH, 0, 0, w, bandH)
      return { found: true, jpeg: out.toDataURL('image/jpeg', 0.9), w, bandH, t: Number(v.currentTime.toFixed(2)) }
    }, { frac: fracC, maxW: maxWC })
    if (!resC || !resC.found) return { action, found: false, reason: (resC && resC.reason) || 'unknown' }
    const b64c = String(resC.jpeg).replace(/^data:image\/jpeg;base64,/, '')
    const { writeFileSync: wf } = await import('node:fs')
    const pathC = join(SHOT_DIR, 'sc-' + Date.now() + '.jpg')
    wf(pathC, Buffer.from(b64c, 'base64'))
    return { action, found: true, path: pathC, band: resC.bandH, width: resC.w, t: resC.t }
  }
  if (action === 'subtitle') {
    const picked = await videoPage(q)
    if (!picked.page) return { action, found: false, reason: picked.reason, candidates: picked.candidates ?? [] }
    p = picked.page
    state.page = p
    // Crop the subtitle band OUT OF THE VIDEO ELEMENT, not out of the page.
    //
    // This used getBoundingClientRect + page.screenshot. Both halves were wrong
    // once the player lives in a same-origin iframe: getBoundingClientRect
    // returns coordinates inside the IFRAME, so the clip rectangle was computed
    // against the wrong origin, and page.screenshot then waited out its 30s
    // timeout trying to composite a rectangle that contained no page content.
    // Measured 2026-10-26: 'subhash' and 'subcanvas' returned data on the same
    // page while 'subtitle' timed out.
    //
    // drawImage(v) into a canvas knows where the pixels are by construction, so
    // it is correct for both inline and iframe players.
    const fracIn = Math.min(Math.max(Number(q.frac) || 0.26, 0.08), 0.6)
    const resC = await p.evaluate((fracIn) => {
      const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
      if (!v || !v.videoWidth) return { found: false, reason: 'video not ready' }
      // Same portrait rule as subhash: a 16:9 fraction on a 9:16 frame crops
      // the wrong strip entirely.
      const frac = v.videoHeight > v.videoWidth ? Math.max(fracIn, 0.3) : fracIn
      const bandH = Math.max(24, Math.round(v.videoHeight * frac))
      const c = document.createElement('canvas')
      c.width = v.videoWidth
      c.height = bandH
      const g = c.getContext('2d')
      // Draw the bottom band of the frame into the top of the canvas.
      try {
        g.drawImage(v, 0, v.videoHeight - bandH, v.videoWidth, bandH, 0, 0, v.videoWidth, bandH)
      } catch (e) {
        return { found: false, reason: 'drawImage failed: ' + String(e && e.message) }
      }
      return { found: true, jpeg: c.toDataURL('image/jpeg', 0.9), bandH, w: v.videoWidth, h: v.videoHeight, t: Number(v.currentTime.toFixed(2)) }
    }, fracIn)
    if (!resC || !resC.found) return { action, found: false, reason: (resC && resC.reason) || 'unknown' }
    const b64 = String(resC.jpeg).replace(/^data:image\/jpeg;base64,/, '')
    const path = join(SHOT_DIR, 'sub-' + Date.now() + '.jpg')
    writeFileSync(path, Buffer.from(b64, 'base64'))
    return { action, found: true, path, band: resC.bandH, width: resC.w, height: resC.h, t: resC.t }
  }
  if (action === 'frame') {
    const pickedF = await videoPage(q)
    if (!pickedF.page) return { action, found: false, reason: pickedF.reason, candidates: pickedF.candidates ?? [] }
    p = pickedF.page
    state.page = p
    // The whole video frame, by drawImage — NOT getBoundingClientRect + screenshot.
    //
    // Same bug as 'subtitle' had: inside a same-origin iframe the DOM rect is in
    // IFRAME coordinates, so the clip rectangle was measured against the wrong
    // origin and the screenshot came back as page furniture (or timed out).
    // Drawing the element into a canvas is correct wherever it lives.
    const wantW = Math.max(160, Math.min(Number(q.width) || 960, 1920))
    const resF = await p.evaluate((maxW) => {
      const v = (window.__dshFindVideo ? window.__dshFindVideo() : document.querySelector('video'))
      if (!v || !v.videoWidth) return { found: false, reason: 'video not ready' }
      const scale = Math.min(1, maxW / v.videoWidth)
      const w = Math.max(64, Math.round(v.videoWidth * scale))
      const h = Math.max(36, Math.round(v.videoHeight * scale))
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')
      try {
        g.drawImage(v, 0, 0, w, h)
      } catch (e) {
        return { found: false, reason: 'drawImage failed: ' + String(e && e.message) }
      }
      return { found: true, jpeg: c.toDataURL('image/jpeg', 0.85), w: v.videoWidth, h: v.videoHeight, outW: w, outH: h, t: Number(v.currentTime.toFixed(2)) }
    }, wantW)
    if (!resF || !resF.found) return { action, found: false, reason: (resF && resF.reason) || 'unknown' }
    const b64f = String(resF.jpeg).replace(/^data:image\/jpeg;base64,/, '')
    const pathF = join(SHOT_DIR, 'frame-' + Date.now() + '.jpg')
    writeFileSync(pathF, Buffer.from(b64f, 'base64'))
    return { action, found: true, path: pathF, width: resF.outW, height: resF.outH, t: resF.t }
  }
  if (action === 'screenshot') {
    const path = join(SHOT_DIR, 'shot-' + Date.now() + '.png')
    await p.screenshot({ path, fullPage: q.full === '1' })
    return { action, path }
  }
  if (action === 'back') { await p.goBack({ timeout: 30000 }).catch(() => {}); return { action, url: p.url() } }
  if (action === 'reload') { await p.reload({ timeout: 60000 }).catch(() => {}); return { action, url: p.url() } }
  if (action === 'login-bilibili') {
    // Hard gate. Submitting a login form on a site that runs a behavioural
    // captcha is exactly what trips its risk control: doing it once cost a real
    // block on this profile. Automated submission therefore needs an explicit
    // confirm=1 from the operator, and the default path only fills the form.
    if (String(q.confirm) !== '1') {
      const acct0 = cfg.accounts?.bilibili ?? {}
      if (!acct0.user || !acct0.password) return { action, ok: false, reason: 'no bilibili credentials stored' }
      await p.goto('https://passport.bilibili.com/login', { waitUntil: 'domcontentloaded', timeout: 90000 })
      await p.waitForTimeout(2500)
      await p.fill('input[type="text"], input[name="username"]', acct0.user, { timeout: 30000 }).catch(() => {})
      await p.fill('input[type="password"]', acct0.password, { timeout: 30000 }).catch(() => {})
      return {
        action,
        ok: false,
        submitted: false,
        url: p.url(),
        note: 'form filled only. A behavioural captcha guards this site: solve it by hand in this window, or pass confirm=1 to submit automatically at your own risk.',
      }
    }
    const acct = cfg.accounts?.bilibili ?? {}
    if (!acct.user || !acct.password) return { action, ok: false, reason: 'no bilibili credentials stored' }
    await p.goto('https://passport.bilibili.com/login', { waitUntil: 'domcontentloaded', timeout: 90000 })
    await p.waitForTimeout(2500)
    await p.fill('input[type="text"], input[name="username"]', acct.user, { timeout: 30000 }).catch(() => {})
    await p.fill('input[type="password"]', acct.password, { timeout: 30000 }).catch(() => {})
    await p.waitForTimeout(400)
    // Bilibili's submit control is a div, not a button.
    await p.click('div.btn_primary', { timeout: 20000 }).catch(() => {})
    await p.waitForTimeout(6000)
    const url = p.url()
    const cookies = await state.context.cookies('https://www.bilibili.com')
    const logged = cookies.some((c) => c.name === 'SESSDATA' && c.value)
    // A Geetest click-order puzzle is a human check. Report the wall instead of
    // trying to defeat it: the user solves it once and the persistent profile
    // keeps the session afterwards.
    const captcha = await p
      .evaluate(() => [...document.querySelectorAll('.geetest_panel,[class*=captcha]')].some((e) => e.offsetWidth || e.offsetHeight))
      .catch(() => false)
    return {
      action,
      ok: logged,
      url,
      captcha,
      note: logged
        ? 'session cookie present'
        : captcha
          ? 'a Geetest captcha is on screen; solve it once by hand in this window and the profile keeps the session'
          : 'no session cookie yet',
    }
  }
  throw new Error('unknown action: ' + action)
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

const server = http.createServer(async (req, res) => {
  const address = req.socket && req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return send(res, 403, { error: 'loopback only' })
  const refusal = browserRefusal(req)
  if (refusal) return send(res, 403, { error: 'forbidden: ' + refusal })
  const url = new URL(req.url, 'http://127.0.0.1')
  const q = Object.fromEntries(url.searchParams.entries())
  try {
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, pid: process.pid, mode: state.mode ?? 'launch', uptimeMs: Date.now() - state.started, running: !!state.context, pages: state.context ? state.context.pages().length : 0, actions: state.actions, lastAction: state.lastAction, lastError: state.lastError, userDataDir: USER_DATA_DIR })
    }
    if (url.pathname === '/do') return send(res, 200, await doAction(q))
    if (url.pathname === '/tabs') {
      const pages = await allPages()
      const tabs = []
      for (let i = 0; i < pages.length; i++) {
        let vis = false, title = ''
        try { vis = (await pages[i].evaluate(() => document.visibilityState)) === 'visible' } catch { /* mid-navigation */ }
        try { title = await pages[i].title() } catch { /* mid-navigation */ }
        tabs.push({ i, visible: vis, isVideo: VIDEO_URL.test(pages[i].url()), title: title.slice(0, 70), url: pages[i].url().slice(0, 110) })
      }
      return send(res, 200, { count: tabs.length, tabs })
    }
    if (url.pathname === '/state') {
      // state must report the VIDEO tab, not whatever tab happens to be current:
      // a home page also has a hover-preview <video>, so the old version reported
      // "found: true, duration: 76" from the front page while the real episode sat
      // in another tab.
      let p = await page()
      const picked = await videoPage(q)
      if (picked.page) {
        p = picked.page
        state.page = p
      }
      return send(res, 200, {
        url: p.url(),
        title: await p.title(),
        media: await mediaState(p),
        tabReason: picked.reason,
        hasVideoTab: !!picked.page,
      })
    }
    if (url.pathname === '/stop') {
      send(res, 200, { stopping: true })
      setTimeout(async () => {
        try { if (state.context) await state.context.close() } catch { /* gone */ }
        process.exit(0)
      }, 50)
      return
    }
    return send(res, 404, { error: 'no such route: ' + url.pathname })
  } catch (e) {
    state.lastError = String(e && e.message)
    log('route ' + url.pathname + ' failed: ' + String(e && e.stack))
    return send(res, 500, { error: state.lastError })
  }
})

// Screenshots accumulate: one subtitle crop every couple of seconds piled up
// 469MB in two days, and nothing ever deleted them. Keep a rolling window so the
// folder cannot grow without bound.
const KEEP_SHOTS = Number(process.env.DSH_SHOT_KEEP || 400)

function pruneShots() {
  try {
    const names = readdirSync(SHOT_DIR).filter((n) => /\.(png|jpg)$/i.test(n))
    if (names.length <= KEEP_SHOTS) return 0
    const withTime = names.map((n) => {
      const p = join(SHOT_DIR, n)
      let m = 0
      try { m = statSync(p).mtimeMs } catch { /* vanished */ }
      return { p, m }
    }).sort((a, b) => b.m - a.m)
    let removed = 0
    for (const f of withTime.slice(KEEP_SHOTS)) {
      try { unlinkSync(f.p); removed += 1 } catch { /* in use */ }
    }
    if (removed > 0) log('pruned ' + removed + ' screenshots (keep ' + KEEP_SHOTS + ')')
    return removed
  } catch (e) {
    log('shot prune failed: ' + String(e && e.message).slice(0, 120))
    return 0
  }
}

server.listen(cfg.port, '127.0.0.1', () => {
  try { writeFileSync(join(STATE_DIR, 'daemon.pid'), String(process.pid), 'utf8') } catch { /* best effort */ }
  log('browser daemon listening on 127.0.0.1:' + cfg.port)
  console.log('dsh-watch-browser daemon on http://127.0.0.1:' + cfg.port)
  console.log('screenshots: ' + SHOT_DIR + '  (keeping last ' + KEEP_SHOTS + ')')
  pruneShots()
  setInterval(pruneShots, 5 * 60 * 1000).unref()
})

process.on('SIGTERM', async () => {
  try { if (state.context) await state.context.close() } catch { /* gone */ }
  process.exit(0)
})

// Never die silently: an unhandled rejection used to take the whole daemon down
// with no log line, which looked exactly like "the service vanished".
process.on('unhandledRejection', (e) => log('unhandled rejection: ' + String((e && e.stack) || e)))
process.on('uncaughtException', (e) => log('uncaught exception: ' + String((e && e.stack) || e)))
