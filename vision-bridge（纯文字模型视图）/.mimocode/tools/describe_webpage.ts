/**
 * describe_webpage — 网页截图转视觉识别
 *
 * 用法：describe_webpage("https://example.com")
 *       describe_webpage("https://example.com", { mode: "ocr" })
 *
 * 依赖：npm install puppeteer
 */

import { tool } from "@mimo-ai/plugin"
import { CONFIG, callVisionAPI } from "./_vision-utils"

export default tool({
  description:
    "Take a full-page screenshot of a URL and describe its content with a vision model. " +
    "Solves SPA/JS-rendered pages that webfetch cannot read. Auto-compresses large screenshots. " +
    "Requires puppeteer installed (npm install puppeteer in .mimocode).",
  args: {
    url: tool.schema.string().describe("The webpage URL to capture"),
    mode: tool.schema.enum(["auto", "ocr", "markdown"]).optional().describe("Mode (default: auto)"),
  },
  async execute(args, ctx) {
    if (!CONFIG.apiKey) return "Error: MIMOCODE_VISION_API_KEY not set."

    let puppeteer
    try { puppeteer = await import("puppeteer") } catch {
      return "Error: puppeteer not installed. Run: cd .mimocode && npm install puppeteer"
    }

    const mode = args.mode || "auto"
    let url = args.url
    if (!url.startsWith("http")) url = "https://" + url

    let browser
    try {
      browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--headless=new", "--hide-scrollbars", "--mute-audio"] })
      const page = await browser.newPage()
      await page.setViewport({ width: 1280, height: 800 })

      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 })

        // 检测页面高度：超过 5000px 用 JPEG 压缩 + 可视区域截图
        const bodyHeight = await page.evaluate(() => document.body.scrollHeight) as number
        const useFullPage = bodyHeight < 5000
        const screenshotOpts: Record<string, unknown> = {
          fullPage: useFullPage,
          encoding: "base64",
        }

        // 长页面用 JPEG 压缩
        if (!useFullPage || bodyHeight > 2000) {
          screenshotOpts.type = "jpeg"
          screenshotOpts.quality = 60
        }

        const screenshot = await page.screenshot(screenshotOpts) as unknown as string
        await browser.close()

        const mime = screenshotOpts.type === "jpeg" ? "image/jpeg" : "image/png"
        const dataURL = `data:${mime};base64,${screenshot}`
        const sizeKB = (screenshot.length / 1024).toFixed(0)

        const desc = await callVisionAPI(dataURL, mode)
        if (!desc) return `Error: Vision API failed (${sizeKB} KB screenshot). The page may be too complex.`

        return `[${url}]\n\n${desc}`
      } catch (err) {
        await browser.close().catch(() => {})
        return `Error: Page load failed: ${err instanceof Error ? err.message : String(err)}`
      }
    } catch (err) {
      return `Error: Browser launch failed: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})
