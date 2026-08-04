/**
 * auto-vision — 自动图片/文档识别 Hook
 *
 * 拦截 Read 工具调用：
 *   - 图片文件 → 自动调用视觉模型描述（绕过无视觉模型的限制）
 *   - Office 文档（PPT/Excel/Word）→ 转成每页 PNG 后逐页视觉描述
 * 支持 OCR 关键词自动切换模式（图片场景）。
 *
 * 用法：无需操作，Read 图片/文档时自动生效。
 */

import type { Hooks } from "@mimo-ai/plugin"
import { createHash } from "node:crypto"
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { extname, join } from "node:path"

// ---- 内联视觉 API（不依赖 tools 目录，独立运行） ----
const API_KEY = process.env.MIMOCODE_VISION_API_KEY || ""
const MODEL = process.env.MIMOCODE_VISION_MODEL || "kimi-k3"
const BASE_URL = process.env.MIMOCODE_VISION_BASE_URL || "https://api.moonshot.cn/v1"
/** Office 文档最多处理的页数（环境变量可调） */
const MAX_OFFICE_PAGES = Number(process.env.MIMOCODE_VISION_MAX_PAGES) || 8

const cache = new Map<string, string>()
function fp(data: string) { return createHash("sha256").update(data).digest("hex").slice(0, 16) }

async function callVision(dataURL: string, mode: "auto" | "ocr" | "markdown", timeoutMs = 60_000): Promise<string | null> {
  const cacheKey = fp(dataURL + "|" + mode)
  if (cache.has(cacheKey)) return cache.get(cacheKey)!

  const prompts: Record<string, string> = {
    auto:
      "Analyze this image and respond based on its content type. No preamble.\n" +
      "- Text/code → extract verbatim.\n- Tables/charts → Markdown.\n- Photo/screenshot → describe concisely.\nUse the same language as the content.",
    ocr:
      "Extract ALL visible text from this image VERBATIM. Preserve layout, indentation, line breaks. No preamble, no summary — only the extracted text.",
    markdown:
      "Convert this image into Markdown format. Pipe tables, fenced code blocks, structured lists. No preamble.",
  }

  const detail = dataURL.length > 500_000 ? "low" : "auto"

  const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL, max_tokens: mode === "ocr" ? 2048 : 1024,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompts[mode] },
            { type: "image_url", image_url: { url: dataURL, detail } },
          ],
        }],
      }),
    })
    clearTimeout(t)
    if (!res.ok) return null
    const json = await res.json() as Record<string, unknown>
    const msg = (json.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown> | undefined
    const text = (msg?.content as string) || (msg?.reasoning_content as string) || null
    if (text) { cache.set(cacheKey, text); if (cache.size > 100) cache.delete(cache.keys().next().value!) }
    return text as string | null
  } catch { clearTimeout(t); return null }
}

// ---- 图片检测 ----
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"])
const OFFICE_EXTS = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"])

function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase())
}

function isOfficePath(path: string): boolean {
  return OFFICE_EXTS.has(extname(path).toLowerCase())
}

function detectMode(messages: string[]): "auto" | "ocr" | "markdown" {
  const text = messages.join(" ").toLowerCase()
  if (/ocr|提取文字|文字识别|识别文字|copy.?text|复制.?文字|提取.?文本/.test(text)) return "ocr"
  if (/markdown|表格|chart|图表|流程图|转.*(表格|md|格式)/.test(text)) return "markdown"
  return "auto"
}

// ---- Office 文档 → 每页 PNG → 逐页视觉描述 ----
const OFFICE_TMP = join(homedir(), ".mimocode", "temp", "vision-office")

function fileHash(path: string): string {
  try {
    const buf = readFileSync(path)
    return createHash("sha256").update(buf).digest("hex").slice(0, 16) + "-" + buf.length
  } catch {
    return "unreadable"
  }
}

/** 把 office 文档转成产物，结果缓存在 ~/.mimocode/temp/vision-office/<hash>/ */
async function officeToImages(filePath: string): Promise<{ kind: "pngs"; pages: string[] } | { kind: "text"; text: string } | null> {
  const dir = join(OFFICE_TMP, fileHash(filePath))
  const textFile = join(dir, "text.txt")
  const listPages = () => readdirSync(dir).filter((f) => /^page_\d{3}\.png$/.test(f)).sort()

  try {
    if (existsSync(textFile)) return { kind: "text", text: readFileSync(textFile, "utf-8") }
    const existing = listPages()
    if (existing.length > 0) return { kind: "pngs", pages: existing.map((f) => join(dir, f)) }
  } catch { /* 目录不存在，继续转换 */ }

  mkdirSync(dir, { recursive: true })
  const script = join(homedir(), ".mimocode", "tools", "office-to-images.ps1")
  const res = Bun.spawnSync(
    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
     "-FilePath", filePath, "-OutDir", dir, "-MaxPages", String(MAX_OFFICE_PAGES)],
    { timeout: 180_000 },
  )
  if (res.exitCode !== 0) {
    const err = res.stderr?.toString().trim() || res.stdout?.toString().trim() || `exit ${res.exitCode}`
    process.stderr.write(`[auto-vision] office convert failed for ${filePath}: ${err}\n`)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略清理失败 */ }
    return null
  }

  try {
    if (existsSync(textFile)) return { kind: "text", text: readFileSync(textFile, "utf-8") }
    const pages = listPages()
    if (pages.length > 0) return { kind: "pngs", pages: pages.map((f) => join(dir, f)) }
  } catch { /* 转换成功但产物异常 */ }
  return null
}

/** 逐页调用视觉模型（并发 3），带文件级结果缓存 */
async function describeOfficePages(pages: string[], kind: string): Promise<string | null> {
  const results: Array<string | null> = new Array(pages.length).fill(null)
  let i = 0
  const workers = Array.from({ length: Math.min(3, pages.length) }, async () => {
    while (i < pages.length) {
      const idx = i++
      try {
        const buf = readFileSync(pages[idx])
        const dataURL = `data:image/png;base64,${buf.toString("base64")}`
        const prompt = `这是${kind}的第 ${idx + 1}/${pages.length} 页。请完整描述或提取本页内容。`
        const desc = await callVision(dataURL, "auto")
        results[idx] = desc ? `${prompt}\n${desc}` : null
      } catch {
        results[idx] = null
      }
    }
  })
  await Promise.all(workers)

  if (!results.some(Boolean)) return null
  const lines = results.map((r, idx) => `--- 第 ${idx + 1} 页 ---\n${r ?? "（本页描述失败）"}`)
  return `[${kind}共 ${pages.length} 页，逐页视觉描述如下]\n\n${lines.join("\n\n")}`
}

async function processOffice(absPath: string, kind: string): Promise<string | null> {
  const dir = join(OFFICE_TMP, fileHash(absPath))
  const resultFile = join(dir, "result.txt")

  try {
    if (existsSync(resultFile)) return readFileSync(resultFile, "utf-8")
  } catch { /* 忽略读取失败 */ }

  const artifact = await officeToImages(absPath)
  if (!artifact) return null

  // Word：直接返回文本（PDF 管线在本机不可靠，文本提取更稳定）
  if (artifact.kind === "text") {
    const text = artifact.text.trim()
    if (!text) return null
    const desc = `[${kind} ${absPath}]\n\n${text}`
    try { writeFileSync(resultFile, desc) } catch { /* 结果缓存失败不阻塞 */ }
    return desc
  }

  // PPT/Excel：逐页视觉描述
  const desc = await describeOfficePages(artifact.pages, kind)
  if (!desc) return null

  try { writeFileSync(resultFile, desc) } catch { /* 结果缓存失败不阻塞 */ }
  return desc
}

function officeKind(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === ".ppt" || ext === ".pptx") return "PPT 演示文稿"
  if (ext === ".xls" || ext === ".xlsx") return "Excel 表格"
  return "Word 文档"
}

// ---- Hook ----
const hooks: Hooks = {
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "read") return

    const path = output.args?.path || output.args?.file_path
    if (typeof path !== "string") return

    const absPath = (path.includes(":") || path.startsWith("/")) ? path : join(process.cwd(), path)
    if (!existsSync(absPath)) return

    // Office 文档：Word 走文本提取（不需要 API key），PPT/Excel 走逐页视觉描述
    if (isOfficePath(absPath)) {
      const kind = officeKind(absPath)
      if (!API_KEY && kind !== "Word 文档") return
      const desc = await processOffice(absPath, kind)
      if (desc) {
        output.cancel = true
        output.cancelReason = `[Office Document: ${absPath}]\n\n${desc}`
      }
      return
    }

    // 图片：走视觉模型
    if (!API_KEY) return
    if (!isImagePath(absPath)) return

    let buf: Buffer
    try { buf = readFileSync(absPath) } catch { return }
    if (buf.length > 20 * 1024 * 1024) return // 超过 20MB 不处理

    const ext = extname(absPath).toLowerCase()
    const mimeMap: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }
    const mime = mimeMap[ext] || "image/png"
    const b64 = buf.toString("base64")
    const dataURL = `data:${mime};base64,${b64}`

    // 检测 OCR 模式（从当前会话上下文中，这里用简化方式）
    // 实际无法从 hook 访问消息上下文，默认 auto，用户可用 describe_image 手动选模式
    const mode: "auto" | "ocr" | "markdown" = "auto"

    const desc = await callVision(dataURL, mode)
    if (desc) {
      // 取消原始 Read，将文字描述作为工具结果返回
      output.cancel = true
      output.cancelReason = `[Image: ${absPath}]\n\n${desc}`
    }
  },
}

export default hooks
