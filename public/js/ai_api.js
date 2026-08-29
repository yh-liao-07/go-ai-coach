// 外部 AI 接口（前端侧）
// 所有真正的大模型调用都走后端 /api/chat（Node 里转发），前端只负责拼 payload 和收流。
// 这样浏览器不用直接碰 OpenAI 兼容接口，绕开 CORS，Key 也不会暴露在前端。
//
// 两块用途：
//   1) 对手 AI：接大模型下棋
//   2) 讲解 AI：给新手讲局面，给胜率和推荐点

import { coordToText, textToCoord, BLACK, WHITE } from "./go_core.js";

// 把棋盘画成字符，给模型看。黑=● 白=○ 空=.
// 顶部 = 第 size 行，底部 = 第 1 行（围棋惯例，A1 在左下角）。
export function boardText(board) {
  const size = board.size;
  const letters = "ABCDEFGHJKLMNOPQRST".slice(0, size);
  const lines = ["    " + letters.split("").join("  ")];
  for (let r = 0; r < size; r++) {
    const rowNo = size - r;
    const chars = [];
    for (let c = 0; c < size; c++) {
      const v = board.get(r, c);
      chars.push(v === 1 ? "●" : v === 2 ? "○" : ".");
    }
    // 行号右对齐 + 标注方向：顶部第一行标"上"，底部最后一行标"下"
    const tag = r === 0 ? "上" : (r === size - 1 ? "下" : "");
    lines.push(String(rowNo).padStart(2, " ") + (tag ? "(" + tag + ")" : "  ") + " " + chars.join("  "));
  }
  lines.push("   [列: " + letters.split("").join(" ") + "，底部为第1行，顶部为第" + size + "行]");
  return lines.join("\n");
}

// 把黑白双方的棋子坐标列成清单，避免模型被字符画行号方向误导。
export function boardCoordList(board) {
  const size = board.size;
  const blacks = [], whites = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = board.get(r, c);
      if (v === BLACK) blacks.push(coordToText(r, c, size));
      else if (v === WHITE) whites.push(coordToText(r, c, size));
    }
  }
  return "黑棋位置: " + (blacks.join(" ") || "无") + "\n白棋位置: " + (whites.join(" ") || "无");
}

// 统一调用后端聊天接口。stream=false 时返回完整文本；true 时返回一个可读流。
async function chat({ baseUrl, apiKey, model, messages, temperature, stream }) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, apiKey, model, messages, temperature, stream }),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = JSON.stringify(await resp.json()); } catch (e) { detail = await resp.text(); }
    throw new Error("上游请求失败(" + resp.status + ") " + detail);
  }
  return resp;
}

// 把一个 SSE 响应转成"逐段回调"的消费器。每收到一段纯文本就调 onToken。
export async function consumeStream(resp, onToken) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let token = "";
      try {
        const obj = JSON.parse(payload);
        // 优先透传后端错误信息；否则取增量文本
        if (obj && obj.error) {
          token = "\n[错误] " + String(obj.error.message ?? obj.error);
        } else {
          token = obj.choices?.[0]?.delta?.content || "";
        }
      } catch (e) {
        // 非 JSON payload，忽略
      }
      if (token) {
        const cleaned = cleanMarkdown(token);
        full += cleaned;
        if (onToken) onToken(cleaned);
      }
    }
  }
  if (buf.trim()) {
    // 尾巴
    let line = buf.trim();
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload !== "[DONE]") {
        try {
          const obj = JSON.parse(payload);
          const t = obj && obj.error ? "\n[错误] " + String(obj.error.message ?? obj.error) : (obj.choices?.[0]?.delta?.content || "");
          if (t) { const c = cleanMarkdown(t); full += c; onToken && onToken(c); }
        } catch (_) {}
      }
    }
  }
  return full;
}

// 去掉常见 Markdown 标记，保留纯文本+换行。
export function cleanMarkdown(text) {
  let t = text;
  t = t.replace(/^#{1,6}\s*/gm, "");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1");
  t = t.replace(/\*(.+?)\*/g, "$1");
  t = t.replace(/`(.+?)`/g, "$1");
  t = t.replace(/^\s*[-*]\s+/gm, "");
  t = t.replace(/^\s*\d+\.\s+/gm, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t;
}

// 一条通用的"问教练"方法：直接给 prompt，流式回传。
export async function askCoachStream({ baseUrl, apiKey, model, system, user, temperature, onToken }) {
  const resp = await chat({
    baseUrl, apiKey, model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature, stream: true,
  });
  return await consumeStream(resp, onToken);
}

// ---------------- 大模型当对手 ----------------
export class LLMOpponent {
  constructor(baseUrl, apiKey, model) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model || "deepseek-v4-flash";
  }

  async chooseMove(board, color, level) {
    const size = board.size;
    const turn = color === 1 ? "黑" : "白";
    const legal = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (board.isLegal(r, c, color)) legal.push(coordToText(r, c, size));
      }
    }
    const legalStr = legal.slice(0, 60).join("、") + (legal.length > 60 ? "……" : "");
    const historyStr = board.history.map(h => h.r >= 0 ? coordToText(h.r, h.c, size) : "pass").join(" ") || "无";

    const user = [
      `你在下围棋，执${turn}，棋盘 ${size}x${size}。`,
      `坐标约定：左下角 A1，右上角 ${coordToText(0, size-1, size)}；列标 A~${"ABCDEFGHJKLMNOPQRST".slice(size-1,size)} 跳过 I。`,
      `当前局面棋子位置：`,
      boardCoordList(board),
      ``,
      `棋谱(顺序): ${historyStr}`,
      ``,
      `字符画（黑=● 白=○ 空=.，顶部第${size}行，底部第1行）：`,
      boardText(board),
      ``,
      `合法落点（只能从这里选一个，不要选已占位置）: ${legalStr}`,
      `请只回复一个合法落点坐标(如 D4)，不要解释；若想停手就回复 PASS。`,
    ].join("\n");

    const system = [
      "你是一位有经验的围棋棋手。分析局面后选择最优落子。",
      "思考原则：优先占角、星位和三四线；注意护住自己的断点和气；",
      "对没气的棋子要及时提走；不要往对方厚势里送子；开局布局宜开阔。",
      "最重要的是：只能从合法落点列表中选一个，已经落了子的位置绝对不能选。",
      (level === "挑战" ? "这是高水平对局，请尽量下出最强手。" : level === "进阶" ? "按中等水平下出合理招法。" : "这是教学对局，下出简单稳健、容易理解的招法即可。"),
      "只输出一个合法落点坐标(如 D4)或 PASS，不要其他内容。",
    ].join("");

    try {
      const resp = await chat({
        baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.3, stream: false,
      });
      const data = await resp.json();
      const text = data.text || "";
      return this._parseMove(text, board);
    } catch (e) {
      return "ERROR";
    }
  }

  _parseMove(text, board) {
    text = String(text).trim().toUpperCase();
    if (text.includes("PASS") || text.includes("停")) return null;
    const m = text.match(/[A-HJ-T]+\d{1,2}/);
    if (!m) return "ERROR";
    const coord = textToCoord(m[0], board.size);
    if (!coord) return "ERROR";
    return coord;
  }
}

// ---------------- 讲解 AI ----------------
const DEFAULT_SYSTEM = [
  "你是一位围棋启蒙教练，学生是刚入门的成年人，只懂基本规则和少量术语。",
  "说话像陪在身边看棋的老朋友：口语化、简短，多用生活比喻；用到术语时顺手用一句话点明意思。",
  "每次只讲清一件事，三句话：1) 上一手想干什么、有没有明显问题；2) 最值得下的下一步（只给一个坐标）和原因；3) 一句可执行的提醒。",
  "只给最有把握的一个点，不罗列多个候选；学生没问就别展开备选点对比。",
  "总字数 150 字以内，句与句之间用换行分隔，不用列表符号。",
  "胜率、目差等数据题干里给了就照实说，没给不要编。",
  "坐标约定：左下角是 A1，列标从左到右 A 到 T，跳过字母 I。",
].join("");

// 分析模式的教练提示词：基于 KataGo 数据讲解，不自己判断。
export const ANALYSIS_SYSTEM = [
  "你是一位围棋复盘教练，在分析模式下陪学生研究一个局面。",
  "不要凭自己的棋力判断一步棋的优劣，好坏的唯一依据是题干里的 KataGo 数据（胜率、目差、推荐序位、胜率变化）。",
  "某个点没有数据时，就说「这一点引擎还没算，我可以帮你算」，不要自己猜。",
  "讲解要具体：先讲这步棋的意图和可能的后果，再用数据佐证（例如「这手之后黑胜率掉了 6 个百分点，方向不对」），最后给建议或追问。",
  "学生提出自己的想法（比如「我想下 D4 行不行」）时，基于数据回答：行不行、为什么、代价多大、有没有更好的选择。",
  "总字数 200 字以内，短句换行，不用列表符号。",
  "坐标：左下角是 A1，列标从左到右 A 到 T，跳过字母 I。",
].join("");

export class ExplainAI {
  constructor(baseUrl, apiKey, model) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.model = model || "deepseek-v4-pro";
  }

  buildPrompt(board, color, lastMove, kind, extraMoves) {
    const size = board.size;
    const turn = color === 1 ? "黑" : "白";
    const last = !lastMove ? "无" : coordToText(lastMove[0], lastMove[1], size);
    let instruction = "";
    if (kind === "recommend") {
      instruction = "请重点给出当前轮到你（" + turn + "方）最推荐的 1 步，并解释为什么推荐它、它相比其他常见选点好在哪里。";
    } else if (kind === "review_last") {
      instruction = "请重点分析上一手(" + last + ")下得好不好：它有什么问题或误区？如果不好，更好的下法是什么？";
    } else if (kind === "position") {
      instruction = "请做一次局面形势判断：黑白双方谁的形势更好？各自的关键弱点和机会在哪？";
    } else if (kind === "point_query") {
      instruction = "用户想了解某个点（见最后一行）的优劣，讲清楚好不好、为什么、数据上差多少。";
    } else if (kind === "analyze_all") {
      instruction = "下面是玩家在分析盘上主局面之上新增的几步（按落子顺序）。像复盘教练一样整体讲解：每步想干什么、整体方向对不对，指出最值得商榷的一步，给出更好的下法。";
    } else {
      instruction = "请面向刚入门的学生分析局面，并给出推荐下一步。";
    }

    let extra = "";
    if (kind === "point_query" && lastMove) {
      extra = "\n用户询问的选点: " + last + "\n";
    }
    if (kind === "analyze_all" && Array.isArray(extraMoves) && extraMoves.length) {
      const seq = extraMoves.map((m, i) => {
        const coord = coordToText(m.r, m.c, size);
        if (m.op === "erase") return `第${i+1}步 删子 ${coord}`;
        const colorName = m.color === 1 ? "黑" : "白";
        return `第${i+1}步 落子 ${colorName} ${coord}`;
      }).join("；");
      extra += "\n玩家在分析盘上新增的步骤（相对主局面，按操作顺序）：\n" + seq + "\n";
    }

    const user = [
      `当前棋盘。坐标约定：左下角是 A1，右上角是 ${coordToText(0, size-1, size)}；列从左到右 ${"ABCDEFGHJKLMNOPQRST".slice(0,size).split("").join("")}（跳过 I）。`,
      boardCoordList(board),
      ``,
      `字符画（黑=● 白=○ 空=.，顶部为第${size}行，底部为第1行）：`,
      boardText(board),
      ``,
      `轮到: ${turn}方（该${turn}方落子）  上一手: ${last}  黑提${board.captures[1]} 白提${board.captures[2]}  棋盘${size}x${size}`,
      extra,
      instruction,
      ``,
      `请用口语化中文回答，300 字以内，不用列表符号，换行清晰即可。`,
    ].join("\n");

    return { system: DEFAULT_SYSTEM, user };
  }
}

// ---------------- 分析模式：点格分析的数据 ----------------

// 把点格分析结果整理成供模型讲解的文本。
// result 是 katago_client.js 的 katagoAnalyzePoint() 返回值，形如 { rootInfo, moveInfos, point }。
// 内容：当前胜率、目差、焦点格数据、邻域候选；
// 结尾标注数据来自 KataGo，防止模型编造。
export function buildPointAnalysisFacts(result, size) {
  if (!result) return "";
  const lines = [];
  const root = result.rootInfo || {};
  const moveInfos = result.moveInfos || [];
  const point = result.point || {};

  // 1) 当前胜率
  if (typeof root.winrate === "number") {
    const bp = Math.round(root.winrate * 100);
    lines.push(`当前黑方胜率：${bp}%（白方 ${100 - bp}%）。`);
  }

  // 2) 目差
  if (typeof root.scoreLead === "number") {
    const lead = root.scoreLead;
    lines.push(`当前局势判断：${lead >= 0 ? "黑方占优" : "白方占优"}，${lead >= 0 ? "黑" : "白"}方领先约 ${Math.abs(lead).toFixed(1)} 目。`);
  }

  // 3) 焦点格分析结果
  const sideName = point.side === "W" ? "白" : "黑";
  if (point.coord) {
    if (point.inTopCandidates) {
      const rank = (typeof point.order === "number" && point.order >= 0) ? point.order + 1 : "?";
      lines.push(`焦点格 ${point.coord}：是 KataGo 推荐的第 ${rank} 位候选。`);
    } else {
      lines.push(`焦点格 ${point.coord}：KataGo 没把它列为靠前候选，以下是临时替${sideName}在这儿落一手再分析得到的数据：`);
    }
    if (typeof point.winrate === "number") {
      lines.push(`  · 假设${sideName}方在 ${point.coord} 落子，落子后黑方胜率约 ${Math.round(point.winrate * 100)}%。`);
    }
    if (typeof point.delta === "number") {
      const d = Math.round(point.delta * 100);
      const verdict = d === 0 ? "对局面基本没影响" : (d > 0 ? "有利于黑方" : "不利于黑方");
      lines.push(`  · 这手使黑方胜率变化：${d >= 0 ? "+" : ""}${d} 个百分点（${verdict}）。`);
    }
    if (typeof point.scoreLead === "number") {
      lines.push(`  · 落子后目差约 ${point.scoreLead >= 0 ? "黑+" : "白"}${Math.abs(point.scoreLead).toFixed(1)}。`);
    }
  }

  // 4) 邻域候选（上下左右四格）
  if (Array.isArray(point.cell)) {
    const [r, c] = point.cell;
    const dirs = [["上", r - 1, c], ["下", r + 1, c], ["左", r, c - 1], ["右", r, c + 1]];
    const neigh = [];
    for (const [dir, nr, nc] of dirs) {
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      const ncoord = coordToText(nr, nc, size);
      const m = moveInfos.find(x => x && x.move && String(x.move).trim().toUpperCase() === ncoord.toUpperCase());
      if (m && typeof m.winrate === "number") {
        const rank = typeof m.order === "number" ? m.order + 1 : "?";
        neigh.push(`${dir}(${ncoord}):候选第${rank}位,落子后黑胜率约${Math.round(m.winrate * 100)}%`);
      } else {
        neigh.push(`${dir}(${ncoord}):非推荐候选`);
      }
    }
    if (neigh.length) {
      lines.push(`邻域候选（${point.coord} 的上下左右）：`);
      neigh.forEach(s => lines.push(`  ${s}`));
    }
  }

  // 5) 顶部候选（供模型参考，按序）
  const top = moveInfos
    .filter(m => m && m.move && m.move !== "pass")
    .sort((a, b) => {
      const ao = (typeof a.order === "number" && a.order >= 0) ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = (typeof b.order === "number" && b.order >= 0) ? b.order : Number.MAX_SAFE_INTEGER;
      return ao - bo;
    })
    .slice(0, 3);
  if (top.length) {
    lines.push(`KataGo 推荐的前几手（按序）：`);
    top.forEach((m, i) => {
      const wr = typeof m.winrate === "number" ? Math.round(m.winrate * 100) : "?";
      lines.push(`  ${i + 1}. ${m.move}（此手后黑胜率约 ${wr}%）`);
    });
  }

  lines.push("以上数据都由 KataGo 算出，你只需把它翻译成通俗的讲解。");
  return lines.join("\n");
}

// 便捷：构造对手
export function makeOpponent(cfg) {
  const level = cfg.aiLevel || "入门";
  return {
    type: cfg.opponentType || "local",
    level,
    // 远程大模型对手
    async remoteChoose(board, color) {
      const opp = new LLMOpponent(cfg.oppBaseUrl, cfg.oppApiKey, cfg.oppModel);
      return await opp.chooseMove(board, color, level);
    },
  };
}
