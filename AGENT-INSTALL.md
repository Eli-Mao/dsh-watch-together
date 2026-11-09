# 给 Agent 的安装与配置指南

> 这份文档是给**别的 agent**看的，不是给人看的。
> 读完之后你应该知道：要不要装、装哪个、缺什么、怎么问用户要 key、
> 怎么验证装成功了、出问题先看哪里。
> 用户问的是「陪我看番/看屏幕」这类需求时，直接照这份执行，不要反问一堆。

---

## 1. 前置要求

### 硬性（装不上就别装）

| 要求 | 检查 | 不满足的后果 |
|---|---|---|
| **Windows** | `$env:OS` | 六个包全部 `os: ["win32"]`，Linux/macOS 装不上 |
| **DSH >= 0.2.0-rc.1** | profile 的 `package.json` 里 `dsh.profile.bundles` 存在 | 老版本没有 bundle 通道，patch 不会被挂载 |
| **Node >= 22** | `node -v` | 包声明了 `engines.node >=22` |
| **PowerShell 5.1+** | 默认就有 | 抓屏、录音、桌面操作全走 PowerShell worker |

### 前置插件：**没有**

六个包之间**没有 npm 依赖关系**（除了 meta 包声明它们），
每个包只 peer-depend `@deepseek-ai/cordis`，那个是 DSH 自带的。
所以：

    dsh-watch-eyes      单独装也能用（有眼睛，没嘴）
    dsh-watch-mouth     单独装也能用（能说话，看不见）
    dsh-watch-hands     单独装也能用（能操作桌面）
    dsh-watch-panel     单独装就只有面板，按钮会显示"未安装"

**但是有软耦合**，装少了会缺能力但不报错：

| 装了这个 | 少了这个 | 会发生什么 |
|---|---|---|
| `eyes` | `mouth` | `screen_say` 报 "both down"，看能看，说不出话 |
| `eyes` | `face`（可选独立插件） | `screen_say` 自动退到 mouth，只出声，没有形象 |
| `mouth` | `eyes` | 声音正常，只是首次启动无法从 eyes 配置里借 TTS key |
| `ears` | `browser` | 能听，但看番时读不到字幕（字幕靠 9222 那个隔离 Chrome） |
| `panel` | 任何服务 | 面板里对应按钮显示未安装，其他按钮正常 |

**结论：想完整用就把六个包都作为 profile 的直接依赖装上（可以写在同一条 `add` 命令里，见第 2 节）。
不要装 meta 包 `dsh-watch-stack`：它虽然依赖全部六个，装上以后一个都不会被挂载。**

### 内置 inject（DSH 宿主提供的，用户无需处理）

    四个工具类包     inject = ['tools']
    ears             inject = ['tools', 'agents', 'subagents']   ← watch_push 需要
    panel            inject = ['webServer']                      ← 面板路由需要

如果 DSH 版本缺 `subagents` 服务，`watch_push` 会注册失败，
日志里是 `could not register watch_push`，其余工具照常。

---

## 2. 装

### `dsh` 命令不在 PATH 怎么办

在 DSH 桌面版里，`dsh` 通常**不在 PATH**（它是应用自带的运行时）。
能用的写法是 npx：

    npx -y @deepseek-ai/dsh plugin --profile <profile> add <包名>

下面所有命令都用 `dsh plugin ...` 简写，**执行时按实际情况补全**。

### 怎么装，取决于包从哪来

| 包从哪来 | 命令 | 说明 |
|---|---|---|
| **npm（已发布）** | `dsh plugin --profile desktop add dsh-watch-eyes dsh-watch-ears dsh-watch-mouth dsh-watch-browser dsh-watch-hands dsh-watch-panel` | 一条命令六个全装，**推荐** |
| **npm，只要某几样** | `dsh plugin --profile desktop add dsh-watch-eyes dsh-watch-mouth` | 想省事就别拆 |
| **本地 tgz** | `dsh plugin --profile desktop add .\\dsh-watch-eyes-0.1.0.tgz` | **六个逐个装，别装 meta** |
| **本地源码目录** | `dsh plugin --profile desktop add link:D:\\...\\packages\\dsh-watch-eyes` | 六个逐个 link，meta 别 link |

`<profile>` 是用户当前在用的那个，**别猜**：

    Get-ChildItem "$env:USERPROFILE\.dsh\profiles" -Directory | Select-Object Name

一般是 `desktop` 或 `web`。DSH 桌面版默认 `desktop`。

**为什么哪条路都不要装 meta**：DSH 装插件时，只把 profile 的**直接依赖**、
并且 `package.json` 里声明了 `dsh.bundle` 的包登记进 `dsh.profile.bundles`。
meta 包没有 `dsh.bundle`（装的时候会看到
`declares no dsh.bundle — installed as a plain dependency, not a profile layer`），
它带进来的六个包又只是间接依赖，所以装完重启一个工具都没有。
本地装还多一个问题：meta 包的依赖写的是 `workspace:*`（发布时由
`pnpm publish` 改写成真实版本号）。在本地环境里它解析不到工作区，
pnpm 就会去 registry 找那几个还没发布的包，直接 404。
所以**一律六个单独装**（可以写在同一条命令里）。

### 装完必须重启

bundle patch 是在启动时组合的，**不重启不生效**。
重启走应用内的退出/重启，**不要用任务管理器强杀**——会把 Chromium 的
`Network\Cookies` 写坏，下次启动直接起不来。

### 包名和命令名不是一回事

| 包 | 命令 | 说明 |
|---|---|---|
| dsh-watch-eyes | `eyes` | 单命令 |
| dsh-watch-ears | `ears` / `ears-companion` / `ears-live` / `ears-digest` | 四个命令 |
| dsh-watch-mouth | `mouth` | 单命令 |
| dsh-watch-browser | `browser` | 单命令 |
| dsh-watch-hands | `hands` | 单命令 |
| dsh-watch-panel | （无） | 只有面板 UI |

**多命令的包里，`npx <包名>` 会跑错命令**，要写成 `npx -y -p <包名> <命令>`。
下面统一用那个写法。

### 验证装进去了

profile 的 `package.json` 里应该多出：

    dsh.profile.bundles: [..., "dsh-watch-eyes", "dsh-watch-ears", ...]
    dependencies:        {"dsh-watch-eyes": "0.1.0", ...}

重启后，会话里应该多出这些工具：

    screen_look / screen_watch / screen_doctor / screen_say / screen_narrate
    hear_now / hear_recent / hearing / watch_push
    mouth_say / mouth_say_stream / mouth_status
    browser_do / browser_state
    hands_act / hands_batch / hands_state

**工具数量对不上就是没挂载成功，先查 bundle 列表，别急着调工具。**

---

## 3. 配置：怎么跟用户确认

> **这个插件包里没有任何 key。** 作者的 key 不会被打包，也不会有默认值。
> 三个能力各自要 key：视觉（必须）、语音（可选）、听觉（可选）。
> 每个都是用户自己填空、存在用户自己的 `~/.dsh-watch-*/config.json` 里。
> 你唯一的任务是**问清楚他有没有**，然后把值写进他的配置，不要猜。
>
> 另外**不要替用户选音色、选模型**。他有什么就用什么；他说没有，就告诉他
> 默认那条免费的路能用但可能不稳，让他自己决定要不要接。

装完之后**不要自己瞎猜 key**，也不要假装配好了。按下面顺序问。

### 3.1 先跑体检，让用户看到现状

    npx -y -p dsh-watch-eyes eyes doctor
    npx -y -p dsh-watch-ears ears status
    npx -y -p dsh-watch-mouth mouth status

三份输出决定要问什么：

| 输出 | 含义 | 要问用户 |
|---|---|---|
| `hasKey: false` 或 `probe.status: 401` | 视觉瞎了 | 要智谱 key |
| `provider: edge` | 只有免费音色 | 问要不要更好的音色（要 key） |
| `asrBackend: cloud` + `errors > 0` | 云端转写没配 key | 问要 key 还是要本地 whisper |
| 全部 OK | 齐了 | 什么都不用问 |

### 3.2 视觉 key（**唯一必须的**）

**没有这个，眼睛就是瞎的，整个技能没有意义。**

问法（一句话，别列清单）：

> 「眼睛要用智谱的视觉模型，你有 bigmodel 的 key 吗？没有的话去
> open.bigmodel.cn 注册，免费额度够看很久。」

拿到之后：

    npx -y -p dsh-watch-eyes eyes config set provider.apiKey <key>

或者让用户自己设环境变量，插件会自动读：

    $env:ZHIPU_API_KEY = "<key>"     # 也认 GLM_API_KEY / DSH_VISION_API_KEY

**注意**：环境变量优先于配置文件里空的 key。
配置里已经有非空 key 时就以配置为准，不再被环境变量覆盖。

默认模型 `glm-4.6v`，失败会依次退到 `glm-5v-turbo` → `glm-4.6v-flashx` → `glm-4v-flash`。
**付费额度用完时只有 flash 还能用**，所以别把 fallback 链删了。

### 3.3 语音：音色由用户自己定

**关键：不要替用户选音色，也不要把我们的音色写成默认宣传语。**
插件不带任何 key，装完就是 Edge 的免费音色；想要别的得他自己接。

先跑这个，把现状给他看：

    npx -y -p dsh-watch-mouth mouth voice

输出直接告诉他现在会用哪个、哪个 key 有、哪个没有：

    {
      "configuredProvider": "auto",
      "keysPresent": { "minimax": false, "openai": false, "azure": false, "glm": false, "edge": true },
      "willUse": "edge",
      "voice": "zh-CN-XiaoyiNeural",
      "note": "Edge is free and needs no key, but Microsoft may refuse the handshake..."
    }

#### 四个选项，让他挑

| 走哪条 | 要什么 | 特点 |
|---|---|---|
| **Edge（默认）** | 不用 key | 免费，微软那几个音色；**但微软的免费端点经常拒握手**，稳定性差 |
| **自备 OpenAI 兼容** | baseUrl + key + model + voice | **最推荐给第三方**：任何说 `/v1/audio/speech` 的服务都能接（硅基流动、DashScope 兼容模式、自建网关） |
| **MiniMax** | apiKey + groupId | 音色最好，按字收费 |
| **Azure** | apiKey | 和 Edge 同一批音色但走付费端点，稳定 |

#### 接自己的服务（重点）

    npx -y -p dsh-watch-mouth mouth config set tts.provider openai
    npx -y -p dsh-watch-mouth mouth config set tts.openai.baseUrl   https://你的服务/v1
    npx -y -p dsh-watch-mouth mouth config set tts.openai.apiKey    <key>
    npx -y -p dsh-watch-mouth mouth config set tts.openai.model     <模型名>
    npx -y -p dsh-watch-mouth mouth config set tts.openai.voice     <音色名>

**`tts.provider = openai` 是把他自己的服务放到第一位**，
不设的话 `auto` 会先试 MiniMax，容易接错。

环境变量也可以：`MINIMAX_API_KEY` / `MINIMAX_GROUP_ID` / `SILICONFLOW_API_KEY` / `AZURE_SPEECH_KEY`。

#### 音色本身

    npx -y -p dsh-watch-mouth mouth config set voice zh-CN-XiaoyiNeural
    npx -y -p dsh-watch-mouth mouth config set prosody.rate +15%

音色名是该服务自己的命名，**不要写死成我们的**。Edge 的音色是微软那套
（`zh-CN-XiaoyiNeural` 等），自备服务的音色看它的文档。

**不要问的**：别建议用户"用某个具体音色"，他不知道你喜欢哪个。
问的是「你想用自己的 TTS 吗，有的话 baseUrl 和 key 给我」。

### 3.4 听觉（可选，但看番想要）

**先问一句，别替他决定**：

> 「要能听见你说话和番里的声音，两个办法：
> 用云端转写（要一个 key，按量花钱），
> 或者装本地 whisper（免费，但要显卡和 1.5G 显存）。
> 你机器什么情况？」

然后**跑一次这个命令再问**，它会直接告诉你能不能本地：

    npx -y -p dsh-watch-ears ears asr

输出里看三个字段：

| 字段 | 含义 |
|---|---|
| `wanted` | 配置里写的选择（默认 `auto`） |
| `running` | 现在实际在用哪个 |
| `localPossible` / `localWhy` | 本地能不能跑；不能的话缺什么 |

**三种模式，写进配置就生效**（重启 daemon）：

    npx -y -p dsh-watch-ears ears config set asr.backend auto    # 默认：能本地就本地
    npx -y -p dsh-watch-ears ears config set asr.backend local   # 只用本地，跑不了就报错
    npx -y -p dsh-watch-ears ears config set asr.backend cloud   # 只用 API

`auto` 的判定是三件事都要成立：有 python、那个 python 能 `import faster_whisper`、
模型目录存在。**任何一条不满足都不算"能本地"**，会退回 cloud 并在 `localWhy` 里写原因。

#### 走 API

    npx -y -p dsh-watch-ears ears config set asr.apiKey <key>

也认环境变量 `ZHIPU_API_KEY` / `GLM_API_KEY`。
**没 key 时 status 会明确说**：`"using the vendor API but asr.apiKey is EMPTY"`，
不是默默失败。

#### 走本地

三步，缺一步它都会在 `localWhy` 里点名：

    pip install faster-whisper onnxruntime

    # 模型：models--mobiuslabsgmbh--faster-whisper-large-v3-turbo
    # 放到一个目录，然后把目录告诉它
    $env:DSH_WHISPER_MODELS = "C:\\models\\hub"

    # python 不在 PATH 的话
    $env:DSH_WHISPER_PYTHON = "C:\\Python312\\python.exe"

或者写进配置：

    npx -y -p dsh-watch-ears ears config set asr.local.python <python.exe>
    npx -y -p dsh-watch-ears ears config set asr.local.models <模型目录>

**默认会去找标准缓存**：`~/.cache/huggingface/hub` 和 `$HF_HOME/hub`。
所以如果模型是 `pip install` 之后让 faster-whisper 自己下的，
不设 `DSH_WHISPER_MODELS` 也能找到。

模型大小：`large-v3-turbo` 约 1.5G，显存占用约 1.5G。
3080 以上级别的卡能跑得很快；**没有独显就别建议本地**。

#### 运行时切换（不用重启）

    curl "http://127.0.0.1:37712/asr/backend?set=local"
    curl "http://127.0.0.1:37712/asr/backend?set=cloud"
    curl "http://127.0.0.1:37712/asr/backend"

打游戏时让他切 cloud，本地 whisper 抢显存。

#### 它会自己做的事（不用你配，但要知道）

- VAD 先跑，**没结果才回退到无 VAD 解码**（安静的麦克风会被 VAD 整段滤掉）
- 无 VAD 的结果过两道滤：`no_speech_prob > 0.75` 丢、不同字占比 < 25% 丢
  （那是重复幻觉，不是句子）
- 45 秒内同源完全相同的一行不记（whisper 在静音上会循环说同一句）
- worker 起不来会**杀掉进程**再报错，不留占显存的孤儿
- 转写结果按 UTF-8 字节输出（Windows 管道默认 GBK，中文会全糊）

### 3.4b 竖屏视频 / 没字幕的视频

不用配，插件自己判断。但要知道它是怎么判断的，免得把"读不到字幕"当故障：

- **裁条比例自适应**：视频高度 > 宽度时用 0.3，否则 0.2。
  分界线是「连续多少行像素有文字」——真字幕 25-32 行，画面只有 6-7 行。
- **整集没有可读字幕**时，连续空 120 次后推注器会标记不可用，
  推送里告诉分身"这是耳朵听到的声音，不是字幕原文"。
  这时候别建议用户去调字幕，那本来就没有。

### 3.5 不要问的

- **脸（37714）**：383MB 的 Electron 应用，不在 npm 里。用户没主动提就别问。
  真要装，设 `DSH_FACE_CLI` 指过去。
- **B 站账号**：不要替用户登录，别开放行——有极验风控，实测封过号。
  用户要看得自己登录。

---

## 4. 装完自检（三分钟）

### 4.1 服务能起

    npx -y -p dsh-watch-eyes eyes status

期望：`{"ok": true, "pid": ..., "port": 37711}`。

五个服务端口：眼睛 37711、耳朵 37712、浏览器 37713、嘴 37716、手 37717。

### 4.2 眼睛真能看

    npx -y -p dsh-watch-eyes eyes look --prompt "一句话说屏幕上是什么"

期望：返回 `text` 是一句人话，`totalMs` 在 1-3 秒。
**没 key 的话这里会报 `no apiKey configured`，回到 3.2。**

### 4.3 嘴真能出声

    npx -y -p dsh-watch-mouth mouth say "测试一下"

期望：`spoken: true`，扬声器有声音。没声音就查 `mouth status` 的 `lastError`。

### 4.4 整套连起来

启动 DSH，看对话栏右上角有没有「看番」按钮。
点开 → 一键全启 → 状态点全绿。

或者不点面板，直接让 agent 干：

    screen_look              → 应该返回屏幕描述
    screen_say "测试"        → 应该出声
    hear_now seconds=3       → 应该返回听到的话（没配听觉会报错，属正常）

---

## 5. 出问题先看哪里

按顺序，别跳步。

| 现象 | 先查 | 大概率原因 |
|---|---|---|
| 工具根本没出现 | profile `package.json` 的 bundles | 没重启 / 没挂载上 |
| `screen_look` 报 no apiKey | `eyes doctor` | key 没配（第 3.2） |
| `screen_look` 报 429 | `eyes doctor` 里的 `probe` | 额度用完，靠 flash 兜底 |
| 能看不能说话 | `mouth status` | 嘴没起，或 face 和 mouth 都挂了 |
| 说话没声音 | `mouth status` 的 `lastError` | 供应商全挂，或音频设备不对 |
| 听不见用户 | `ears status` 的 `listening` | 没 start；或后端挂了 |
| 转写一直失败 | `curl 37712/asr/backend` | 选了 local 但没装 whisper |
| 看番读不到字幕 | 9222 端口 | 隔离 Chrome 没起，`npx -y -p dsh-watch-browser browser launch-cdp` |
| 面板按钮全失败 | 面板返回的 `out` 字段 | 兄弟包没装（会显示 "not installed: <path>"） |
| 端口被占 | `status` 报 `port already in use` | 同一套装了两份，先把旧的停掉 |
| 装的时候报 `IGNORED_BUILDS msedge-tts` | 无害 | Edge TTS 那条兜底不装也能跑，配了 key 就用不上它 |

日志位置（每个服务一份，超过 2MB 自动轮转一次）：

    %USERPROFILE%\.dsh-watch-eyes\daemon.log
    %USERPROFILE%\.dsh-watch-ears\daemon.log
    %USERPROFILE%\.dsh-watch-mouth\daemon.log
    %USERPROFILE%\.dsh-watch-browser\daemon.log
    %USERPROFILE%\.dsh-watch-hands\daemon.log

配置位置：同目录的 `config.json`。想整个搬走数据，设 `DSH_*_DATA` 环境变量。

---

## 6. 和旧版共存的问题（务必提前说）

如果用户机器上原来装过 `dsh-ears` / `dsh-screen-eyes` / `dsh-mouth` / `dsh-browser` / `dsh-hands`，
**不能和新版同时启用**：

- 端口撞（37711/37712/37713/37716/37717 是一样的）
- 工具名撞（`screen_look` / `screen_say` / `hear_now` / `mouth_say` / `hands_act`）

状态目录是分开的（`~/.dsh-ears` vs `~/.dsh-watch-ears`），配置不会互相覆盖，
但**同一分钟起两个 daemon 会抢端口**，表现是后起的那个 status 报 "port already in use"。

换新版前先（`remove` 一次只接受一个名字，写五遍别写成一行）：

    dsh plugin --profile desktop remove dsh-ears
    dsh plugin --profile desktop remove dsh-screen-eyes
    dsh plugin --profile desktop remove dsh-mouth
    dsh plugin --profile desktop remove dsh-browser
    dsh plugin --profile desktop remove dsh-hands
    # 然后重启 DSH，再装新版

---

## 7. 装完之后该干什么

装完别急着让用户点播放。按这个顺序：

1. 报一句「装好了，眼睛/嘴/耳朵各是什么状态」，**具体到哪样能用哪样不能用**。
2. 如果缺 key，**一句一句问，一次只问一样**，别甩清单。
3. 用户说「可以了」之后，再用 `watch-together` 技能起分身、挂推注器。

技能那边的完整流程在 `watch-together` 技能里，这份文档只管装和配。
