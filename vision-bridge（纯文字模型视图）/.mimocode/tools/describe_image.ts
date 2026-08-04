/**
 * describe_image — 描述本地图片
 *
 * 用法：describe_image("screenshot.png")
 *       describe_image("screenshot.png", { mode: "ocr" })
 */

import { tool } from "@mimo-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join, extname } from "node:path"
import { CONFIG, callVisionAPI } from "./_vision-utils"

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
}

export default tool({
  description:
    "Describe an image file using a vision model. Use this instead of Read for images. " +
    "Automatically compresses large images and supports auto/ocr/markdown modes.",
  args: {
    path: tool.schema.string().describe("Path to the image file"),
    mode: tool.schema.enum(["auto", "ocr", "markdown"]).optional().describe("Mode: auto=AI decides format, ocr=verbatim text, markdown=structured"),
  },
  async execute(args, ctx) {
    if (!CONFIG.apiKey) return "Error: MIMOCODE_VISION_API_KEY not set."

    const filePath = args.path.includes(":") ? args.path : join(ctx.directory, args.path)
    if (!existsSync(filePath)) return `Error: File not found: ${filePath}`

    const ext = extname(filePath).toLowerCase()
    const mime = MIME_MAP[ext]
    if (!mime) return `Error: Unsupported type "${ext}". Supported: png, jpg, jpeg, gif, webp, bmp`

    let buf: Buffer
    try { buf = readFileSync(filePath) } catch { return `Error: Cannot read file: ${filePath}` }

    if (buf.length > 20 * 1024 * 1024) return `Error: Image too large (${(buf.length / 1048576).toFixed(1)} MB). Max 20MB.`

    const b64 = buf.toString("base64")
    const dataURL = `data:${mime};base64,${b64}`
    const mode = args.mode || "auto"
    const sizeInfo = b64.length > CONFIG.compressThreshold ? ` (${(b64.length / 1024).toFixed(0)} KB → auto-compressed)` : ""

    const desc = await callVisionAPI(dataURL, mode)
    if (!desc) return `Error: Vision API failed (${(buf.length / 1024).toFixed(0)} KB image). Try a smaller file or check API key.`

    return desc
  },
})
