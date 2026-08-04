/**
 * ============================================================
 * vision-bridge — MiMoCode 适配器
 * ============================================================
 *
 * 本文件是 MiMoCode 专用的钩子适配层。
 * 核心逻辑在 vision-core.ts 中，可跨工具复用。
 *
 * 如果想适配其他 AI 工具（Claude Code / Codex / Aider 等）：
 *   1. 引入 vision-core.ts 的 createBridge + detectMode + detectImage
 *   2. 在该工具的插件系统中调用 bridge.processMessages()
 *   3. 详见 D:\mimocode-plugins\vision-bridge\adapters\ 下的适配指南
 * ============================================================
 */

import type { Hooks } from "@mimo-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  createBridge,
  VISION_REGISTRY,
  type Bridge,
  type DescribeMode,
} from "./vision-core"

// ============================================================
// MiMoCode 专用：自动检测凭证 + 配置
// ============================================================

/** MiMoCode 数据目录 */
function mimocodeDataDir(): string {
  return process.env.MIMOCODE_HOME || join(homedir(), ".local", "share", "mimocode")
}

function readJSON(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch { return null }
}

/** 检测当前活跃的主模型品牌 */
function detectActiveProvider(): string | null {
  const stateDir = process.env.MIMOCODE_HOME
    ? join(process.env.MIMOCODE_HOME, "state")
    : join(homedir(), ".local", "state", "mimocode")
  const modelState = readJSON(join(stateDir, "model.json"))
  if (!modelState) return null

  const recent = modelState.recent as Array<{ providerID: string; modelID: string }> | undefined
  if (!recent || recent.length === 0) return null

  const variant = modelState.variant as Record<string, string> | undefined
  for (const entry of recent) {
    if (entry.providerID === "mimo") continue // 跳过平台路由器
    const key = `${entry.providerID}/${entry.modelID}`
    if (variant?.[key] === "default") return entry.providerID
  }
  for (const entry of recent) {
    if (entry.providerID !== "mimo") return entry.providerID
  }
  return recent[0]?.providerID || null
}

/** 自动检测视觉模型凭证 */
function detectCredentials(): { apiKey: string; model: string; baseURL: string; source: string } | null {
  const auth = readJSON(join(mimocodeDataDir(), "auth.json")) as
    | Record<string, { type: string; key?: string }>
    | null
  if (!auth) return null

  const active = detectActiveProvider()
  const candidates: Array<{ provider: string; apiKey: string; vision: (typeof VISION_REGISTRY)[string] }> = []

  for (const [provider, entry] of Object.entries(auth)) {
    if (!entry.key) continue
    const vision = VISION_REGISTRY[provider]
    if (!vision) continue
    candidates.push({ provider, apiKey: entry.key, vision })
  }
  if (candidates.length === 0) return null

  // 同品牌匹配
  const sameBrand = candidates.find((c) => c.provider === active)
  if (sameBrand) {
    return {
      apiKey: sameBrand.apiKey,
      model: sameBrand.vision.model,
      baseURL: sameBrand.vision.baseURL,
      source: `same-brand (active model = ${active})`,
    }
  }

  const first = candidates[0]
  return {
    apiKey: first.apiKey,
    model: first.vision.model,
    baseURL: first.vision.baseURL,
    source: `auto (provider = ${first.provider})`,
  }
}

// ---- 创建 Bridge 实例 ----
const autoDetected = detectCredentials()

const bridge: Bridge = createBridge({
  model:     process.env.MIMOCODE_VISION_MODEL      || autoDetected?.model    || "deepseek-vl2",
  apiKey:    process.env.MIMOCODE_VISION_API_KEY    || autoDetected?.apiKey   || "",
  baseURL:   process.env.MIMOCODE_VISION_BASE_URL   || autoDetected?.baseURL  || "https://api.deepseek.com/v1",
  maxTokens: parseInt(process.env.MIMOCODE_VISION_MAX_TOKENS || "512", 10),
  cacheSize: parseInt(process.env.MIMOCODE_VISION_CACHE_SIZE || "200", 10),
  debug:     process.env.MIMOCODE_VISION_DEBUG === "1",
})

// ---- 启动信息 ----
if (!autoDetected?.apiKey && !process.env.MIMOCODE_VISION_API_KEY) {
  process.stderr.write(
    "[vision-bridge] WARNING: No vision API key found.\n" +
    "[vision-bridge] Image descriptions will be skipped.\n" +
    "[vision-bridge] Configure a provider in MiMoCode or set MIMOCODE_VISION_API_KEY.\n"
  )
} else {
  const mask = (autoDetected?.apiKey || process.env.MIMOCODE_VISION_API_KEY || "").slice(0, 7) + "***"
  const envActive = process.env.MIMOCODE_VISION_MODEL || process.env.MIMOCODE_VISION_API_KEY
  const source = envActive ? "env" : autoDetected?.source || "default"
  process.stderr.write(
    `[vision-bridge] Vision model: ${autoDetected?.model || "deepseek-vl2"}\n` +
    `[vision-bridge] Base URL:     ${autoDetected?.baseURL || "https://api.deepseek.com/v1"}\n` +
    `[vision-bridge] API key:      ${mask}\n` +
    `[vision-bridge] Source:       ${source}\n` +
    `[vision-bridge] Modes:        auto (AI-detected) | ocr / markdown (keyword-triggered)\n`
  )
}

// ============================================================
// MiMoCode Hook — 适配层
// ============================================================
const hooks: Hooks = {
  "experimental.chat.messages.transform": async (_input, output) => {
    // 转换 MiMoCode 的消息格式 → 通用格式 → 调核心处理 → 原位写回
    const messages = output.messages as Array<{
      info: Record<string, unknown>
      parts: Record<string, unknown>[]
    }>

    await bridge.processMessages(messages)
  },
}

export default hooks
