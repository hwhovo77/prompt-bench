# PromptBench · 提示词调试台

纯静态单页应用，用于调试 LLM 提示词：配置 API 密钥、附加文件（图片 / PDF / Word / Excel）、流式运行，并实时查看实际发出的请求 JSON。

无构建步骤、无后端 —— 所有数据（密钥、会话）只存在本机浏览器的 localStorage 里。

## 运行

```bash
cd prompt-bench
python3 -m http.server 5199
```

打开 http://localhost:5199 即可（任意静态文件服务器都行，不建议直接双击 index.html —— `file://` 下部分接口的 CORS 会拦截请求）。

## 常驻服务（已配置）

本机已配置 launchd 常驻服务 `com.promptbench.service`：登录自启、崩溃自动重启，包含本地静态服务（端口 8418）+ Cloudflare 免费隧道（无需账号）。

- 公网地址（每次隧道重启后可能变化）：`cat ~/.promptbench-service/url.txt`
- 本机地址：http://localhost:8418
- 日志：`~/.promptbench-service/logs/`
- 重启服务：`launchctl kickstart -k gui/$(id -u)/com.promptbench.service`
- 彻底卸载：
  ```bash
  launchctl bootout gui/$(id -u)/com.promptbench.service
  rm ~/Library/LaunchAgents/com.promptbench.service.plist
  rm -rf ~/.promptbench-service
  ```

注意：Mac 重启后隧道域名会变（免费随机域名），新地址自动写入上述文件并弹系统通知；Mac 需保持开机（休眠唤醒后隧道会自动重连，地址不变）。

## 功能

- **双协议**：Anthropic（Claude）与 OpenAI 兼容接口（OpenAI / DeepSeek / 通义 / Moonshot / 各类中转代理），接口地址、密钥、模型按服务商分别记忆
- **文件上传**：拖拽 / 点击 / 直接粘贴截图
  - 图片（png / jpg / gif / webp）→ 原生多模态内容块
  - PDF → Anthropic 走原生 document 块；OpenAI 兼容模式自动提取全文文本（pdf.js）
  - .docx / .xlsx / .xls / .csv / 纯文本 → 浏览器内解析为文本（mammoth / SheetJS），旧版 .doc 需先另存为 .docx
- **透视面板**（右侧）：实时显示将要发出的完整请求 JSON（base64 摘要显示）、每次运行的用量 / 首 token 延迟 / 总耗时 / 停止原因（流式过程中实时刷新），以及一键复制的 cURL
- **流式输出**：SSE 实时渲染 Markdown，可中途停止；支持多轮对话；每条回复带 ↑输入 / ↓输出 token 徽标
- **思考过程**：默认展开显示 —— Anthropic 开关启用 adaptive thinking 摘要；DeepSeek-R1 等兼容端点自动捕获 reasoning_content 推理流
- 常用参数：max_tokens、temperature（注意 Claude 5 系模型不接受采样参数，默认不发送）

## 目录结构

```
prompt-bench/
├── index.html        # 页面结构
├── style.css         # 样式（马卡龙浅色 · Quicksand 圆体）
├── app.js            # 全部逻辑：文件解析 → 请求构建 → SSE 流式
└── vendor/           # 本地依赖：marked、mammoth、SheetJS (xlsx)、pdf.js、Quicksand 字体
```
