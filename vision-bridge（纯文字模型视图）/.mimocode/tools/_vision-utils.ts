/**
 * _vision-utils.ts — 视觉工具共享模块
 *
 * 图片处理、API 调用、缓存，describe_image 和 describe_webpage 共用。
 */

import { createHash } from "node:crypto"

// ---- 配置（环境变量优先） ----
export const CONFIG = {
  apiKey: process.env.MIMOCODE_VISION_API_KEY || "",
  model: process.env.MIMOCODE_VISION_MODEL || "kimi-k3",
  baseURL: process.env.MIMOCODE_VISION_BASE_URL || "https://api.moonshot.cn/v1",
  maxTokens: 1024,
  /** base64 超过此值(字节)时使用 detail: "low" 压缩 */
  compressThreshold: 500_000,
}

// ---- 提示词 ----
export const PROMPTS: Record<string, string> = {
  auto:
    "Analyze this image and respond based on its actual content type. Do NOT include any preamble.\n" +
    "- If primarily text/code: extract verbatim with layout preserved.\n" +
    "- If tables/charts/diagrams: convert to Markdown.\n" +
    "- If a photo/screenshot/scene: describe concisely.\n" +
    "Use the same language as the image content.",
  ocr:
    "Extract ALL visible text from this image VERBATIM. No summaries or paraphrasing. Preserve layout. No preamble.",
  markdown:
    "Convert this image content into Markdown format. Pipe tables, fenced code blocks, structured lists. No preamble.",
}

// ---- 缓存 ----
const cache = new Map<string, string>()
function fingerprint(data: string) { return createHash("sha256").update(data).digest("hex").slice(0, 16) }

/** 调用视觉 API，自动处理推理模型（src/reasoning_content 回退）、压缩、重试 */
export async function callVisionAPI(dataURL: string, mode: string): Promise<string | null> {
  const fpKey = fingerprint(dataURL + "|" + mode)
  if (cache.has(fpKey)) return cache.get(fpKey)!

  // 自动压缩：大图用 low detail
  const useLowDetail = dataURL.length > CONFIG.compressThreshold
  const detail = useLowDetail ? "low" : "auto"

  const tryCall = async () => {
    const url = `${CONFIG.baseURL.replace(/\/+$/, "")}/chat/completions`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 90_000)
    try {
      const res = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CONFIG.apiKey}` },
        body: JSON.stringify({
          model: CONFIG.model, max_tokens: CONFIG.maxTokens,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: PROMPTS[mode] || PROMPTS.auto },
              { type: "image_url", image_url: { url: dataURL, detail } },
            ],
          }],
        }),
      })
      clearTimeout(t)
      if (!res.ok) return null
      const json = await res.json() as Record<string, unknown>
      const msg = (json.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown> | undefined
      return (msg?.content as string)?.trim() || (msg?.reasoning_content as string)?.trim() || null
    } catch {
      clearTimeout(t)
      return null
    }
  }

  // 第一次尝试（可能用 low detail）
  let text = await tryCall()
  if (!text) {
    // 失败后缓存 null 也存一下，避免重复尝试
    cache.set(fpKey, "")
    return null
  }

  cache.set(fpKey, text)
  if (cache.size > 100) cache.delete(cache.keys().next().value!)
  return text
}
