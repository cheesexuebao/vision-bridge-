/**
 * Claude Code 视觉桥接插件
 *
 * 使用方法：
 *   1. 把本文件和 vision-core.ts 复制到 .claude/hooks/
 *   2. 无需手动设 API Key — 自动从 Claude Code 配置读取
 *      （也可用 VISION_API_KEY 环境变量覆盖）
 *
 * 自动检测：
 *   - 读取 ~/.claude/settings.json 中的 API Key
 *   - 读取常见环境变量（ANTHROPIC_API_KEY / OPENAI_API_KEY …）
 *   - 同品牌匹配：用 Claude → 自动选 Claude Haiku 作视觉模型
 *
 * Claude Code 的钩子系统与 MiMoCode 同源，事件名可能不同。
 * 请以 Claude Code 最新文档为准调整事件名。
 */

import {
  createBridge,
  autoDetectConfig,
  type Bridge,
} from "./vision-core.ts"

// ---- 自动检测配置 ----
const detected = autoDetectConfig()

const bridge: Bridge = createBridge({
  model:     process.env.VISION_MODEL     || detected?.model    || "claude-3-5-haiku-20241022",
  apiKey:    process.env.VISION_API_KEY   || detected?.apiKey   || "",
  baseURL:   process.env.VISION_BASE_URL  || detected?.baseURL  || "https://api.anthropic.com/v1",
  maxTokens:  parseInt(process.env.VISION_MAX_TOKENS || "512"),
  cacheSize: 200,
  debug:      process.env.VISION_DEBUG === "1",
})

// ---- 启动信息 ----
if (!detected?.apiKey && !process.env.VISION_API_KEY) {
  process.stderr.write("[vision-bridge] WARNING: No API key detected. Set VISION_API_KEY or configure Claude Code.\n")
} else {
  const mask = (detected?.apiKey || process.env.VISION_API_KEY || "").slice(0, 7) + "***"
  process.stderr.write(
    `[vision-bridge] Model: ${detected?.model || "claude-3-5-haiku"}\n` +
    `[vision-bridge] Source: ${detected?.source || "env"}\n`
  )
}

// ---- Claude Code 钩子 ----
// 事件名以 Claude Code 官方文档为准，以下为概念示例
export default {
  // 如果 Claude Code 支持消息级拦截：
  // "beforeSendMessage": async (input: any, output: any) => {
  //   await bridge.processMessages(output.messages)
  // },

  // 或拦截 Read 工具调用：
  "PreToolUse": async (input: any, output: any) => {
    if (input.tool_name !== "Read" && input.tool_name !== "View") return
    // Claude Code 的具体钩子 API 请查阅官方文档
  },
}
