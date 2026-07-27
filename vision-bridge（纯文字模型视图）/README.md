# vision-bridge

vision-bridge 是一款为纯文本模型 AI 工具开发的多模态桥接插件。它通过 Hook 或 CLI 拦截消息中的图片内容，调用一个独立的视觉模型将图片转为文字描述后回传给主模型，使 DeepSeek 等不支持视觉的模型也能间接"看懂"图片。内置三种工作模式——通用描述、OCR 逐字提取、图表转 Markdown。支持自动识别用户已配置的 API 凭证，优先匹配同品牌视觉模型（如主模型用 DeepSeek 则自动选 DeepSeek VL2，主模型用 OpenAI 则选 GPT-4o-mini），大部分品牌在已配置密钥的情况下无需额外设置。适配 MiMoCode、Claude Code、Codex、Aider、Cursor 等主流 AI 工具，提供一键安装提示词，支持让 AI 工具自行完成安装。

---

*vision-bridge is a multimodal bridging plugin built for text-only-model AI tools. It intercepts image content in messages via hooks or CLI, calls a separate vision model to convert the image into a text description, and passes it back to the main model — enabling vision-incapable models like DeepSeek to "see" images indirectly. It offers three modes: general description, verbatim OCR extraction, and table/chart-to-Markdown conversion. Credentials are auto-detected from the user's existing AI tool configuration, with same-brand vision model matching (e.g. DeepSeek main model → DeepSeek VL2 vision model; OpenAI main model → GPT-4o-mini), requiring no additional setup for most brands once an API key is configured. Compatible with MiMoCode, Claude Code, Codex, Aider, Cursor, and other major AI tools. One-liner install prompts are provided so the AI tool can self-install the plugin.*

- **零配置启动** — 自动检测已配置的 API Key，同品牌匹配视觉模型
- **AI 自判断** — 图片类型自动识别（文字/表格/照片），选最佳输出格式
- **三种模式** — 通用描述 / OCR 逐字提取 / 图表转 Markdown
- **跨工具** — MiMoCode / Claude Code / Codex / Aider / Cursor / 任意 CLI 工具

## 一键安装

把下面这句话发给你的 AI 工具即可。Just send the line below to your AI tool.

### MiMoCode

```
帮我把 vision-bridge 插件安装到这个项目中：从插件目录复制 .mimocode 文件夹到项目根目录，然后 cd .mimocode && npm install
```
```
Install the vision-bridge plugin into this project: copy the .mimocode folder from the plugin directory to the project root, then run `cd .mimocode && npm install`.
```

### Claude Code

```
帮我把 vision-bridge 插件安装到 Claude Code 中：复制 vision-core.ts 到 .claude/hooks/，复制 adapters/claude-code/vision-bridge.ts 到 .claude/hooks/，然后 cd .claude/hooks && npm install
```
```
Install the vision-bridge plugin into Claude Code: copy vision-core.ts to .claude/hooks/, copy adapters/claude-code/vision-bridge.ts to .claude/hooks/, then run `cd .claude/hooks && npm install`.
```

### Codex

```
帮我在项目根目录创建 CODE.md，加入规则：每次遇到图片时先执行 node /path/to/vision-bridge.mjs --image "<url>" 描述图片内容再分析。配置自动检测 VISION_API_KEY。
```
```
Create a CODE.md in the project root with the rule: whenever encountering an image, first run `node /path/to/vision-bridge.mjs --image "<url>"` to describe it before analyzing. Auto-detect VISION_API_KEY from config.
```

### Cursor

```
帮我在 .cursorrules 中加一条规则：分析图片前先调用 node /path/to/vision-bridge.mjs --image "<url>" 获取文字描述
```
```
Add a rule to .cursorrules: before analyzing an image, run `node /path/to/vision-bridge.mjs --image "<url>"` to get a text description first.
```

### Aider

```
帮我在 .aider.conf.yml 中加预处理命令：preprocess-command: node /path/to/vision-bridge.mjs，并设置 VISION_API_KEY 环境变量
```
```
Add a preprocess command to .aider.conf.yml: `preprocess-command: node /path/to/vision-bridge.mjs`, and set the VISION_API_KEY environment variable.
```

### 通用 / Generic (any tool)

```
安装 vision-bridge 视觉桥接工具：配置 VISION_API_KEY 环境变量为你的 API Key，然后用 node vision-bridge.mjs --image "<data-url>" 或通过管道 node vision-bridge.mjs 处理图片。支持自动检测 MiMoCode/Claude Code/Codex 的 API Key。
```
```
Install the vision-bridge tool: set the VISION_API_KEY environment variable to your API key, then use `node vision-bridge.mjs --image "<data-url>"` or pipe text through `node vision-bridge.mjs`. Auto-detects API keys from MiMoCode, Claude Code, and Codex configs.
```

## 自动检测机制

插件按以下优先级自动发现可用的视觉模型 API：

```
① 环境变量 VISION_API_KEY / VISION_MODEL / VISION_BASE_URL
     ↓ 未设
② 读取工具配置文件
   MiMoCode:   ~/.local/share/mimocode/auth.json
   Claude Code: ~/.claude/settings.json, ~/.claude/credentials.json
   Codex:       ~/.codex/config.yaml / config.toml
     ↓ 找到 API Key
③ 同品牌匹配
   主模型用 DeepSeek → 自动选 deepseek-vl
   主模型用 OpenAI   → 自动选 gpt-4o-mini
   主模型用 Claude   → 自动选 claude-3-5-haiku
   主模型用 Codex    → 自动选 gpt-4o-mini（Codex = OpenAI 品牌）
     ↓ 无同品牌
④ 取第一个可用供应商的视觉模型
     ↓ 无可用
⑤ 报警：VISION_API_KEY not set
```

也自动识别常见环境变量：`OPENAI_API_KEY` `ANTHROPIC_API_KEY` `DEEPSEEK_API_KEY` `GOOGLE_API_KEY` `GROQ_API_KEY` `XAI_API_KEY`

## 工作模式

| 模式 | 触发方式 | 效果 |
|------|---------|------|
| **auto** | 默认，无需任何关键词 | 视觉模型自行判断图片类型，自动选择输出格式 |
| **ocr** | 消息含 `OCR` / `提取文字` / `识别文字` / `copy text` | 逐字提取原文，保留行内缩进和版式 |
| **markdown** | 消息含 `表格` / `markdown` / `图表` / `转成` | 表格→pipe table / 代码→fence block |

## 架构

```
vision-core.ts             ← 核心逻辑（纯函数，零工具依赖）
    ↑ 导入
vision-bridge.ts           ← MiMoCode 适配器（仅 ~150 行）
bin/vision-bridge.mjs      ← 通用 CLI 工具（任意工具可用管道调用）
bin/describe-file.mjs      ← 本地图片文件描述
bin/web-vision.mjs         ← 网页截图转视觉识别（SPA 兼容）
adapters/                  ← 各工具适配指南和模板
```

## 文件说明

| 文件 | 用途 |
|------|------|
| `vision-core.ts` | 核心层：图片检测、模式识别、缓存、API 调用。可被任意 JS/TS 项目导入 |
| `vision-bridge.ts` | MiMoCode Hook 适配器，安装到 `.mimocode/hooks/` 自动热加载 |
| `bin/vision-bridge.mjs` | 独立 CLI 工具，从 stdin 读文本/图片，输出描述文字 |
| `bin/describe-file.mjs` | 本地图片文件描述：`node describe-file.mjs screenshot.png` |
| `bin/web-vision.mjs` | 网页全页截图 + 视觉识别，解决 SPA 页面抓取问题 |
| `adapters/codex.md` | Codex 完整适配指南（CLI 方式 + CODE.md 规则） |
| `adapters/claude-code.md` | Claude Code 钩子适配指南 |
| `adapters/claude-code/vision-bridge.ts` | Claude Code 开箱即用的 Hook 文件 |
| `adapters/generic.md` | Aider / Cursor / Continue.dev 等通用适配指南 |

## CLI 用法

```bash
# 管道模式：扫描文本中的 data:image/... URL 替换为文字描述
echo "请看: data:image/png;base64,iVBOR..." | node vision-bridge.mjs

# 单图模式：直接描述一张图片
node vision-bridge.mjs --image "data:image/png;base64,iVBOR..."

# 本地文件描述
node describe-file.mjs screenshot.png

# 网页截图转文字（需先安装 puppeteer: npm install puppeteer）
node web-vision.mjs "https://example.com"
node web-vision.mjs --mode ocr "https://docs.example.com"
```

## web-vision：网页截图转视觉识别

> 一个独立的 CLI 工具，用 Puppeteer 浏览器引擎渲染网页并全页截图，再通过视觉模型将页面内容转为文字描述。解决传统 HTTP 抓取工具无法处理 SPA（React / Vue 单页应用）的问题。

### 特色

- **全页截图** — 截取整个网页，不限于可视区域
- **内存处理** — 截图仅在内存中生成 base64 data URL，用完即被 GC 回收，不写磁盘
- **零额外配置** — 自动复用 vision-bridge 的凭证检测与同品牌匹配
- **三种模式** — auto / ocr / markdown，与图片桥接一致

### 安装与使用

```bash
# 1. 安装浏览器驱动（仅一次）
npm install puppeteer

# 2. 描述网页（默认 auto 模式——自动识别页面类型输出）
node bin/web-vision.mjs "https://example.com"

# 3. OCR 模式——逐字提取页面可见文字
node bin/web-vision.mjs --mode ocr "https://docs.example.com"

# 4. Markdown 模式——将页面结构转为 Markdown
node bin/web-vision.mjs --mode markdown "https://blog.example.com"
```

### 工作流程

```
URL → Puppeteer 无头浏览器渲染 → 全页截图(base64 内存) → 视觉模型 → 文字描述
```

截图全程在内存中完成，不产生临时文件。视觉模型 API 调用走 vision-bridge 的自动检测机制，支持同品牌匹配。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VISION_API_KEY` | 视觉模型 API Key | 自动检测 |
| `VISION_MODEL` | 视觉模型 ID | 自动检测 |
| `VISION_BASE_URL` | API 地址 | 自动检测 |
| `VISION_MAX_TOKENS` | 最大输出 token | `512` |
| `VISION_CACHE_SIZE` | 缓存条目数 | `200` |
| `VISION_DEBUG` | 调试日志 | `0` |

MiMoCode 版本额外支持 `MIMOCODE_VISION_*` 前缀的环境变量。

## 视觉模型注册表

| 主模型品牌 | 自动选用视觉模型 | API 地址 |
|-----------|----------------|---------|
| DeepSeek | `deepseek-vl` | `https://api.deepseek.com/v1` |
| OpenAI | `gpt-4o-mini` | `https://api.openai.com/v1` |
| Anthropic | `claude-3-5-haiku-20241022` | `https://api.anthropic.com/v1` |
| Google | `gemini-2.0-flash` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| MiMo | `mimo-auto` | `https://api.mimo.xiaomi.com/v1` |
| Groq | `llama-3.2-11b-vision-preview` | `https://api.groq.com/openai/v1` |
| xAI | `grok-2-vision` | `https://api.x.ai/v1` |
| Ollama | `llava` | `http://localhost:11434/v1` |

新增供应商：在 `vision-core.ts` 的 `VISION_REGISTRY` 中添加一行即可。

## 平台支持

Windows / macOS / Linux 全平台通用，需 Node.js v18+ 或 Bun。
