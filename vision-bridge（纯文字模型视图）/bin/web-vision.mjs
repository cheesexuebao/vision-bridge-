#!/usr/bin/env node
/**
 * web-vision.mjs — 网页截图转视觉识别
 *
 * 用 Puppeteer 渲染网页全页截图，通过视觉模型描述页面内容。
 * 解决 webfetch 无法处理 SPA（React/Vue 渲染）的问题。
 *
 * 用法：
 *   node web-vision.mjs "https://example.com"
 *   node web-vision.mjs --mode ocr "https://example.com"
 *   node web-vision.mjs --mode markdown "https://example.com"
 *
 * 依赖：npm install puppeteer
 * 自动复用 vision-bridge 的凭证检测，零额外配置。
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ============================================================
// 视觉模型注册表 + 自动检测（内联，独立运行）
// ============================================================
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

function readJSON(path) {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf-8")
    try { return JSON.parse(raw) } catch {}
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
  const mimoAuth = readJSON(join(homedir(), ".local", "share", "mimocode", "auth.json"))
  if (mimoAuth) for (const [p, e] of Object.entries(mimoAuth)) if (e.key) allKeys.push({ provider: p, key: e.key })
  const cs = readJSON(join(homedir(), ".claude", "settings.json"))
  if (cs) {
    if (cs.apiKeyHelper) allKeys.push({ provider: "anthropic", key: cs.apiKeyHelper })
    if (cs.openaiApiKey) allKeys.push({ provider: "openai", key: cs.openaiApiKey })
  }
  const cc = readJSON(join(homedir(), ".claude", "credentials.json"))
  if (cc?.apiKey) allKeys.push({ provider: "anthropic", key: cc.apiKey })
  for (const name of ["config.yaml", "config.toml", "config.json"]) {
    const cfg = readJSON(join(homedir(), ".codex", name))
    if (cfg) { const k = cfg.openai_api_key || cfg.api_key; if (k && !allKeys.some(x => x.provider === "openai")) allKeys.push({ provider: "openai", key: k }); break }
  }
  const envMap = [
    { key: "DEEPSEEK_API_KEY", provider: "deepseek" }, { key: "OPENAI_API_KEY", provider: "openai" },
    { key: "ANTHROPIC_API_KEY", provider: "anthropic" }, { key: "GOOGLE_API_KEY", provider: "google" },
    { key: "GEMINI_API_KEY", provider: "google" }, { key: "GROQ_API_KEY", provider: "groq" },
    { key: "XAI_API_KEY", provider: "xai" },
  ]
  for (const { key: envName, provider } of envMap) {
    const val = process.env[envName]
    if (val && !allKeys.some(k => k.provider === provider)) allKeys.push({ provider, key: val })
  }
  if (allKeys.length === 0) return null
  let active = null
  const modelState = readJSON(join(homedir(), ".local", "state", "mimocode", "model.json"))
  if (modelState?.recent) {
    const variant = modelState.variant || {}
    for (const e of modelState.recent) { if (e.providerID === "mimo") continue; if (variant[`${e.providerID}/${e.modelID}`] === "default") { active = e.providerID; break } }
    if (!active) { const f = modelState.recent.find(e => e.providerID !== "mimo"); if (f) active = f.providerID }
  }
  if (!active && process.env.ANTHROPIC_API_KEY) active = "anthropic"
  if (!active && process.env.OPENAI_API_KEY) active = "openai"
  if (!active && process.env.DEEPSEEK_API_KEY) active = "deepseek"
  if (!active && existsSync(join(homedir(), ".codex"))) active = "openai"
  if (active) { const m = allKeys.find(k => k.provider === active); if (m && VISION_REGISTRY[m.provider]) { const v = VISION_REGISTRY[m.provider]; return { apiKey: m.key, model: v.model, baseURL: v.baseURL, source: `same-brand (${active})` } } }
  for (const k of allKeys) { const v = VISION_REGISTRY[k.provider]; if (v) return { apiKey: k.key, model: v.model, baseURL: v.baseURL, source: `auto (${k.provider})` } }
  return null
}

// ============================================================
// 配置
// ============================================================
const detected = autoDetect()
const CONFIG = {
  apiKey:   process.env.VISION_API_KEY   || detected?.apiKey   || "",
  model:    process.env.VISION_MODEL     || detected?.model    || "gpt-4o-mini",
  baseURL:  process.env.VISION_BASE_URL  || detected?.baseURL  || "https://api.openai.com/v1",
  maxTokens: parseInt(process.env.VISION_MAX_TOKENS || "1024"),
}

// ============================================================
// 提示词
// ============================================================
const PROMPTS = {
  auto:
    "You are viewing a full-page screenshot of a website. Analyze it and respond based on its content type:\n" +
    "- If it's mostly text (docs, blog, article): summarize the key points and extract important text.\n" +
    "- If it's a web app / dashboard / form: describe the layout, key UI elements, and visible data.\n" +
    "- If it has tables or data: convert to Markdown where useful.\n" +
    "Be concise but thorough. Use the same language as the page content.",
  ocr:
    "Extract ALL visible text from this webpage screenshot VERBATIM. Do not summarize or paraphrase. Preserve headings, paragraphs, and layout. No preamble — only the extracted text.",
  markdown:
    "Convert this webpage screenshot into a clean Markdown document. Use proper headings, lists, code blocks, and pipe tables where applicable. Preserve the original language and structure.",
}
const MODES = ["auto", "ocr", "markdown"]

// ============================================================
// 缓存
// ============================================================
const cache = new Map()
function fp(data) { return createHash("sha256").update(data).digest("hex").slice(0, 16) }

// ============================================================
// 视觉 API 调用
// ============================================================
async function describeImage(dataURL, mode) {
  const key = fp(dataURL + "|" + mode)
  if (cache.has(key)) return cache.get(key)
  try {
    const url = `${CONFIG.baseURL.replace(/\/+$/, "")}/chat/completions`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 60_000)
    const res = await fetch(url, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.apiKey}` },
      body: JSON.stringify({
        model: CONFIG.model, max_tokens: CONFIG.maxTokens,
        messages: [{ role: "user", content: [{ type: "text", text: PROMPTS[mode] }, { type: "image_url", image_url: { url: dataURL, detail: "high" } }] }],
      }),
    })
    clearTimeout(t)
    if (!res.ok) { process.stderr.write(`[web-vision] API error: HTTP ${res.status}\n`); return null }
    const json = await res.json()
    const desc = json.choices?.[0]?.message?.content?.trim()
    if (desc) { cache.set(key, desc); if (cache.size > 100) cache.delete(cache.keys().next().value); return desc }
    return null
  } catch (err) { process.stderr.write(`[web-vision] API error: ${err.message}\n`); return null }
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const args = process.argv.slice(2)
  let url = ""
  let mode = "auto"

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) { mode = args[i + 1]; i++ }
    else if (!url) url = args[i]
  }
  if (!MODES.includes(mode)) { process.stderr.write(`[web-vision] Invalid mode: ${mode}. Use: auto | ocr | markdown\n`); process.exit(1) }
  if (!url) { process.stderr.write("Usage: node web-vision.mjs [--mode auto|ocr|markdown] <url>\n"); process.exit(1) }

  if (!CONFIG.apiKey) {
    process.stderr.write("[web-vision] ERROR: No API key detected. Set VISION_API_KEY or configure a provider.\n")
    process.exit(1)
  }

  // 检查 puppeteer
  let puppeteer
  try { puppeteer = await import("puppeteer") } catch {
    process.stderr.write("[web-vision] ERROR: puppeteer not installed. Run: npm install puppeteer\n")
    process.exit(1)
  }

  process.stderr.write(`[web-vision] Loading: ${url}\n[web-vision] Model: ${CONFIG.model} (${detected?.source || "env"})\n[web-vision] Mode: ${mode}\n`)

  // 启动浏览器，渲染全页截图（仅在内存中，不写磁盘）
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] })
  let page
  try {
    page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 })

    // 全页截图 → base64 buffer（不落盘，用完即自动释放）
    const screenshot = await page.screenshot({ fullPage: true, encoding: "base64" })
    await browser.close()

    const dataURL = `data:image/png;base64,${screenshot}`
    process.stderr.write(`[web-vision] Screenshot captured (${(screenshot.length / 1024).toFixed(0)} KB), describing...\n`)

    const desc = await describeImage(dataURL, mode)
    if (desc) {
      process.stdout.write(desc + "\n")
    } else {
      process.stderr.write("[web-vision] Failed to describe the webpage.\n")
      process.exit(1)
    }
  } catch (err) {
    await browser.close().catch(() => {})
    process.stderr.write(`[web-vision] Error: ${err.message}\n`)
    process.exit(1)
  }
}

main()
