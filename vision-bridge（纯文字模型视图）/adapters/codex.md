# Codex 适配指南

Codex（OpenAI 出品的终端编程助手）目前有两种接入方式。

---

## 方式一：CLI 通用方式（推荐，100% 可用）

Codex 支持执行 shell 命令。通过 `vision-bridge.mjs` CLI 工具桥接。

### 配置

```bash
export VISION_API_KEY="sk-xxx"
export VISION_MODEL="gpt-4o-mini"
```

### 在 Codex 中的使用

**场景 1：图片已经在对话中（data:image/... URL）**

告诉 Codex 在分析图片前先调用桥接：

```
用户: 帮我分析这张截图 data:image/png;base64,iVBOR...

→ Codex 读取消息中的 data URL
→ Codex 执行: node /path/to/vision-bridge.mjs --image "data:image/png;base64,iVBOR..."
→ 得到文字描述
→ 基于描述分析
```

如果不想每次都手动，可以在 Codex 的 system prompt 或配置中加入规则：

```markdown
# Codex 自定义指令 / CODE.md / 系统提示
当收到 data:image/... 格式的图片时，
先执行以下命令获取文字描述再分析：
  node /path/to/vision-bridge.mjs --image "<data-url>"
```

**场景 2：读本地图片文件**

```
用户: 读一下 screenshot.png，告诉我上面有什么

→ Codex 执行: node -e "
  const fs = require('fs');
  const data = fs.readFileSync('screenshot.png').toString('base64');
  const { execSync } = require('child_process');
  const desc = execSync('node /path/to/vision-bridge.mjs --image \"data:image/png;base64,' + data + '\"', { encoding: 'utf-8' });
  console.log(desc);
"
→ 返回文字描述
```

**简化为一行脚本**

创建 `bin/describe-file.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from "fs"
import { execSync } from "child_process"

const path = process.argv[2]
if (!path) { console.error("Usage: describe-file.mjs <image-path>"); process.exit(1) }

const buf = readFileSync(path)
const ext = path.split(".").pop()
const b64 = buf.toString("base64")
const dataURL = `data:image/${ext};base64,${b64}`

const result = execSync(
  `node ${new URL("vision-bridge.mjs", import.meta.url).pathname} --image "${dataURL}"`,
  { encoding: "utf-8" }
)
console.log(result)
```

Usage in Codex: `node describe-file.mjs screenshot.png`

---

## 方式二：Codex Plugin/Extension API（如果支持）

OpenAI Codex 的插件/扩展 API 仍在演进中。如果未来 Codex 支持类似 MiMoCode 的钩子系统，可以直接使用核心模块：

```ts
// 概念示例 — 具体 API 以 Codex 官方文档为准
import { createBridge } from "./vision-core.ts"

const bridge = createBridge({
  model: "gpt-4o-mini",
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: "https://api.openai.com/v1",
  maxTokens: 512,
  cacheSize: 200,
  debug: false,
})

export default {
  // Codex 的消息拦截事件名以实际文档为准
  beforeSendMessage: async (ctx, messages) => {
    await bridge.processMessages(messages)
  },
}
```

---

## 方式三：通过 Codex 的 CODE.md / 项目规则

在项目根目录创建 `CODE.md`，注入自定义行为：

```markdown
# Custom Instructions

## Image Handling

When you encounter an image (data:image/... URL or .png/.jpg file),
ALWAYS pipe it through the vision bridge BEFORE analyzing:

```bash
# For data URLs in text:
node /path/to/vision-bridge.mjs --image "<url>"

# For local image files:
node /path/to/describe-file.mjs "<filepath>"
```

Use the text output as the image's content for your analysis.
```

---

## 总结：Codex 最佳实践

| 场景 | 方案 |
|------|------|
| 对话中已有 data:image/... | CLI: `node vision-bridge.mjs --image "..."` |
| 读本地图片文件 | `describe-file.mjs` 脚本 |
| 想自动化/透明化 | 在 CODE.md 中写入规则 |
| Codex 未来支持插件 | 直接 `import { createBridge }` |

核心原则：**Codex 能执行 shell 命令 → CLI 桥接永远可用**。其余方式等 Codex 扩展 API 稳定后再做原生适配。
