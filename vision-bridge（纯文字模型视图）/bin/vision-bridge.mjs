#!/usr/bin/env node
/**
 * vision-bridge CLI — 通用图片桥接工具
 *
 * 任何 AI 工具都可通过 shell 调用本脚本处理图片。
 * 读取 stdin 文本，找到所有 data:image/... URL，调用视觉模型转文字后输出。
 *
 * 用法：
 *   cat input.txt | node vision-bridge.mjs > output.txt
 *   或直接指定图片：
 *   node vision-bridge.mjs --image data:image/png;base64,...
 *
 * 配置（按优先级）：
 *   ① 自动检测：同品牌匹配 → 从 MiMoCode/Claude Code 配置中读取
 *   ② 环境变量：VISION_API_KEY / VISION_MODEL / VISION_BASE_URL / VISION_DEBUG
 *   ③ 常见 Key：OPENAI_API_KEY / ANTHROPIC_API_KEY / DEEPSEEK_API_KEY ...
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---- 视觉模型注册表 ----
const VISION_REGISTRY = {
  deepseek:  { model: "deepseek-vl",                    baseURL: "https://api.deepseek.com/v1" },
  openai:    { model: "gpt-4o-mini",                   baseURL: "https://api.openai.com/v1" },
  anthropic: { model: "claude-3-5-haiku-20241022",     baseURL: "https://api.anthropic.com/v1" },
  google:    { model: "gemini-2.0-flash",              baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
  mimo:      { model: "mimo-auto",                     baseURL: "https://api.mimo.xiaomi.com/v1" },
  groq:      { model: "llama-3.2-11b-vision-preview",  baseURL: "https://api.groq.com/openai/v1" },
  xai:       { model: "grok-2-vision",                 baseURL: "https://api.x.ai/v1" },
  ollama:    { model: "llava",                         baseURL: "http://localhost:11434/v1" },
}

// ---- 自动检测凭证 ----
function readJSON(path) {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf-8")
    // 尝试 JSON
    try { return JSON.parse(raw) } catch {}
    // 尝试 YAML/TOML 简单解析：提取 key: value 或 key = "value"
    const result = {}
    for (const line of raw.split("\n")) {
      const ym = line.match(/^\s*(\w+)\s*:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/)
      if (ym) { result[ym[1]] = ym[2].trim(); continue }
      const tm = line.match(/^\s*(\w+)\s*=\s*["']([^"'\n]+)["']/)
      if (tm) result[tm[1]] = tm[2]
    }
    return Object.keys(result).length > 0 ? result : null
  } catch { return null }
}

function autoDetect() {
  const allKeys = []

  // 从 MiMoCode auth.json 读取
  const mimoAuth = readJSON(join(homedir(), ".local", "share", "mimocode", "auth.json"))
  if (mimoAuth) {
    for (const [provider, entry] of Object.entries(mimoAuth)) {
      if (entry.key) allKeys.push({ provider, key: entry.key })
    }
  }

  // 从 Claude Code settings.json 读取
  const cs = readJSON(join(homedir(), ".claude", "settings.json"))
  if (cs) {
    if (cs.apiKeyHelper) allKeys.push({ provider: "anthropic", key: cs.apiKeyHelper })
    if (cs.openaiApiKey) allKeys.push({ provider: "openai", key: cs.openaiApiKey })
  }
  const cc = readJSON(join(homedir(), ".claude", "credentials.json"))
  if (cc?.apiKey) allKeys.push({ provider: "anthropic", key: cc.apiKey })

  // 从 Codex config 读取（~/.codex/config.yaml / config.toml）
  for (const name of ["config.yaml", "config.toml", "config.json"]) {
    const codexCfg = readJSON(join(homedir(), ".codex", name))
    if (codexCfg) {
      const key = codexCfg.openai_api_key || codexCfg.api_key || codexCfg.apiKey
      if (key && !allKeys.some(k => k.provider === "openai")) {
        allKeys.push({ provider: "openai", key })
      }
      break
    }
  }

  // 环境变量映射
  const envMap = [
    { key: "DEEPSEEK_API_KEY", provider: "deepseek" },
    { key: "OPENAI_API_KEY", provider: "openai" },
    { key: "ANTHROPIC_API_KEY", provider: "anthropic" },
    { key: "GOOGLE_API_KEY", provider: "google" },
    { key: "GEMINI_API_KEY", provider: "google" },
    { key: "GROQ_API_KEY", provider: "groq" },
    { key: "XAI_API_KEY", provider: "xai" },
  ]
  for (const { key: envName, provider } of envMap) {
    const val = process.env[envName]
    if (val && !allKeys.some(k => k.provider === provider)) {
      allKeys.push({ provider, key: val })
    }
  }

  if (allKeys.length === 0) return null

  // 同品牌匹配：检测活跃模型品牌
  let active = null
  const modelState = readJSON(join(homedir(), ".local", "state", "mimocode", "model.json"))
  if (modelState?.recent) {
    const variant = modelState.variant || {}
    for (const e of modelState.recent) {
      if (e.providerID === "mimo") continue
      if (variant[`${e.providerID}/${e.modelID}`] === "default") { active = e.providerID; break }
    }
    if (!active) {
      const first = modelState.recent.find(e => e.providerID !== "mimo")
      if (first) active = first.providerID
    }
  }
  if (!active && process.env.ANTHROPIC_API_KEY) active = "anthropic"
  if (!active && process.env.OPENAI_API_KEY) active = "openai"
  if (!active && process.env.DEEPSEEK_API_KEY) active = "deepseek"
  // Codex 检测：存在 ~/.codex 目录 → OpenAI 品牌
  if (!active && existsSync(join(homedir(), ".codex"))) active = "openai"

  // 同品牌优先
  if (active) {
    const match = allKeys.find(k => k.provider === active)
    if (match && VISION_REGISTRY[match.provider]) {
      const v = VISION_REGISTRY[match.provider]
      return { apiKey: match.key, model: v.model, baseURL: v.baseURL, source: `same-brand (${active})` }
    }
  }

  // 第一个可用
  for (const k of allKeys) {
    const v = VISION_REGISTRY[k.provider]
    if (v) return { apiKey: k.key, model: v.model, baseURL: v.baseURL, source: `auto (${k.provider})` }
  }

  return null
}

// ---- 配置 ----
const detected = autoDetect()
const CONFIG = {
  apiKey:   process.env.VISION_API_KEY   || detected?.apiKey   || "",
  model:    process.env.VISION_MODEL     || detected?.model    || "gpt-4o-mini",
  baseURL:  process.env.VISION_BASE_URL  || detected?.baseURL  || "https://api.openai.com/v1",
  maxTokens: parseInt(process.env.VISION_MAX_TOKENS || "512"),
  debug:    process.env.VISION_DEBUG === "1",
}

function log(msg: string) {
  if (CONFIG.debug) process.stderr.write(`[vision-bridge] ${msg}\n`)
}

if (!CONFIG.apiKey) {
  process.stderr.write("[vision-bridge] ERROR: No API key detected.\n")
  process.stderr.write("[vision-bridge] Set VISION_API_KEY or any of: OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY\n")
  process.exit(1)
}

if (CONFIG.debug || detected) {
  const mask = CONFIG.apiKey.slice(0, 7) + "***"
  process.stderr.write(
    `[vision-bridge] Model:    ${CONFIG.model}\n` +
    `[vision-bridge] Base URL: ${CONFIG.baseURL}\n` +
    `[vision-bridge] API Key:  ${mask}\n` +
    `[vision-bridge] Source:   ${detected?.source || "env"}\n`
  )
}

// ---- 缓存 ----
const cache = new Map<string, string>()
function fingerprint(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16)
}

// ---- API 调用 ----
async function describeImage(dataURL: string): Promise<string | null> {
  const fp = fingerprint(dataURL)
  if (cache.has(fp)) {
    log(`Cache hit: ${fp}`)
    return cache.get(fp)!
  }

  try {
    const url = `${CONFIG.baseURL.replace(/\/+$/, "")}/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)

    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image concisely in the same language as its content." },
            { type: "image_url", image_url: { url: dataURL, detail: "auto" } },
          ],
        }],
      }),
    })

    clearTimeout(timeout)

    if (!res.ok) {
      log(`API error: HTTP ${res.status}`)
      return null
    }

    const json = await res.json() as Record<string, unknown>
    const choices = json.choices as Array<Record<string, unknown>> | undefined
    const desc = (choices?.[0]?.message as Record<string, unknown> | undefined)?.content as string | undefined

    if (desc) {
      cache.set(fp, desc)
      if (cache.size > 200) cache.delete(cache.keys().next().value!)
      log(`Described: ${desc.slice(0, 60)}...`)
      return desc
    }
    return null
  } catch (err) {
    log(`Fetch error: ${err}`)
    return null
  }
}

// ---- 主流程 ----
async function main() {
  const args = process.argv.slice(2)

  // 直接指定图片
  if (args[0] === "--image" && args[1]) {
    const desc = await describeImage(args[1])
    process.stdout.write(desc || "[Failed to describe image]")
    return
  }

  // 从 stdin 读取，扫描 data:image/... URL
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  let text = Buffer.concat(chunks).toString("utf-8")

  // 匹配所有 data:image/... URL
  const imageRe = /data:image\/[^;\s)]+;base64,[A-Za-z0-9+/=]+/g
  const images = [...text.matchAll(imageRe)]

  if (images.length === 0) {
    process.stdout.write(text)
    return
  }

  log(`Found ${images.length} image(s) in input`)

  for (const match of images) {
    const dataURL = match[0]
    const desc = await describeImage(dataURL)
    if (desc) {
      text = text.replace(dataURL, `[Image: ${desc}]`)
    }
  }

  process.stdout.write(text)
}

main().catch((err) => {
  process.stderr.write(`[vision-bridge] Fatal: ${err.message}\n`)
  process.exit(1)
})
