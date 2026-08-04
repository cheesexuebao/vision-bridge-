/**
 * ============================================================
 * vision-core — 多模态视觉桥接 核心逻辑
 * ============================================================
 *
 * 本模块是跨 AI 工具可复用的纯逻辑层，不依赖任何特定工具。
 * 可在 MiMoCode、Claude Code、Codex、Aider 等任意 JS/TS 环境中使用。
 *
 * 包含：
 *   - 视觉模型注册表（供应商 → 视觉模型 映射）
 *   - 图片内容检测（5 种 Part 格式）
 *   - 三种描述模式（auto / ocr / markdown）+ 提示词模板
 *   - 模式检测（关键词扫描）
 *   - 视觉模型 API 调用（OpenAI 兼容格式）
 *   - SHA256 指纹缓存
 *   - 调试日志
 *
 * 用法：导入本模块，调用 createBridge(config) 生成一个 Bridge 实例。
 *       然后在目标工具的事件/钩子中调用 bridge.processMessages()。
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ============================================================
// 视觉模型注册表 — 供应商 → 视觉模型 映射
//
// 当你切换主模型品牌时，自动匹配同品牌的视觉模型。
// 新增供应商：在此表中添加一行。
// ============================================================
export const VISION_REGISTRY: Record<string, { model: string; baseURL: string }> = {
  deepseek:   { model: "deepseek-vl",                    baseURL: "https://api.deepseek.com/v1" },
  openai:     { model: "gpt-4o-mini",                   baseURL: "https://api.openai.com/v1" },
  anthropic:  { model: "claude-3-5-haiku-20241022",     baseURL: "https://api.anthropic.com/v1" },
  google:     { model: "gemini-2.0-flash",              baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
  mimo:       { model: "mimo-auto",                     baseURL: "https://api.mimo.xiaomi.com/v1" },
  groq:       { model: "llama-3.2-11b-vision-preview",  baseURL: "https://api.groq.com/openai/v1" },
  xai:        { model: "grok-2-vision",                 baseURL: "https://api.x.ai/v1" },
  ollama:     { model: "llava",                         baseURL: "http://localhost:11434/v1" },
  siliconflow:{ model: "Qwen/Qwen2.5-VL-7B-Instruct",   baseURL: "https://api.siliconflow.cn/v1" },
  moonshot:   { model: "kimi-k3",                       baseURL: "https://api.moonshot.cn/v1" },
}

// ============================================================
// 自动检测配置 — 跨工具通用
//
// 优先级：
//   1. 环境变量 VISION_API_KEY / VISION_MODEL / VISION_BASE_URL
//   2. 常见工具配置文件（MiMoCode auth.json / Claude Code settings.json）
//   3. 常见 API Key 环境变量（OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY …）
//   4. 同品牌匹配：检测活跃模型品牌 → 选同品牌视觉模型
//
// 导出 autoDetectConfig() 供各适配器调用。
// ============================================================

/** 已知的 API Key 环境变量 → 供应商 映射 */
const ENV_KEY_MAP: Array<{ key: string; provider: string }> = [
  { key: "DEEPSEEK_API_KEY",    provider: "deepseek" },
  { key: "OPENAI_API_KEY",      provider: "openai" },
  { key: "ANTHROPIC_API_KEY",   provider: "anthropic" },
  { key: "GOOGLE_API_KEY",      provider: "google" },
  { key: "GEMINI_API_KEY",      provider: "google" },
  { key: "GROQ_API_KEY",        provider: "groq" },
  { key: "XAI_API_KEY",         provider: "xai" },
  { key: "MIMO_API_KEY",        provider: "mimo" },
]

/** 自动检测结果 */
export interface AutoDetectResult {
  model: string
  apiKey: string
  baseURL: string
  /** 检测来源描述 */
  source: string
}

/** 通用文本文件读取（支持 JSON / YAML / TOML 的简单字段提取） */
function readConfigFile(path: string): Record<string, string> | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf-8")
    const result: Record<string, string> = {}

    // 尝试 JSON 解析
    try {
      const json = JSON.parse(raw)
      if (typeof json === "object" && json !== null) {
        for (const [k, v] of Object.entries(json)) {
          if (typeof v === "string") result[k] = v
        }
      }
      return result
    } catch { /* 非 JSON，尝试 YAML/TOML 简单解析 */ }

    // 正则提取 key: value 或 key = "value" 格式（兼容 YAML/TOML）
    const lines = raw.split("\n")
    for (const line of lines) {
      // YAML: key: value  或  key: "value"
      const yamlMatch = line.match(/^\s*(\w+)\s*:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/)
      if (yamlMatch) { result[yamlMatch[1]] = yamlMatch[2].trim(); continue }
      // TOML: key = "value"
      const tomlMatch = line.match(/^\s*(\w+)\s*=\s*["']([^"'\n]+)["']/)
      if (tomlMatch) result[tomlMatch[1]] = tomlMatch[2]
    }

    return Object.keys(result).length > 0 ? result : null
  } catch { return null }
}

/** 从 MiMoCode / Claude Code / Codex 等工具的认证文件中提取 API Key */
function detectKeysFromFiles(): Array<{ provider: string; key: string }> {
  const results: Array<{ provider: string; key: string }> = []

  // MiMoCode auth.json
  const mimoAuth = readJSON(join(homedir(), ".local", "share", "mimocode", "auth.json"))
  if (mimoAuth) {
    for (const [provider, entry] of Object.entries(mimoAuth)) {
      const key = (entry as { key?: string }).key
      if (key) results.push({ provider, key })
    }
  }

  // Claude Code settings.json
  const claudeSettings = readJSON(join(homedir(), ".claude", "settings.json"))
  if (claudeSettings) {
    const data = claudeSettings as Record<string, unknown>
    if (typeof data.apiKeyHelper === "string") results.push({ provider: "anthropic", key: data.apiKeyHelper as string })
    if (typeof data.openaiApiKey === "string") results.push({ provider: "openai", key: data.openaiApiKey as string })
  }

  // Claude Code credentials.json
  const claudeCreds = readJSON(join(homedir(), ".claude", "credentials.json"))
  if (claudeCreds) {
    if (typeof claudeCreds.apiKey === "string") results.push({ provider: "anthropic", key: claudeCreds.apiKey as string })
  }

  // Codex config（~/.codex/config.yaml 或 config.toml）
  for (const name of ["config.yaml", "config.toml", "config.json"]) {
    const codexConfig = readConfigFile(join(homedir(), ".codex", name))
    if (codexConfig) {
      // Codex 是 OpenAI 产品，API Key 可能在 openai_api_key / api_key 字段
      const key = codexConfig.openai_api_key || codexConfig.api_key || codexConfig.apiKey
      if (key) {
        // 去重检查
        if (!results.some(r => r.provider === "openai")) {
          results.push({ provider: "openai", key })
        }
      }
      break // 找到一个就停
    }
  }

  return results
}

/** 检测当前活跃的模型品牌（跨工具通用） */
export function detectActiveProvider(): string | null {
  // MiMoCode model.json
  const modelState = readJSON(join(homedir(), ".local", "state", "mimocode", "model.json"))
  if (modelState) {
    const recent = modelState.recent as Array<{ providerID: string }> | undefined
    const variant = modelState.variant as Record<string, string> | undefined
    if (recent) {
      for (const entry of recent) {
        if (entry.providerID === "mimo") continue
        const key = `${entry.providerID}/${(entry as { modelID: string }).modelID}`
        if (variant?.[key] === "default") return entry.providerID
      }
      for (const entry of recent) {
        if (entry.providerID !== "mimo") return entry.providerID
      }
    }
  }

  // Claude Code settings.json 中的 model 字段
  const claudeSettings = readJSON(join(homedir(), ".claude", "settings.json"))
  if (claudeSettings && typeof claudeSettings.model === "string") {
    const modelStr = claudeSettings.model as string
    if (modelStr.includes("claude") || modelStr.includes("anthropic")) return "anthropic"
    if (modelStr.includes("gpt") || modelStr.includes("openai")) return "openai"
    if (modelStr.includes("gemini")) return "google"
  }

  // Codex config — 检测到 .codex 目录说明用户在 Codex 中
  if (existsSync(join(homedir(), ".codex"))) {
    // Codex 是 OpenAI 产品，模型均为 OpenAI 系列
    for (const name of ["config.yaml", "config.toml", "config.json"]) {
      const cfg = readConfigFile(join(homedir(), ".codex", name))
      if (cfg?.model) {
        const m = cfg.model.toLowerCase()
        if (m.includes("claude") || m.includes("anthropic")) return "anthropic"
        if (m.includes("gemini")) return "google"
        return "openai"
      }
    }
    return "openai"
  }

  // 降级：从环境变量推断
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) return "anthropic"
  if (process.env.OPENAI_API_KEY) return "openai"
  if (process.env.DEEPSEEK_API_KEY) return "deepseek"

  return null
}

/**
 * 自动检测完整配置（API Key + 模型 + 地址）
 *
 * 返回 null 表示无法检测到任何可用配置。
 * 调用方可降级到硬编码默认值。
 */
export function autoDetectConfig(): AutoDetectResult | null {
  // 第一步：收集所有可用的 API Key
  const allKeys: Array<{ provider: string; key: string }> = []

  // 1. 从文件读取
  allKeys.push(...detectKeysFromFiles())

  // 2. 从环境变量读取
  for (const { key: envName, provider } of ENV_KEY_MAP) {
    const val = process.env[envName]
    if (val) {
      if (!allKeys.some((k) => k.provider === provider)) {
        allKeys.push({ provider, key: val })
      }
    }
  }

  if (allKeys.length === 0) return null

  // 第二步：同品牌匹配
  const active = detectActiveProvider()
  if (active) {
    const sameBrand = allKeys.find((k) => k.provider === active)
    if (sameBrand && VISION_REGISTRY[sameBrand.provider]) {
      const vision = VISION_REGISTRY[sameBrand.provider]
      return {
        apiKey: sameBrand.key,
        model: vision.model,
        baseURL: vision.baseURL,
        source: `same-brand (active = ${active})`,
      }
    }
  }

  // 第三步：取第一个有视觉模型的供应商
  for (const k of allKeys) {
    const vision = VISION_REGISTRY[k.provider]
    if (vision) {
      return {
        apiKey: k.key,
        model: vision.model,
        baseURL: vision.baseURL,
        source: `auto (provider = ${k.provider})`,
      }
    }
  }

  return null
}

// ============================================================
// 类型定义
// ============================================================

/** 桥梁配置 */
export interface BridgeConfig {
  /** 视觉模型 ID */
  model: string
  /** API 密钥 */
  apiKey: string
  /** API 基础地址 */
  baseURL: string
  /** 最大输出 token 数 */
  maxTokens: number
  /** 缓存最大条目 */
  cacheSize: number
  /** 是否启用调试日志 */
  debug: boolean
  /** 自定义日志函数（默认输出到 stderr） */
  logger?: (msg: string) => void
}

/** 图片信息 */
export interface ImageInfo {
  /** 图片数据：data: URL 或 base64 字符串 */
  data: string
  /** MIME 类型，例如 "image/png" */
  mimeType: string
}

/** 描述模式 */
export type DescribeMode = "auto" | "ocr" | "markdown"

/** 消息 Part（与具体工具无关的通用格式） */
export interface GenericPart {
  type?: string
  text?: string
  image?: string
  url?: string
  data?: string
  mimeType?: string
  mime?: string
  state?: Record<string, unknown>
  attachments?: Array<Record<string, unknown>>
  output?: unknown
  [key: string]: unknown
}

/** 一条消息 */
export interface GenericMessage {
  role?: string
  info?: { role?: string }
  parts: GenericPart[]
}

/** 处理统计 */
export interface ProcessStats {
  described: number
  skipped: number
  mode: DescribeMode
}

// ============================================================
// 提示词模板
// ============================================================
export const PROMPTS: Record<DescribeMode, string> = {
  auto:
    "Analyze this image and respond based on its actual content type. Do NOT include any preamble or explanation of what you detected — start directly with the output.\n\n" +
    "DETECTION RULES:\n" +
    "- If the image is PRIMARILY text (code, error messages, logs, documents, UI labels, terminal output, forms, receipts): extract ALL text verbatim. Preserve exact wording, line breaks, indentation, and spatial layout.\n" +
    "- If the image contains TABLES, CHARTS, GRAPHS, or FLOW DIAGRAMS as its main content: convert to Markdown. Use pipe-table syntax for tables, structured lists for diagrams. For charts: include key numbers and trends.\n" +
    "- If the image is a PHOTOGRAPH, illustration, screenshot of a GUI without significant text, or scene: provide a concise description.\n" +
    "- If the image mixes significant text with visual elements: prioritize the text content, then briefly note key visual features.\n" +
    "Use the same language as the image content.",

  ocr:
    "Extract ALL visible text from this image VERBATIM. Do not summarize, paraphrase, or translate. Preserve the exact wording, line breaks, and spatial layout (e.g. left/right columns, header/body). If there is code, extract it character-perfect including indentation. Respond with only the extracted text — no preamble, no commentary.",

  markdown:
    "Convert the content of this image into Markdown format. For tables: use pipe-table syntax. For charts/diagrams: describe the structure then list key data points. For code blocks: use fenced code blocks with language tag. For mixed content: reproduce the logical structure. Preserve the original language.",
}

/** 各模式的替换前缀 */
export const PREFIXES: Record<DescribeMode, string> = {
  auto:     "\n[Image content]:\n",
  ocr:      "\n[Extracted text from image]:\n",
  markdown: "\n[Image content (Markdown)]:\n",
}

// ============================================================
// 图片内容检测 — 从消息 Part 中提取图片信息
//
// 支持五种 Part 格式：
//   1. ImagePart     — { type: "image", image: "data:...", mimeType: "image/png" }
//   2. FilePart      — { type: "file",  url/data: "data:image/...", mimeType: "image/..." }
//   3. TextPart 内嵌 — 文本中嵌入了 data:image/...;base64,... URL
//   4. Tool-result   — { type: "tool-result", state: { output: [...] } } 嵌套图片
//   5. Tool附件      — { type: "tool-result", state: { attachments: [...] } }
// ============================================================

/** 从 data: URL 中提取 MIME 类型 */
export function guessMimeFromDataURL(url: string): string | null {
  const m = url.match(/^data:(image\/[^;,]+)/)
  return m ? m[1] : null
}

/** 从单个 Part 中提取图片信息，非图片返回 null */
export function detectImage(part: GenericPart): ImageInfo | null {
  const type = part.type as string | undefined

  // 情况 1：标准的 ImagePart
  if (type === "image") {
    const image = part.image as string | undefined
    if (image) {
      const mimeType = (part.mimeType as string) || guessMimeFromDataURL(image) || "image/png"
      return { data: image, mimeType }
    }
  }

  // 情况 2：FilePart（Read 工具的标准输出）
  if (type === "file") {
    const mime = (part.mimeType || part.mime) as string | undefined
    if (mime && mime.startsWith("image/")) {
      const data = (part.url || part.data || part.image) as string | undefined
      if (data) return { data, mimeType: mime }
    }
    const url = (part.url || part.data) as string | undefined
    if (url) {
      const inferred = guessMimeFromDataURL(url)
      if (inferred) return { data: url, mimeType: inferred }
    }
  }

  // 情况 3：TextPart 中内嵌了 data:image URL
  if (type === "text") {
    const text = part.text as string | undefined
    if (text) {
      const m = text.match(/data:(image\/[^;\s)]+);base64,[A-Za-z0-9+/=]{100,}/)
      if (m) return { data: m[0], mimeType: m[1] }
    }
  }

  // 情况 4 & 5：Tool-result 中的嵌套图片
  if (type === "tool-result" || type === "tool") {
    const state = part.state as Record<string, unknown> | undefined
    if (state) {
      const output = state.output
      if (Array.isArray(output)) {
        for (const item of output) {
          if (typeof item === "object" && item !== null) {
            const nested = detectImage(item as GenericPart)
            if (nested) return nested
          }
        }
      } else if (typeof output === "object" && output !== null) {
        const nested = detectImage(output as GenericPart)
        if (nested) return nested
      }
    }
    const attachments = state?.attachments
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (typeof att === "object" && att !== null) {
          const nested = detectImage(att as GenericPart)
          if (nested) return nested
        }
      }
    }
  }

  return null
}

// ============================================================
// 模式检测 — 从消息中扫描关键词
//
// 默认返回 "auto"，仅当用户消息中出现特定关键词时返回 "ocr" 或 "markdown"。
// 本函数接受两种输入格式以适配不同工具：
//   1. GenericMessage[] — 标准格式（含 role 字段）
//   2. string — 纯文本（简化场景）
// ============================================================

export function detectMode(messages: GenericMessage[] | string): DescribeMode {
  let text: string

  if (typeof messages === "string") {
    text = messages
  } else {
    // 从消息数组中提取用户消息的文本
    const parts: string[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      // 不同的工具有不同的 role 字段位置：msg.info.role 或 msg.role
      const role = msg.info?.role || msg.role
      if (role !== "user") continue

      for (const p of msg.parts) {
        if (p.type === "text" && p.text) parts.push(p.text)
      }
    }
    text = parts.join(" ")
  }

  const lower = text.toLowerCase()

  // OCR 触发词
  if (/ocr|提取文字|文字识别|识别文字|copy.?text|复制.?文字|提取.?文本/.test(lower)) return "ocr"

  // Markdown 触发词
  if (/markdown|转.*(表格|markdown|md)|(table|chart|图表|流程图|表格).*(转化|转|格式化|转成)/.test(lower)) return "markdown"
  if (/(?:这个|这张|这个|the|this)\s*(?:表|图|chart|table|图表|流程图|示意图)/.test(lower)) return "markdown"

  return "auto"
}

// ============================================================
// Bridge 实例 — 封装缓存、日志、API 调用
// ============================================================

export interface Bridge {
  /** 处理消息数组，将图片替换为文字描述 */
  processMessages(messages: GenericMessage[]): Promise<ProcessStats>
  /** 处理单张图片（直接给 data URL） */
  describeImage(data: string, mimeType?: string, mode?: DescribeMode): Promise<string | null>
  /** 清空缓存 */
  clearCache(): void
}

export function createBridge(config: BridgeConfig): Bridge {
  // ---- 缓存 ----
  const imageCache = new Map<string, string>()

  function fingerprint(data: string): string {
    return createHash("sha256").update(data).digest("hex").slice(0, 16)
  }

  function cachePut(key: string, value: string) {
    if (imageCache.size >= config.cacheSize) {
      const first = imageCache.keys().next()
      if (!first.done) imageCache.delete(first.value)
    }
    imageCache.set(key, value)
  }

  // ---- 日志 ----
  const log = config.logger || ((msg: string) => {
    if (config.debug) {
      const ts = new Date().toISOString()
      process.stderr.write(`[vision-core ${ts}] ${msg}\n`)
    }
  })

  // ---- API 调用 ----
  async function callVisionAPI(imgInfo: ImageInfo, mode: DescribeMode): Promise<string | null> {
    if (!config.apiKey) {
      log("No API key set, skipping image description")
      return null
    }

    const cacheKey = fingerprint(imgInfo.data + "|" + mode)
    const cached = imageCache.get(cacheKey)
    if (cached) {
      log(`Cache hit: mode=${mode}`)
      return cached
    }

    try {
      const url = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`
      log(`Calling vision API: model=${config.model} mode=${mode}`)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30_000)

      const maxTokens = mode === "ocr" ? Math.max(config.maxTokens, 1024) : config.maxTokens

      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: PROMPTS[mode] },
              { type: "image_url", image_url: { url: imgInfo.data, detail: "auto" } },
            ],
          }],
        }),
      })

      clearTimeout(timeout)

      if (!response.ok) {
        const body = await response.text().catch(() => "")
        log(`Vision API error: HTTP ${response.status} ${body.slice(0, 200)}`)
        return null
      }

      const json = (await response.json()) as Record<string, unknown>
      const choices = json.choices as Array<Record<string, unknown>> | undefined
      const content = choices?.[0]?.message as Record<string, unknown> | undefined
      const description = (content?.content as string)?.trim()

      if (description) {
        cachePut(cacheKey, description)
        log(`Image described: ${description.slice(0, 80)}...`)
        return description
      }

      log("Vision API returned no description")
      return null
    } catch (err) {
      log(`Vision API fetch error: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  return {
    // ---- 批量处理消息 ----
    async processMessages(messages: GenericMessage[]): Promise<ProcessStats> {
      let described = 0
      let skipped = 0

      // 检测模式（从用户消息中）
      const mode = detectMode(messages)

      for (const msg of messages) {
        for (let i = 0; i < msg.parts.length; i++) {
          const part = msg.parts[i]
          const imgInfo = detectImage(part)
          if (!imgInfo) continue

          log(`Detected image: mime=${imgInfo.mimeType}, size=${imgInfo.data.length}`)
          const description = await callVisionAPI(imgInfo, mode)

          if (description) {
            msg.parts[i] = {
              type: "text",
              text: `${PREFIXES[mode]}${description}\n`,
            }
            described++
          } else {
            skipped++
          }
        }
      }

      if (described > 0 || skipped > 0) {
        log(`Summary: mode=${mode}, described=${described}, skipped=${skipped}`)
      }

      return { described, skipped, mode }
    },

    // ---- 单张图片描述 ----
    async describeImage(data: string, mimeType = "image/png", mode: DescribeMode = "auto"): Promise<string | null> {
      return callVisionAPI({ data, mimeType }, mode)
    },

    clearCache() {
      imageCache.clear()
    },
  }
}
