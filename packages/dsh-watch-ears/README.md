# dsh-watch-ears

Hearing for text-only DSH models: the system audio (what the computer is
playing) and the microphone (what the person is saying) are recorded, split into
segments and transcribed, continuously, from a resident daemon.

## Why it works this way

- **Two captures, not one.** Loopback is the video; the microphone is the user.
  Keeping them apart is what makes "was that the film or was that you?" answerable.
- **Record first, resample later.** Pulling a resampler in real time from the
  capture callback starved and wrote 135 MB of near-silence for an 8 second
  clip. Recording the device format and transcoding the finished file is
  bounded and exact.
- **Pipeline the segments.** Recording the next segment starts before the
  previous one is uploaded, otherwise the ASR round trip leaves a hole and
  swallows whole words at every boundary.
- **Room tone never leaves the machine.** A segment below the per-source peak
  floor is dropped before upload.
- **The listener lives in the daemon.** An agent turn costs ~40 seconds; the
  listener runs at segment cadence instead.

## Layout

    lib/Ears.cs          NAudio capture + resample core (compiled to net/Ears.dll)
    lib/net/             NAudio 2.2.1 assemblies + Ears.dll
    lib/worker.ps1       resident recorder, one process per source
    lib/recorder.mjs     worker lifecycle
    lib/asr.mjs          Zhipu /audio/transcriptions call
    lib/listener.mjs     the continuous listen loop
    lib/daemon.mjs       loopback HTTP server on 127.0.0.1:37712
    lib/push.mjs         salience pump: wakes a session only on a real event
    lib/ocr.mjs          warm Windows OCR worker for the subtitle band
    lib/index.js         cordis plugin: hear_now / hear_recent / hearing / watch_push
    bin/ears.mjs         the same pipeline as a CLI

## What this daemon does NOT do (since 2026-10-26)

There is no conversation loop and no brain here any more. `converse.mjs`,
`cfg.brain` and the `/converse/*` routes are deleted: they drove a chat model
directly, bypassing the agent turn, and that is the path docs/FINAL-ARCH.md
retired (it was also 429-exhausted). Thinking belongs to the session, speaking
belongs to the mouth (37716).

    ears inject --source mic "假装听到的话"

The inject seam still exists: it pretends something was heard so a pusher's
digest path can be exercised end to end without a human in the room.

## Always listening, occasionally speaking (watch_push)

A reminder loop cannot do this affordably. A reminder wakes a whole session,
which re-reads its entire history, so cost grows quadratically: at a 10 second
tick that is roughly 100M input tokens over two hours. Waking only on salient
events is linear and costs about 1/300th of that.

    watch_push action=probe                       # what does this host expose?
    watch_push action=start target=<session id>   # begin pushing
    watch_push action=stop | action=status

The pump runs in the DSH host because only the host owns the inbox delivery seam
(ctx.subagents). It polls the ears digest, and on a salient event splices a
compact message into the target session, which then runs one small turn and
decides whether to speak. The target session's context therefore grows only per
salient event, not per tick.

Delivery tries the host methods in order (followup, deliver, queue, sendMessage)
and records which one worked in the status output.

### Verified on this machine (2026-10-23)

    live host probe:
      subagents  followup=undefined deliver=undefined queue=undefined
                 sendMessage=function      <- the ONLY method that exists here
      agents     store / factory / initiators

The fallback chain is therefore not belt-and-braces, it is the mechanism: this
host exposes exactly one delivery method and the pusher must find it.

    mic path    fake speech injected  -> pushed via sendMessage -> watcher SPOKE
    video path  2 pushes in 105s      -> watcher stayed SILENT (45s throttle)
    outcome     speaker counter unchanged across the video pushes,
                then rose only when the watcher judged a line worth saying.

Two things that bit us, both fixed:
    export const inject = ['tools','agents','subagents']
        without it cordis refuses the service ("cannot get property without inject")
    the video branch must decide on the window total, not the 4 second delta,
        or the threshold is never reached

## Rebuilding the capture core

    csc @lib/build.rsp

Run it from the package root: the paths in the response file are relative to
it. The response file references the .NET 4.8 netstandard facade, without which the
netstandard2.0 NAudio assemblies cannot be referenced.

## Config

    ~/.dsh-watch-ears/config.json

    asr.model              default glm-asr-2512
    capture.sampleRate     default 16000
    capture.segmentSeconds default 6
    capture.silencePeak    default 0.004   (loopback floor)
    capture.silencePeakMic default 0.02    (microphone floor, higher)
    capture.sources        default ["loop","mic"]
    hotwords               domain words to bias recognition

## CLI

    ears hear   --source loop --seconds 6 --text
    ears listen start --segment 6 --sources loop,mic
    ears listen stop | ears listen status
    ears heard  --seconds 300
    ears devices | ears status | ears stop | ears config

## Known limits

- Roughly 100 ms of audio is lost at each segment boundary, because the worker
  stops one capture before starting the next.
- The API caps a transcription request at 30 seconds, so segmentSeconds must
  stay below that.
- Recording Windows audio needs no elevation, but a machine with no active
  render device yields silence.
