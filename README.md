# dsh-watch-together

给纯文本模型装上眼睛、耳朵和嘴。

装上之后，DSH 里的模型能看见你的屏幕、听见番里的对白和你说话，
并且真的开口回你——看番、看直播、看文档、打游戏，旁边都有个人在。

Windows · DeepSeek Harness 插件 · MIT

---

## 它由六个包组成

| 包 | 端口 | 负责什么 |
|---|---|---|
| `dsh-watch-eyes` | 37711 | 抓屏、视觉理解、窗口枚举 |
| `dsh-watch-ears` | 37712 | 录音、语音转文字 |
| `dsh-watch-mouth` | 37716 | 语音合成与播放 |
| `dsh-watch-browser` | 37713 | 驱动一个真实的 Edge/Chromium |
| `dsh-watch-hands` | 37717 | 按控件名操作 Windows 程序 |
| `dsh-watch-panel` | — | DSH 界面里的控制台 |

六个独立安装，一个挂了另外五个照常工作。
比如麦克风出问题，眼睛照样能看，只是暂时听不见。

---

## 安装

**需要先有：Windows、DSH 0.2.0-rc.1 以上、Node 22 以上。**

### 方式一：npm（一条命令装全）

```powershell
dsh plugin --profile desktop add dsh-watch-stack
```

只想要其中几个：

```powershell
dsh plugin --profile desktop add dsh-watch-eyes dsh-watch-mouth
```

### 方式二：从 GitHub 装单个包

```powershell
dsh plugin --profile desktop add "github:Eli-Mao/dsh-watch-together#path:packages/dsh-watch-eyes"
```

把 `dsh-watch-eyes` 换成上面表格里任意一个包名即可。
这种方式**只能一个个装**，不能一条命令装全。

### 方式三：下载源码

```powershell
git clone https://github.com/Eli-Mao/dsh-watch-together.git
cd dsh-watch-together
pnpm install
```

然后逐个挂进去：

```powershell
dsh plugin --profile desktop add link:$PWD/packages/dsh-watch-eyes
```

### 装完一定要重启 DSH

用应用里的「退出」或「重启」。**不要用任务管理器强杀**——
那样会把 Chromium 的登录数据写坏，下次可能起不来。

---

## 配置：需要你自己的三个 key

包里**没有任何 key**，作者的凭据不会被打包。
每个能力都要你自己填，填在 `~/.dsh-watch-<名字>/config.json`。

| 能力 | 必须吗 | 用途 |
|---|---|---|
| 视觉 | **必须** | 否则它看不见，其他都白搭 |
| 语音 | 可选 | 不填也能出声，用微软的免费音色 |
| 听觉 | 可选 | 不填就只能靠看，听不见声音 |

### 视觉（必须）

去 [智谱 BigModel](https://open.bigmodel.cn) 注册，拿一个 API key：

```powershell
npx -y -p dsh-watch-eyes eyes config set provider.apiKey 你的key
```

或者设环境变量 `ZHIPU_API_KEY`，插件启动时自动读进去。

### 语音（可选）

不填就用微软 Edge 的免费音色，能说话，但音色是那几个常规的。

想换成自己的服务——**任何支持 OpenAI `/v1/audio/speech` 的服务都行**：

```powershell
npx -y -p dsh-watch-mouth mouth config set tts.provider openai
npx -y -p dsh-watch-mouth mouth config set tts.openai.baseUrl 你的服务地址
npx -y -p dsh-watch-mouth mouth config set tts.openai.apiKey 你的key
npx -y -p dsh-watch-mouth mouth config set tts.openai.voice 音色名
```

SiliconFlow 的预置音色要带模型前缀，例如 `FunAudioLLM/CosyVoice2-0.5B:anna`；
只写 `anna` 也可以，baseUrl 是 SiliconFlow 时插件会用 `tts.openai.model` 自动补上。

也可以填 MiniMax、Azure，或者用环境变量
`MINIMAX_API_KEY` / `SILICONFLOW_API_KEY` / `AZURE_SPEECH_KEY`。

想知道现在会用哪个音色：

```powershell
npx -y -p dsh-watch-mouth mouth voice
```

### 听觉（可选）

两条路，选一条就行。

**走 API（不用显卡）**：

```powershell
npx -y -p dsh-watch-ears ears config set asr.apiKey 你的key
```

**走本地（免费，要显卡）**：

```powershell
pip install faster-whisper onnxruntime
```

再把模型目录告诉它（模型约 1.5G，显存也要约 1.5G）：

```powershell
$env:DSH_WHISPER_MODELS = "你的模型目录"
```

模型名 `models--mobiuslabsgmbh--faster-whisper-large-v3-turbo`。
如果模型放在 `~/.cache/huggingface/hub`，这一步可以省掉。

**不确定该走哪条？跑一下就知道了**：

```powershell
npx -y -p dsh-watch-ears ears asr
```

它会告诉你当前用的是哪条、本地能不能跑、不能跑缺什么。

---

## 装完怎么验

**看能不能看**：

```powershell
npx -y -p dsh-watch-eyes eyes look --prompt "一句话说屏幕上是什么"
```

一两秒返回一句人话，就是好的。
如果报 `no apiKey configured`，说明视觉 key 还没填。

**看能不能说**：

```powershell
npx -y -p dsh-watch-mouth mouth say "测试一下"
```

有声音就对了。

**看整体状态**：

```powershell
npx -y -p dsh-watch-ears ears status
```

重启 DSH 之后，对话栏右上角应该多一个「看番」按钮，
点开就是六个服务的开关和状态。

---

## 用起来是什么样

配合 `watch-together` 技能使用（技能市场可以装）。

简单说，它会：

- **看番时**：读字幕追剧情，自己判断该不该吐槽
- **看屏幕时**：盯着你前台那个窗口，直播、文档、游戏都算
- **语音通话时**：听你说话，一两秒内回你

插件负责感官（看、听、说），技能负责怎么用这套感官陪你。

---

## 配置和数据在哪

```
~/.dsh-watch-eyes/      抓屏与视觉
~/.dsh-watch-ears/      录音与转写
~/.dsh-watch-mouth/     语音合成
~/.dsh-watch-browser/   浏览器
~/.dsh-watch-hands/     桌面操作
```

每个目录里：

- `config.json` — 设置
- `daemon.log` — 日志（超过 2MB 自动轮转）
- `data/` — 截图、录音这些跑出来的东西，可以直接删，会自己重建

想把数据挪到别的盘：

```powershell
$env:DSH_EYES_DATA / DSH_EARS_DATA / DSH_MOUTH_DATA / DSH_BROWSER_DATA / DSH_HANDS_DATA
```

---

## 关于那个「脸」

网上看到的那个 Live2D 形象窗口（表情、气泡、口型）是**单独的**，
不在这个包里——它是个 Electron 应用，三百多兆，塞不进 npm。

没有它整套照样能跑，只是没有画面上的角色，声音直接从音箱出来。

---

## 会遇到的情况

**字幕读不到**：字幕功能依赖隔离运行的 Chrome（端口 9222），
那个浏览器没开的话，画面还能看，字幕没有。这是正常的。

**第一次用没声音**：先跑 `mouth voice` 看它选了什么。
不填 key 时走 Edge 免费音色，微软那个端点偶尔会拒绝，这是已知的。

**装完没效果**：检查有没有重启 DSH。插件是在启动时挂载的。

**装的时候看到 `Ignored build scripts` 警告**：不影响使用，
是某个可选依赖想执行一个安装脚本，被 pnpm 默认拦了。

---

## 平台

**只支持 Windows。**

重度依赖 PowerShell、NAudio、Windows UI Automation、WASAPI 回环录音，
这些在别的系统上都要重写。

要求：DSH ≥ 0.2.0-rc.1、Node ≥ 22、PowerShell 5.1 以上。

---

## 文档

- [AGENT-INSTALL.md](./AGENT-INSTALL.md) —— 写成给 AI 看的，
  丢给你的 agent，它能自己判断该装什么、该问你要哪些 key
- [RELEASE.md](./RELEASE.md) —— 版本变更记录

---

## License

MIT
