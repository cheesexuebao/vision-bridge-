# Claude Code 适配指南

Claude Code 的钩子系统与 MiMoCode 非常相似（它是 MiMoCode 的 fork 源）。

## 快速适配

Claude Code 同样支持 `.claude/hooks/*.ts`，事件名不同但结构类似。

**核心修改**：把 MiMoCode 的 `experimental.chat.messages.transform` 映射到 Claude Code 的 `PreToolUse` / `PostToolUse`：

```ts
// .claude/hooks/vision-bridge.ts
import { createBridge, VISION_REGISTRY } from "./vision-core.ts"

const bridge = createBridge({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY || "",
  baseURL: "https://api.openai.com/v1",
  maxTokens: 512,
  cacheSize: 200,
  debug: false,
})

export default {
  // Claude Code: 在消息发送前拦截
  // 注：Claude Code 的具体事件名请查阅其 hook API 文档
  // 以下为概念示例，需根据实际 API 调整
  "beforeMessage": async (input, output) => {
    const messages = output.messages
    await bridge.processMessages(messages)
  },
}
```

## 凭证检测（Claude Code 版）

Claude Code 的配置文件位置不同：

```ts
// Claude Code 的 auth 文件通常在 ~/.claude/ 下
function claudeConfigDir(): string {
  return join(homedir(), ".claude")
}
```

其余逻辑与 MiMoCode 版完全一致。
