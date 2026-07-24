#!/usr/bin/env node
/**
 * describe-file.mjs — 描述本地图片文件
 *
 * 读取本地图片文件，编码为 base64 data URL，调用视觉模型描述。
 *
 * 用法：
 *   node describe-file.mjs screenshot.png
 *   node describe-file.mjs /path/to/image.jpg
 *
 * 需要同级目录下有 vision-bridge.mjs
 */

import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

const imagePath = process.argv[2]
if (!imagePath) {
  process.stderr.write("Usage: node describe-file.mjs <image-path>\n")
  process.exit(1)
}

let buf: Buffer
try {
  buf = readFileSync(imagePath)
} catch {
  process.stderr.write(`ERROR: Cannot read file: ${imagePath}\n`)
  process.exit(1)
}

const ext = imagePath.split(".").pop()?.toLowerCase() || "png"
const mimeMap: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
}
const mime = mimeMap[ext] || "image/png"
const b64 = buf.toString("base64")
const dataURL = `data:${mime};base64,${b64}`

const bridgePath = join(__dirname, "vision-bridge.mjs")
const result = execSync(
  `node "${bridgePath}" --image "${dataURL}"`,
  { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
)

process.stdout.write(result)
