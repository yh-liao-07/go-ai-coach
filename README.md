# 围棋 AI 启蒙教练（网页版）

面向围棋初学者的网页应用，主打边下边学：和 AI 真实对弈，下完一步可以问教练为什么；再配合死活题库、单点分析、整盘讲解和棋谱管理，把"为什么这么下"讲明白。装了 Node.js 就能跑，不用装别的。

---

## 快速开始

### 1. 启动

```bash
node server.cjs
```

然后浏览器打开 <http://127.0.0.1:8787/>。

> 也可以用 `npm start`（效果一样）。

### 2. 配置 API（可选）

- 不配 API 也能玩：对手是内置 AI（离线可用），有入门/进阶/挑战三档。
- 想用大模型当对手、或者用 AI 教练讲解，到「设置」页填 API：

| 用途 | 说明 |
|------|------|
| 教练 AI | 局面分析、推荐点讲解、自由提问 |
| 对手 AI | 对弈对手 |
| 保存 | 配置存在浏览器 localStorage，只需填一次 |

- Base URL 示例：`https://api.llm.ustc.edu.cn`（以 `/v1` 结尾会自动补全）
- 模型示例：`deepseek-v4-pro`（教练，质量好）、`deepseek-v4-flash`（对手，响应快）

### 3. 停止

在启动的终端按 `Ctrl+C`。

---

## 功能一览

- **标准围棋棋盘** 9 / 13 / 19 路可选，可执黑或执白（执白时 AI 执黑先走）。
- **基础规则** 落子、提子、点气、自杀与禁着判定、劫。
- **胜率条** KataGo 精确计算，KataGo 不可用时退回本地估算；另有目数估算、提子数、手数。
- **推荐点** 引擎认为最好的三个点显示为蓝点，点击即下；也可开启"自动按蓝点下棋"，引擎替你走，随时可停。
- **AI 教练**（分析页内，流式输出）：
  - 快捷按钮：推荐一手 / 复盘上一手 / 形势判断
  - 自由提问，也可以直接问"这里怎么样"、"讲解当前局面"
  - 右键（或 Shift+左键）点棋盘任意空位，直接问那个点
  - 喂给模型的引擎数据量可选：简略 / 标准 / 详细
- **分析模式** 独立棋盘：手动摆子、问单个点的优劣，或者把在主局面之上新增的几步发给教练做整盘讲解。
- **死活题库** 内置 16 题（做活/杀棋/叫吃/征子/扑/连接/手筋/官子等），点击落子作答，带提示和判定。
- **棋谱** SGF 导入/导出，逐手回放复习。
- **对手和教练分开配置**，互不干扰。

---

## 项目结构

```
server.cjs             # Node 后端：托管静态页 + 转发 LLM 请求（SSE 流式）
lib/server-helpers.cjs # 后端纯函数（chatUrl / resolveStaticPath / 参数校验）
package.json
public/
  index.html
  css/style.css
  js/
    go_core.js       # 围棋规则引擎（棋盘/提子/气/劫）
    go_ai.js         # 内置 AI 对手（三档）
    problems.js      # 16 道死活题（摆子/答案/提示/讲解）
    sgf.js           # SGF 棋谱读写
    katago_client.js # KataGo 分析的前端调用
    ai_api.js        # 大模型对手 + 讲解 + 流式
    app_logic.js     # 前端交互纯逻辑（回合/像素到格子/终局/死活题判定）
    app.js           # 主逻辑（绘制/交互/教练/题库/棋谱/设置）
katago/              # KataGo 引擎、模型与配置文件
katago_engine.cjs    # 后端 KataGo 子进程封装
test_core.mjs        # 核心逻辑测试（node test_core.mjs）
test_app_logic.mjs   # 前端交互纯逻辑测试（node test_app_logic.mjs）
test_dom.mjs         # DOM 冒烟测试：stub 掉浏览器环境跑通 app.js 的 init
test_server.cjs      # 后端纯函数 + HTTP 集成测试（node test_server.cjs）
make_problems.cjs    # 把题目定义文本转成 problems.js 的一次性脚本
```

## 验证测试

四套测试，全部零依赖，直接 `node` 跑：

```bash
node test_core.mjs        # 37 项：规则引擎 / 内置AI / 死活题 / SGF / AI 工具 / 流式
node test_app_logic.mjs   # 30 项：前端交互纯逻辑（回合判定 / 像素到格子 / 死活题判定 / 终局判定 / KataGo moves）
node test_dom.mjs         # DOM 冒烟：stub 浏览器环境后执行 app.js 顶层与 init()
node test_server.cjs      # 45 项：后端（chatUrl 边界 / 路径穿越防护 / 参数校验 + 真实 HTTP 集成测试）
```

> `test_server.cjs` 会短暂启动一个随机端口的服务器做集成测试，测完自动关闭，无需手动起服务。

---

## 为什么用后端（而不是纯静态页）

浏览器直接调 OpenAI 兼容接口有两个问题：大部分平台不允许网页跨域调用（CORS），而且 Key 写进前端谁都能看到。所以有个约 200 行、零 npm 依赖的小后端 `server.cjs`，负责把前端请求转发给大模型，再用 SSE 把回答流式传回。

## 已知限制

- KataGo 不可用时，胜率、目数、推荐点都是本地估算，比较粗，不追求精确。
- 终局判断是"连续两次停手"触发，没有做完整的收官结算。
- 后端没有鉴权，只适合本机使用，不要暴露到公网；多用户部署需要自己加鉴权。
