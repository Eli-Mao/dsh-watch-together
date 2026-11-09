# dsh-watch-mouth

一个服务只干一件事：**出声**。

```
37716  嘴    合成 + 播放 + 口型时钟
```

以前嘴住在眼里（37711）。拆出来的原因很实在：

- 抓屏 worker 崩了不该顺带把嗓子弄哑，反过来也一样。
- 声音只有一个主人。设备钉住（Voicemeeter）、队列、打断，都只在一个进程里。
- face（37714）只管形象，需要声音时问嘴要，不再自己合成一份。

## 与其它服务的关系

```
                     ┌──────────────┐
   avatar / 脑 ──────→│  嘴 37716    │──→ 扬声器
                     └──────┬───────┘
                            │ /mouth /said
                     ┌──────┴───────┐
                     │  脸 37714    │  口型 + 表情 + 气泡
                     └──────────────┘
```

- **脸**（可选，单独分发）轮询 `/mouth` 驱动口型，调用 `/say?async=1` 让嘴出声。
- **耳**（37712）读 `/said` 把回环录音里自己的声音剔掉，免得把自己的话当剧情点评第二遍。

## 路由

```
GET /health                    voice / provider / speaking / spoken / device
GET /say?text=...&async=1      说话（async=1 排队即返）
GET /said                      最近说过什么
GET /mouth                     口型时钟：speaking / elapsedMs / remainingMs
GET /devices                   播放设备表
GET /stop                      停
```

## CLI

```powershell
npx mouth say "你在看什么呢"
npx mouth status
npx mouth devices
npx mouth stop
```

## 配置

`~/.dsh-watch-mouth/config.json`，第一次启动会从 `~/.dsh-watch-eyes/config.json`
把 tts 与 output 段抄过来（键只抄一次，之后以嘴自己的为准）。

    tts.provider        minimax | openai | azure | glm | edge
    tts.minimax.*       key / voiceId / speed / pitch / emotion
    tts.glm.apiKey      glm-tts 的 key（provider 设成 glm 时，不填也会读 ZHIPU_API_KEY）
    output.deviceName   钉到某个播放设备（名字，不是序号）

## 已知坑

1. **MiniMax 最后一帧会把整段音频重发一遍**，跳过带 `extra_info` 的那帧，否则每句播两遍。
2. **PCM 只能走 base64 整行**：ReadLine 是带缓冲的，混着裸字节读会静默吞掉声音。
3. **设备要用名字定位**，WinMM 序号会随插拔变化。
4. **`/stop` 要先停播放再退**，否则 MediaPlayer 拿着设备不放，下次启动就是哑的。
