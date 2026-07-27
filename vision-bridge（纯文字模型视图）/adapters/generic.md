# 通用适配指南 — 各工具具体操作

`vision-core.ts` 是纯逻辑层，任何 JS/TS 环境可用。
`bin/vision-bridge.mjs` 是可独立运行的 CLI 工具。

**所有版本均已内置自动检测**：无需手动设置 API Key，插件会自动读取 MiMoCode / Claude Code 的配置，匹配同品牌视觉模型。

## 自动检测机制（所有版本通用）

```
① 环境变量手动指定（VISION_API_KEY / VISION_MODEL / VISION_BASE_URL）
     ↓ 未设
② 读取工具配置文件（MiMoCode auth.json / Claude Code settings.json）
     ↓ 找到 Key
③ 同品牌匹配：当前用 DeepSeek → 自动选 DeepSeek VL2；用 Claude → 自动选 Haiku
     ↓ 无同品牌
④ 取第一个可用供应商的视觉模型
```

也自动识别常见环境变量：`OPENAI_API_KEY` `ANTHROPIC_API_KEY` `DEEPSEEK_API_KEY` `GOOGLE_API_KEY` `GROQ_API_KEY` `XAI_API_KEY`

---

---

## 方式一：CLI 通用方式（所有工具适用）

任何支持执行 shell 命令的 AI 工具都可通过 CLI 桥接。

### 配置

```bash
export VISION_API_KEY="sk-xxx"
export VISION_MODEL="gpt-4o-mini"          # 可选
export VISION_BASE_URL="https://api.openai.com/v1"  # 可选
```

### 作为管道使用

```bash
# 文本中包含 data:image/... URL 时，自动替换为文字描述
echo "请看这张图片: data:image/png;base64,iVBOR..." | node vision-bridge.mjs
```

### 作为单张图片描述工具

```bash
node vision-bridge.mjs --image "data:image/png;base64,iVBOR..."
```

### 在各工具中的集成方式

在工具配置中添加自定义命令/脚本，在发送消息前预处理：

| 工具 | 配置位置 | 示例 |
|------|---------|------|
| **Aider** | `.aider.conf.yml` | 见下方 Aider 示例 |
| **Cursor** | `.cursorrules` 或自定义命令 | 定义 `@vision` 命令调用 CLI |
| **Continue.dev** | `config.json` 或 `config.ts` | 自定义 slash command |
| **Cline** | VS Code 设置 | 自定义 tool |
| **任意工具** | shell 环境 | `export VISION_API_KEY=...` 后管道调用 |

---

## 方式二：Aider 适配（Python 环境）

Aider 是 Python 工具，通过配置文件 + 自定义命令集成。

### .aider.conf.yml

```yaml
# 自定义命令：视觉桥接
vision-command: node /path/to/vision-bridge.mjs

# 在每次工具调用前执行预处理
# Aider 支持自定义预处理脚本
preprocess-command: node /path/to/vision-bridge.mjs
```

### 或作为 Python wrapper

```python
# vision_wrapper.py — 放在 PATH 中
import subprocess, sys, os

def process_for_vision(text: str) -> str:
    proc = subprocess.run(
        ["node", "/path/to/vision-bridge.mjs"],
        input=text, capture_output=True, text=True,
        env={**os.environ, "VISION_API_KEY": os.environ.get("VISION_API_KEY", "")}
    )
    return proc.stdout

if __name__ == "__main__":
    text = sys.stdin.read()
    print(process_for_vision(text))
```

用法：
```bash
export VISION_API_KEY="sk-xxx"
aider --preprocess "python vision_wrapper.py"
```

---

## 方式三：Cursor / VS Code 系列

### .cursorrules 集成

在 `.cursorrules` 中定义一个规则，让 Cursor 在分析图片前先调用 CLI：

```yaml
# .cursorrules
rules:
  - name: vision-bridge
    description: |
      当用户要求查看/分析图片时，如果图片是 data:image/... 格式，
      先执行: node /path/to/vision-bridge.mjs --image "<data-url>"
      然后基于输出回答。
```

### VS Code Task 集成

`.vscode/tasks.json`：
```json
{
  "version": "2.0.0",
  "tasks": [{
    "label": "Describe Image",
    "type": "shell",
    "command": "node",
    "args": ["/path/to/vision-bridge.mjs", "--image", "${input:imageURL}"],
    "problemMatcher": []
  }]
}
```

---

## 方式四：Continue.dev 适配

### config.ts

```ts
// ~/.continue/config.ts
export function modifyConfig(config: any) {
  config.slashCommands?.push({
    name: "vision",
    description: "Describe an image via vision model",
    run: async (input: string) => {
      const { execSync } = require("child_process")
      const result = execSync(
        `node /path/to/vision-bridge.mjs --image "${input}"`,
        { encoding: "utf-8", env: { ...process.env, VISION_API_KEY: "sk-xxx" } }
      )
      return result
    }
  })
  return config
}
```

---

## 方式五：直接使用核心模块（JS/TS 工具）

如果你的工具原生支持 JS/TS 扩展，直接引入 `vision-core.ts`：

```ts
import { createBridge } from "./vision-core.ts"

const bridge = createBridge({
  model:     "gpt-4o-mini",
  apiKey:    process.env.VISION_API_KEY!,
  baseURL:   "https://api.openai.com/v1",
  maxTokens: 512,
  cacheSize: 200,
  debug:     false,
})

// 在工具的钩子/事件/中间件中调用
async function onBeforeSend(messages: any[]) {
  const stats = await bridge.processMessages(messages)
  // messages 中的图片已被替换为文字描述
}
```

核心模块导出的完整 API 见 `vision-core.ts` 源码顶部注释。
