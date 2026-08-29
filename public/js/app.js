// 围棋 AI 启蒙教练：主逻辑
// 负责：棋盘绘制、对弈交互、教练对话、死活题、棋谱、设置。

import { GoBoard, BLACK, WHITE, EMPTY, opponent, coordToText, textToCoord } from "./go_core.js";
import { GoAI } from "./go_ai.js";
import { PROBLEMS } from "./problems.js";
import { toSgf, fromSgf, downloadSgf, readSgfFile, replayHistory } from "./sgf.js";
import { LLMOpponent, ExplainAI, askCoachStream, cleanMarkdown, boardCoordList, boardText, ANALYSIS_SYSTEM, buildPointAnalysisFacts } from "./ai_api.js";
import { katagoAnalyze, katagoMove, katagoAnalyzePoint, parseKatagoCoord, ownershipToTerritory } from "./katago_client.js";
import { currentTurnCore, turnIsHumanCore, starPoints, pixelToCellCore, probPixelToCellCore, buildMoveListCore, checkProblemAnswerCore, isTwoPassGameEnd } from "./app_logic.js";

// ---------- 常量 ----------
const BLACK_MOVE_FIRST = BLACK; // 黑先

// ---------- 全局状态 ----------
const state = {
  board: new GoBoard(9),
  size: 9,
  humanColor: BLACK,       // 用户执黑=1
  opponentType: "katago",  // katago | local
  aiLevel: "入门",
  showCoords: true,
  showTerritory: false,
  autoExplain: false,
  gameOver: false,
  hoverCell: null,        // 悬停的格子 [r,c]
  lastMove: null,          // 最近落子 [r,c]
  lastMoveColor: null,
  suggestPoints: null,     // AI 推荐点
  thinking: false,
  autoPlay: false,         // 自动按蓝点（最优推荐）下棋
  autoPlayTimer: null,     // 自动下棋的定时器引用
  review: { size: 9, history: [], step: 0 },
  currentProblem: 0,
  probMoves: [],        // 用户在死活题上落的子
  kataAnalysis: null,   // KataGo 最近一次分析结果
  katagoReady: true,    // 后端 KataGo 是否可用
  kataTerritory: null,  // KataGo 领地 {black:Set, white:Set}
  kataScoreLead: null,  // KataGo 目差
  // 分析模式独立状态，不复用正式对局的 board，避免互相干扰
  analysis: {
    board: null,        // GoBoard（非 null 时表示已初始化）
    size: 9,
    activeColor: BLACK,     // 当前摆子颜色（BLACK=黑, WHITE=白, 0=删子）
    showCoords: true,       // 是否显示坐标
    hoverCell: null,        // 悬停格子 [r,c]
    selectedCell: null,     // 最近一次点格分析的格子 [r,c]
    pointResult: null,      // katagoAnalyzePoint 返回的 {rootInfo, moveInfos, point}
    analyzing: false,        // 点格分析进行中
    pointMode: false,        // 点格分析模式（true=点格子触发分析，false=摆子）
    mainHistory: [],         // 复制主局面时的主对局手顺快照（整盘分析基准）
    editHistory: [],         // 玩家在分析盘摆子/删子的虚拟手顺（整盘分析用）
  },
};

// 从 localStorage 读配置
const LS_KEY = "goai_config_v1";
function defaultCfg() {
  return {
    coachUrl: "", coachKey: "", coachModel: "deepseek-v4-pro",
    oppUrl: "", oppKey: "", oppModel: "deepseek-v4-flash",
    kataLevel: "top5",
  };
}
let cfg = loadCfg();

function loadCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(LS_KEY));
    if (c) return Object.assign(defaultCfg(), c);
  } catch (e) {}
  return defaultCfg();
}
function saveCfg() { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }

// ---------- DOM 引用 ----------
const $ = (id) => document.getElementById(id);
const el = {
  board: $("board"),
  probBoard: $("prob-board"),
  winrate: { bar: $("winrate-bar"), black: $("winrate-black"), white: $("winrate-white") },
  wrBlack: $("wr-black-label"), wrWhite: $("wr-white-label"),
  hint: $("board-hint"),
  connDot: $("conn-dot"), connText: $("conn-text"),
  movesList: $("moves-list"),
  infoCaptures: $("info-captures"), infoMoves: $("info-moves"), infoScore: $("info-score"),
  analyzeBoard: $("analyze-board"),
  analyzeHint: $("analyze-hint"),
  analyzeResult: $("analyze-result"),
  analyzeChat: $("analyze-chat"),
  analyzeStreaming: $("analyze-streaming"),
};

// ---------- 后端健康检查 ----------
async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    if (j.ok) { el.connDot.className = "dot dot-ok"; el.connText.textContent = "后端已连接"; return true; }
  } catch (e) {}
  el.connDot.className = "dot dot-err";
  el.connText.textContent = "后端未连接";
  return false;
}
checkHealth();

// ---------- 标签页切换 ----------
document.querySelectorAll("#tabs button").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-body").forEach(b => b.classList.toggle("active", b.id === "tab-" + name));
  if (name === "problems") { refreshProblemBoard(); }
  if (name === "review") { refreshSgfText(); }
  if (name === "analyze") { ensureAnalysisBoard(); redrawAnalysis(); }
}

// ---------- 对弈状态 ----------
function currentTurn() {
  // 返回当前该谁下（BLACK/WHITE）
  return currentTurnCore(state.board.history.length);
}

function aiColor() { return opponent(state.humanColor); }

function turnIsHuman() {
  return turnIsHumanCore(state.board.history.length, state.humanColor);
}

// ---------- 棋盘绘制 ----------
function boardPixelSize() {
  // canvas 实际分辨率（用 devicePixelRatio 保证高清）
  return { w: el.board.clientWidth, h: el.board.clientHeight };
}

function drawBoard() {
  const canvas = el.board;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const size = state.size;
  const n = size;
  // 为坐标预留边距
  const coordPad = state.showCoords ? w * 0.045 : 0;
  const margin = w * 0.05 + coordPad;
  const cell = (w - margin * 2) / (n - 1);

  // 底纹
  ctx.fillStyle = "#e8c281";
  ctx.fillRect(0, 0, w, h);

  // 坐标标注
  if (state.showCoords) {
    ctx.fillStyle = "#6b4d28";
    ctx.font = `${Math.round(cell*0.5)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const letters = "ABCDEFGHJKLMNOPQRST";
    for (let c = 0; c < n; c++) {
      const x = margin + c * cell;
      ctx.fillText(letters[c], x, margin * 0.5);
      ctx.fillText(letters[c], x, h - margin * 0.5);
    }
    for (let r = 0; r < n; r++) {
      const y = margin + r * cell;
      const rowNo = n - r;
      ctx.fillText(String(rowNo), margin * 0.5, y);
      ctx.fillText(String(rowNo), w - margin * 0.5, y);
    }
  }


  // 网格线
  ctx.strokeStyle = "#4a3828";
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const p = margin + i * cell;
    ctx.beginPath(); ctx.moveTo(margin, p); ctx.lineTo(w - margin, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, margin); ctx.lineTo(p, h - margin); ctx.stroke();
  }

  // 星位
  const stars = starPoints(n);
  ctx.fillStyle = "#4a3828";
  for (const [r, c] of stars) {
    ctx.beginPath();
    ctx.arc(margin + c * cell, margin + r * cell, cell * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }

  // 领地（实心小方块，放格子中心）
  // 优先用 KataGo 的地界数据，没有就用本地估算
  if (state.showTerritory && !state.gameOver) {
    let blackSet, whiteSet;
    if (state.kataTerritory) {
      blackSet = state.kataTerritory.black;
      whiteSet = state.kataTerritory.white;
    } else {
      const terr = state.board.estimateTerritory();
      blackSet = terr.black;
      whiteSet = terr.white;
    }
    const sq = cell * 0.30;
    for (const key of blackSet) {
      const [r, c] = key.split(",").map(Number);
      const x = margin + c * cell, y = margin + r * cell;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x - sq / 2, y - sq / 2, sq, sq);
    }
    for (const key of whiteSet) {
      const [r, c] = key.split(",").map(Number);
      const x = margin + c * cell, y = margin + r * cell;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(x - sq / 2, y - sq / 2, sq, sq);
      ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 0.5; ctx.strokeRect(x - sq / 2, y - sq / 2, sq, sq);
    }
  }

  // 推荐点（彩色圆点，来自 KataGo top 候选）
  // 只在轮到人类下、且不是 AI 思考中时才显示（推荐点是给人类看"该下哪"的，
  // 轮到 AI 走时显示这些点既无意义又干扰）
  if (state.suggestPoints && state.suggestPoints.length && turnIsHuman() && !state.thinking) {
    const superCell = state.suggestPoints;
    superCell.forEach((sp, i) => {
      if (!sp.cell) return;
      const [r, c] = sp.cell;
      const x = margin + c * cell, y = margin + r * cell;
      const hue = i === 0 ? 200 : i === 1 ? 140 : 40;  // 蓝 / 绿 / 橙
      ctx.fillStyle = `hsla(${hue}, 75%, 45%, 0.55)`;
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1; ctx.stroke();
    });
  }

  // 坐标暂时不画在格子内，避免和棋子/领地抢视觉
  // 最后一手标记
  if (state.lastMove) {
    const [lr, lc] = state.lastMove;
    const lx = margin + lc * cell, ly = margin + lr * cell;
    ctx.fillStyle = state.lastMoveColor === BLACK ? "#fff" : "#111";
    ctx.beginPath();
    ctx.arc(lx, ly, cell * 0.10, 0, Math.PI * 2);
    ctx.fill();
  }

  // 悬停预览
  if (state.hoverCell && !state.gameOver) {
    const [hr, hc] = state.hoverCell;
    if (state.board.get(hr, hc) === EMPTY) {
      drawGhostStone(ctx, hr, hc, currentTurn(), margin, cell);
    }
  }

  // 棋子（含上一手的稍微半透明标记）
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = state.board.get(r, c);
      if (v !== EMPTY) drawStone(ctx, r, c, v, margin, cell);
    }
  }
}

// starPoints 已从 app_logic.js import

function drawGhostStone(ctx, r, c, color, margin, cell) {
  const x = margin + c * cell, y = margin + r * cell;
  ctx.globalAlpha = 0.45;
  drawStone(ctx, r, c, color, margin, cell);
  ctx.globalAlpha = 1;
}

function drawStone(ctx, r, c, color, margin, cell) {
  const x = margin + c * cell, y = margin + r * cell;
  const rad = cell * 0.42;
  // 阴影
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.arc(x + rad * 0.12, y + rad * 0.14, rad, 0, Math.PI * 2); ctx.fill();
  // 本体
  const g = ctx.createRadialGradient(x - rad * 0.3, y - rad * 0.3, rad * 0.2, x, y, rad);
  if (color === BLACK) {
    g.addColorStop(0, "#555");
    g.addColorStop(0.7, "#1c1c1c");
    g.addColorStop(1, "#000");
  } else {
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.7, "#f0f0f0");
    g.addColorStop(1, "#c9c9c9");
  }
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
  if (color === WHITE) {
    ctx.strokeStyle = "#b7b7b7"; ctx.lineWidth = 1; ctx.stroke();
  }
}

// 把 canvas 内的像素坐标转成格子索引
function pixelToCell(px, py) {
  const w = el.board.clientWidth;
  return pixelToCellCore(px, py, w, state.size, state.showCoords);
}

// ---------- 对弈更新 ----------
function render() { drawBoard(); updateInfo(); updateMovesList(); }

function updateInfo() {
  const cap = state.board.captures;
  el.infoCaptures.textContent = `黑 ${cap[BLACK]} : 白 ${cap[WHITE]}`;
  el.infoMoves.textContent = String(state.board.history.length);
  // 还没有 KataGo 数据时，先用本地估算占位
  if (!state.kataAnalysis) {
    const ev = state.board.evaluate();
    el.infoScore.textContent = `估算 黑 ${ev.black.toFixed(1)} : 白 ${ev.white.toFixed(1)}（KataGo 分析中…）`;
    updateWinrate(ev);
  } else if (typeof state.kataScoreLead === "number") {
    el.infoScore.textContent = `目差 ${state.kataScoreLead >= 0 ? "黑+" : "白"}${Math.abs(state.kataScoreLead).toFixed(1)}`;
  }
}

function updateWinrate(ev) {
  const b = ev.black, w = ev.white;
  const total = b + w;
  const bp = total > 0 ? Math.round((b / total) * 100) : 50;
  setWinrateBar(bp);
}

// KataGo 精确胜率（黑视角 0~1）
// 记录上一次 KataGo 胜率，波动大时给一句解释
let _lastKataWinrate = null;
function updateWinrateFromKata(blackWinrate) {
  const bp = Math.round(blackWinrate * 100);
  // 胜率骤变检测：相邻两次差 30 个百分点以上时提示
  if (_lastKataWinrate !== null && Math.abs(bp - _lastKataWinrate) >= 30) {
    el.hint.textContent = `胜率变化较大（${_lastKataWinrate}% → ${bp}%）：通常是有子被提，或此前的估算不准。`;
  }
  _lastKataWinrate = bp;
  setWinrateBar(bp);
  // 同步目差显示
  if (typeof state.kataScoreLead === "number") {
    el.infoScore.textContent = `目差 ${state.kataScoreLead >= 0 ? "黑+" : "白"}${Math.abs(state.kataScoreLead).toFixed(1)}`;
  }
}

function setWinrateBar(blackPct) {
  const bp = Math.max(0, Math.min(100, blackPct));
  const wp = 100 - bp;
  el.winrate.black.style.width = bp + "%";
  el.winrate.white.style.width = wp + "%";
  el.wrBlack.textContent = `黑 ${bp}%`;
  el.wrWhite.textContent = `白 ${wp}%`;
}

function updateMovesList() {
  const moves = [];
  for (let i = 0; i < state.board.history.length; i++) {
    const h = state.board.history[i];
    const st = h.color === BLACK ? "黑" : "白";
    const txt = h.r < 0 ? "pass" : coordToText(h.r, h.c, state.size);
    const num = Math.floor(i / 2) + 1;
    moves.push(`${num}.${st}${txt}`);
  }
  el.movesList.innerHTML = moves.join(" ");
  el.movesList.scrollTop = el.movesList.scrollHeight;
}

// ---------- 新对局 ----------
function newGame() {
  state.board = new GoBoard(state.size);
  state.gameOver = false;
  state.lastMove = null;
  state.suggestPoints = null;
  state.thinking = false;
  state.kataAnalysis = null;
  state.kataTerritory = null;
  state.kataScoreLead = null;
  _lastKataWinrate = null; // 重置波动记录，避免新对局开局误报突变
  render();
  el.hint.textContent = "轮到黑方落子";
  clearChat();
  // 如果用户执白，则 AI（黑）先走
  if (state.humanColor === WHITE) {
    doAiTurn();
  }
  return true;
}

// ---------- 落子 ----------
function humanMove(r, c) {
  if (state.gameOver || state.thinking) return;
  if (!state.board.isLegal(r, c, state.humanColor)) return;
  place(r, c, state.humanColor);
}

function place(r, c, color) {
  state.board.play(r, c, color);
  state.lastMove = [r, c];
  state.lastMoveColor = color;
  state.suggestPoints = null;
  render();
  checkGameEnd();
  // 每次落子后触发一次 KataGo 分析（异步，不阻塞）
  requestKataAnalysis();
  if (state.autoExplain && !state.gameOver) {
    scheduleAutoExplain();
  }
  // 落子后若轮到 AI，触发它走棋
  if (!state.gameOver && !turnIsHuman()) {
    doAiTurn();
  }
}

// ---------- 自动按蓝点下棋 ----------
function stopAutoPlay(msg) {
  state.autoPlay = false;
  if (state.autoPlayTimer) { clearTimeout(state.autoPlayTimer); state.autoPlayTimer = null; }
  const b = $("btn-auto-play");
  if (b) { b.classList.remove("active"); b.textContent = "自动按蓝点下棋"; }
  if (msg) el.hint.textContent = msg;
  else if (!state.gameOver) el.hint.textContent = turnIsHuman() ? "轮到你落子" : "AI 思考中…";
}

function toggleAutoPlay() {
  if (state.gameOver) { el.hint.textContent = "对局已结束，请先新对局。"; return; }
  state.autoPlay = !state.autoPlay;
  const b = $("btn-auto-play");
  if (state.autoPlay) {
    b.classList.add("active");
    b.textContent = "停止自动下棋";
    el.hint.textContent = "自动下棋中：按 KataGo 蓝点替你落子…";
    // 先刷新一次分析，保证有最新的推荐点
    requestKataAnalysis();
    autoPlayTick();
  } else {
    stopAutoPlay();
  }
}

// 尝试走一步自动棋：轮到人类、有推荐点、未终局、AI 没在思考时才下手。
// 落子后 AI 应手、再触发分析，分析完成后由钩子调回这里，循环进行。
function autoPlayTick() {
  if (!state.autoPlay) return;
  if (state.gameOver) { stopAutoPlay("对局结束，自动下棋停止。"); return; }
  if (state.thinking) return;             // AI 还在思考，等它
  if (!turnIsHuman()) return;             // 轮到 AI，等它落子后由分析钩子驱动
  const sp = state.suggestPoints;
  if (!sp || !sp.length || !sp[0] || !sp[0].cell) {
    // 还没有推荐点：稍等重试（分析回来会经钩子再次进入）
    el.hint.textContent = "自动下棋：等待 KataGo 推荐点…";
    return;
  }
  const [r, c] = sp[0].cell;
  if (state.board.get(r, c) !== EMPTY) { stopAutoPlay("推荐点被占，自动下棋停止，请手动处理。"); return; }
  place(r, c, state.humanColor);
}

// 请求 KataGo 分析当前局面，刷新胜率/推荐点/领地/目数
let _kataSeq = 0;
async function requestKataAnalysis() {
  const seq = ++_kataSeq;
  try {
    const moves = buildMoveList();
    const result = await katagoAnalyze(moves, state.size, { maxVisits: 400, includeOwnership: false });
    if (seq !== _kataSeq) return; // 已有更新的请求，丢弃过期结果
    state.kataAnalysis = result;
    state.katagoReady = true;
    applyKataAnalysis(result);
  } catch (e) {
    state.katagoReady = false;
    // 失败不打断，继续用本地估算的胜率/领地
  }
}

function applyKataAnalysis(result) {
  if (!result) return;
  // 1) 胜率
  if (result.rootInfo && typeof result.rootInfo.winrate === "number") {
    updateWinrateFromKata(result.rootInfo.winrate);
  }
  // 2) 领地（ownership）
  if (result.ownership) {
    const terr = ownershipToTerritory(result.ownership, state.size);
    state.kataTerritory = terr;
  }
  // 3) 推荐点（top 3 候选 + 胜率变化）
  // KataGo 返回的 moveInfos 不保证按优劣排序，按 order 字段升序取前几名。
  if (result.moveInfos && result.moveInfos.length) {
    const ranked = result.moveInfos
      .filter(m => m && m.move && m.move !== "pass")
      .sort((a, b) => {
        const ao = (typeof a.order === "number" && a.order >= 0) ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = (typeof b.order === "number" && b.order >= 0) ? b.order : Number.MAX_SAFE_INTEGER;
        return ao - bo;
      })
      .slice(0, 3);
    state.suggestPoints = ranked.map(m => {
      const cell = parseKatagoCoord(m.move, state.size);
      return { cell, winrate: m.winrate, scoreLead: m.scoreLead, order: m.order };
    }).filter(p => p.cell);
  }
  // 4) 目差（scoreLead）
  if (result.rootInfo && typeof result.rootInfo.scoreLead === "number") {
    state.kataScoreLead = result.rootInfo.scoreLead;
  }
  render();
  // 自动下棋模式下：分析完成后若轮到人类且未终局，驱动下一步（闭环）
  if (state.autoPlay && turnIsHuman() && !state.thinking) {
    state.autoPlayTimer = setTimeout(autoPlayTick, 220);
  }
}


function checkGameEnd() {
  // 简单终局判断：连续两次停手就结束
  if (isTwoPassGameEnd(state.board.history)) {
    state.gameOver = true;
    el.hint.textContent = "对局结束（双方停手）";
    computeFinal();
  }
}

function computeFinal() {
  // 终局：area 计点
  const ev = state.board.evaluate();
  // evaluate 已经是粗略目数；通知用户结果
  const b = ev.black, w = ev.white;
  let msg = `终局估算：黑 ${b.toFixed(1)} : 白 ${w.toFixed(1)}。`;
  if (b > w) msg += "黑方领先。"; else if (w > b) msg += "白方领先。"; else msg += "基本持平。";
  el.hint.textContent = msg;
}

// ---------- AI 走子 ----------
function buildMoveList() {
  return buildMoveListCore(state.board.history, state.size);
}

async function doAiTurn() {
  if (state.gameOver) return;
  if (state.thinking) return; // 防重入
  state.thinking = true;
  el.hint.textContent = "AI 思考中…";
  render();

  const color = aiColor();
  let move = null;

  // 优先用 KataGo 引擎
  try {
    if (state.opponentType === "katago") {
      const res = await katagoMove(buildMoveList(), state.size, state.aiLevel);
      // KataGo 无可选点时返回字符串 "pass"（不是对象），直接停手，
      // 不退回内置 AI 强行走一手。
      if (res === "pass" || res?.move === "pass") {
        state.board.history.push({ color, r: -1, c: -1, captured: [] });
        render();
        checkGameEnd();
        el.hint.textContent = turnIsHuman() ? "轮到你落子" : "AI 停手";
        requestKataAnalysis();
        return;
      }
      const coord = parseKatagoCoord(res.move, state.size);
      if (coord) {
        move = coord;
      }
    }

    // 回退：KataGo 没给出可用落点时用内置 AI
    if (move === null) {
      const bot = new GoAI(color, state.aiLevel);
      move = bot.chooseMove(state.board);
    }
  } finally {
    // 无论如何都要释放 thinking 锁，避免一次异常把 AI/教练请求永久卡死
    state.thinking = false;
  }

  if (move === null) {
    // 停手
    state.board.history.push({ color, r: -1, c: -1, captured: [] });
    render();
    checkGameEnd();
    el.hint.textContent = turnIsHuman() ? "轮到你落子" : "AI 停手";
  } else {
    place(move[0], move[1], color);
    el.hint.textContent = turnIsHuman() ? "轮到你落子" : "AI 思考中…";
  }
  // 落子后触发一次 KataGo 分析，刷新胜率/推荐点/领地
  requestKataAnalysis();
}

function scheduleAutoExplain() {
  // 延迟一点，避免挡围棋落子
  setTimeout(() => {
    if (!state.gameOver) coachReviewLast();
  }, 400);
}

// ---------- 悬停与点击 ----------
function onBoardMouseMove(ev) {
  const rect = el.board.getBoundingClientRect();
  const cell = pixelToCell(ev.clientX - rect.left, ev.clientY - rect.top);
  state.hoverCell = cell;
  drawBoard();
}

function onBoardMouseLeave() {
  state.hoverCell = null;
  drawBoard();
}

function onBoardClick(ev) {
  const rect = el.board.getBoundingClientRect();
  const cell = pixelToCell(ev.clientX - rect.left, ev.clientY - rect.top);
  if (!cell) return;
  const [r, c] = cell;

  // 右键 => 问教练这个点
  if (ev.button === 2 || ev.shiftKey) {
    ev.preventDefault();
    coachQueryPoint(r, c);
    return;
  }

  // 左键落子
  if (!turnIsHuman()) { addHintMessage("现在轮到对方（AI）走，请稍等。"); return; }
  humanMove(r, c);
}

// ---------- 教练 ----------
const coachChat = $("coach-chat");

function clearChat() {
  coachChat.innerHTML = "";
  $("coach-streaming").hidden = true;
}

function addMessage(who, text, streamEl, container) {
  const c = container || coachChat;
  const msg = document.createElement("div");
  msg.className = "msg " + who;
  const bub = document.createElement("div");
  bub.className = "bubble";
  bub.textContent = text || "";
  const wh = document.createElement("span");
  wh.className = "who";
  wh.textContent = who === "user" ? "我" : "教练";
  msg.appendChild(wh);
  msg.appendChild(bub);
  c.appendChild(msg);
  c.scrollTop = c.scrollHeight;
  return bub;
}

function addHintMessage(text, container) {
  const c = container || coachChat;
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.style.color = "#999";
  msg.style.fontSize = "12px";
  msg.textContent = text;
  c.appendChild(msg);
  c.scrollTop = c.scrollHeight;
}

// 教练流式请求并发锁：同一时刻只允许一个教练请求写 coach-streaming，
// 防止自动讲解与手动点击并发时 token 交错，产出乱序文本。
let _coachBusy = false;

async function coachAsk(kind, lastMoveOverride) {
  if (state.thinking) return; // 对局中 AI 思考时也别抢
  if (_coachBusy) return; // 已有教练请求进行中，忽略本次（治并发乱序）
  const hasCoach = cfg.coachKey;
  if (!hasCoach) {
    addHintMessage("请先在「设置」页配置教练 AI 的 API Key。");
    return;
  }
  const last = lastMoveOverride || (state.lastMove ? {r: state.lastMove[0], c: state.lastMove[1]} : null);

  _coachBusy = true;
  try {
    // 构造 prompt（用 ExplainAI 逻辑）
    let system, user;
    const explainer = new ExplainAI(cfg.coachUrl, cfg.coachKey, cfg.coachModel);
    const built = explainer.buildPrompt(state.board, currentTurn(), last ? [last.r, last.c] : null, kind);
    system = built.system; user = built.user;

    // 附上 KataGo 的数据，模型只负责讲解，不替引擎判断
    const kataFacts = buildKataFacts();
    if (kataFacts) {
      user += "\n\n以下是 KataGo 引擎算出的数据，请据此讲解，不要自己再猜局面：\n" + kataFacts;
    }

    // 流式展示
    $("coach-streaming").hidden = false;
    const streamEl = $("coach-streaming");
    streamEl.textContent = "";
    await askCoachStream({
      baseUrl: cfg.coachUrl, apiKey: cfg.coachKey, model: cfg.coachModel,
      system, user, temperature: 0.5,
      onToken: (t) => { streamEl.textContent += t; streamEl.scrollTop = streamEl.scrollHeight; }
    }).catch(e => {
      addHintMessage("教练请求失败：" + e.message);
      return;
    });

    $("coach-streaming").hidden = true;
    const finalText = streamEl.textContent;
    streamEl.textContent = "";
    addMessage("assistant", finalText);
    return finalText;
  } finally {
    _coachBusy = false;
  }
}

function coachQueryPoint(r, c) {
  if (!cfg.coachKey) { addHintMessage("请先在「设置」页配置教练 AI 的 API Key。"); return; }
  // 点一个点问"这里怎么样"
  const coord = coordToText(r, c, state.size);
  const what = state.board.get(r, c);
  let q;
  if (what === EMPTY) q = `空点 ${coord}`;
  else q = `${what===BLACK?"黑":"白"}子 ${coord}`;
  addMessage("user", q);

  // 复用 point_query
  coachAsk("point_query", {r, c});
}

function coachReviewLast() {
  coachAsk("review_last");
}

// 把 KataGo 的分析结果整理成给模型的讲解素材
function buildKataFacts() {
  const ka = state.kataAnalysis;
  if (!ka || !ka.rootInfo) return "";
  const lines = [];
  const root = ka.rootInfo;
  if (typeof root.winrate === "number") {
    const bp = Math.round(root.winrate * 100);
    lines.push(`当前黑方胜率：${bp}%（白方 ${100 - bp}%）。`);
  }
  if (typeof root.scoreLead === "number") {
    const lead = root.scoreLead;
    lines.push(`当前局势胜负判断：${lead >= 0 ? "黑方占优" : "白方占优"}，${lead >= 0 ? "黑" : "白"}方领先约 ${Math.abs(lead).toFixed(1)} 目。`);
  }
  if (ka.moveInfos && ka.moveInfos.length) {
    // 按 order 升序取候选
    const ranked = ka.moveInfos
      .filter(m => m && m.move && m.move !== "pass")
      .sort((a, b) => {
        const ao = (typeof a.order === "number" && a.order >= 0) ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = (typeof b.order === "number" && b.order >= 0) ? b.order : Number.MAX_SAFE_INTEGER;
        return ao - bo;
      })
      .slice(0, 3);
    lines.push(`KataGo 推荐的前几手（按序）：`);
    ranked.forEach((m, i) => {
      const coord = m.move;
      const wr = Math.round((m.winrate || 0) * 100);
      lines.push(`  ${i+1}. ${coord}（此手后黑胜率约 ${wr}%）`);
    });
  }
  return lines.join("\n");
}

// ---------- 死活题 ----------
const probCanvas = el.probBoard;

function refreshProblemBoard() {
  const p = PROBLEMS[state.currentProblem];
  $("prob-name").textContent = `${state.currentProblem + 1}. ${p.name}`;
  $("prob-counter").textContent = `${state.currentProblem + 1} / ${PROBLEMS.length}`;
  $("prob-tip").textContent = p.tip;
  $("prob-expl").hidden = true;
  $("prob-result").textContent = "";
  $("prob-result").className = "prob-result";
  state.probMoves = [];
  drawProblemBoard();
}

function drawProblemBoard() {
  const p = PROBLEMS[state.currentProblem];
  const n = p.size;
  const dpr = window.devicePixelRatio || 1;
  const w = probCanvas.clientWidth || 360;
  probCanvas.width = w * dpr;
  probCanvas.height = w * dpr;
  const ctx = probCanvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const n2 = n;
  const margin = w * 0.08;
  const cell = (w - margin * 2) / (n - 1);

  ctx.fillStyle = "#e8c281";
  ctx.fillRect(0, 0, w, w);

  // 网格线
  ctx.strokeStyle = "#4a3828"; ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const p2 = margin + i * cell;
    ctx.beginPath(); ctx.moveTo(margin, p2); ctx.lineTo(w - margin, p2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p2, margin); ctx.lineTo(p2, w - margin); ctx.stroke();
  }

  // 题目初始棋子
  for (const [colorLetter, r, c] of p.setup) {
    const col = colorLetter === "B" ? BLACK : WHITE;
    drawProbStone(ctx, r, c, col, margin, cell);
  }
  // 用户落子（标记为小一号，便于区分）
  for (const {r, c, color} of state.probMoves) {
    drawProbStone(ctx, r, c, color, margin, cell * 1.0);
  }
}

function drawProbStone(ctx, r, c, color, margin, cell) {
  const x = margin + c * cell, y = margin + r * cell;
  const rad = cell * 0.42;
  const g = ctx.createRadialGradient(x - rad*0.3, y - rad*0.3, rad*0.2, x, y, rad);
  if (color === BLACK) { g.addColorStop(0, "#555"); g.addColorStop(1, "#000"); }
  else { g.addColorStop(0, "#fff"); g.addColorStop(1, "#c9c9c9"); }
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
}

function probPixelToCell(px, py) {
  const n = PROBLEMS[state.currentProblem].size;
  const w = probCanvas.clientWidth || 360;
  return probPixelToCellCore(px, py, w, n);
}

function onProblemClick(ev) {
  const rect = probCanvas.getBoundingClientRect();
  const cell = probPixelToCell(ev.clientX - rect.left, ev.clientY - rect.top);
  if (!cell) return;
  const [r, c] = cell;
  const p = PROBLEMS[state.currentProblem];
  const color = p.your_color === "B" ? BLACK : WHITE;
  // 检查是否已占用
  const boardOcc = p.setup.some(([cl, r2, c2]) => r2===r && c2===c);
  const myOcc = state.probMoves.some(m => m.r===r && m.c===c);
  if (boardOcc || myOcc) { addHintMessage("这个位置已经有子了。"); return; }
  state.probMoves.push({r, c, color});
  drawProblemBoard();
}

function checkProblemAnswer() {
  const p = PROBLEMS[state.currentProblem];
  const res = $("prob-result");
  const ok = checkProblemAnswerCore(state.probMoves, p.answer);
  if (ok) {
    res.textContent = "答对了！";
    res.className = "prob-result ok";
    $("prob-expl").hidden = false;
    $("prob-expl").textContent = p.explain;
  } else {
    res.textContent = "还不对，再想想。（提示可点「显示提示」）";
    res.className = "prob-result bad";
  }
}

function nextProblem(d) {
  state.currentProblem = (state.currentProblem + d + PROBLEMS.length) % PROBLEMS.length;
  refreshProblemBoard();
}

function resetProblem() {
  state.probMoves = [];
  $("prob-result").textContent = "";
  $("prob-result").className = "prob-result";
  $("prob-expl").hidden = true;
  drawProblemBoard();
}

// ---------- 棋谱 ----------
function currentSgfText() {
  return toSgf(state.board.history, state.size, state.humanColor);
}

function refreshSgfText() {
  $("sgf-text").value = currentSgfText();
}

function exportSgf() {
  const sgf = currentSgfText();
  downloadSgf(sgf, "game.sgf");
}

function importSgfFile(file) {
  readSgfFile(file).then(text => {
    $("sgf-text").value = text;
    parseSgfToBoard(text);
  });
}

function parseSgfToBoard(text) {
  const { size, history } = fromSgf(text);
  state.review = { size, history, step: 0 };
  // 重建棋盘并按历史回放
  const board = replayHistory(GoBoard, size, history);
  state.board = board;
  state.size = size;
  // 载入新对局，避免用上一局的胜率做突变比较
  _lastKataWinrate = null;
  render();
  $("review-controls").hidden = false;
  $("rev-counter").textContent = `${0} / ${history.length}`;
}

function reviewStep(d) {
  const { size, history } = state.review;
  if (!history.length) return;
  state.review.step = Math.max(0, Math.min(history.length, state.review.step + d));
  // 重建到当前步
  const board = new GoBoard(size);
  for (let i = 0; i < state.review.step; i++) {
    const h = history[i];
    if (h.r >= 0) board.play(h.r, h.c, h.color);
  }
  state.board = board;
  state.size = size;
  // 回放到某步之后用上一个对局的胜率做突变比较会误报，清掉
  _lastKataWinrate = null;
  render();
  $("rev-counter").textContent = `${state.review.step} / ${history.length}`;
}

// ---------- 分析模式 ----------
function ensureAnalysisBoard() {
  if (state.analysis.board) {
    // 棋盘已存在，但确保尺寸与新对局尺寸同步（复制主局面/切尺寸时更新）
    redrawAnalysis();
    return;
  }
  state.analysis.board = new GoBoard(state.analysis.size);
  state.analysis.activeColor = BLACK;
  state.analysis.selectedCell = null;
  state.analysis.pointResult = null;
  redrawAnalysis();
}

function analysisPixelToCell(px, py) {
  const w = el.analyzeBoard.clientWidth || 360;
  return pixelToCellCore(px, py, w, state.analysis.size, state.analysis.showCoords);
}

// 清空分析棋盘
function analysisClear() {
  ensureAnalysisBoard();
  state.analysis.board = new GoBoard(state.analysis.size);
  state.analysis.selectedCell = null;
  state.analysis.pointResult = null;
  state.analysis.mainHistory = [];
  state.analysis.editHistory = [];
  renderAnalyzeResult(null);
  redrawAnalysis();
}

// 把正式对局的棋盘复制一份到分析棋盘，两边互不影响
function analysisCopyMain() {
  const mainBoard = state.board;
  // 逐格复制，不共享引用
  const copy = new GoBoard(mainBoard.size);
  copy.grid = mainBoard.grid.slice();
  copy.koPoint = mainBoard.koPoint;
  // 保留主局面的手顺，作为整盘分析的基准
  const histCopy = mainBoard.history.map(h => ({ color: h.color, r: h.r, c: h.c, captured: Array.isArray(h.captured) ? h.captured.slice() : [] }));
  copy.history = histCopy;
  copy.captures = { 1: mainBoard.captures[1] || 0, 2: mainBoard.captures[2] || 0 };
  state.analysis.size = mainBoard.size;
  state.analysis.board = copy;
  state.analysis.selectedCell = null;
  state.analysis.pointResult = null;
  state.analysis.mainHistory = histCopy.map(h => ({ color: h.color, r: h.r, c: h.c, captured: Array.isArray(h.captured) ? h.captured.slice() : [] }));
  state.analysis.editHistory = [];
  renderAnalyzeResult(null);
  redrawAnalysis();
  el.analyzeHint.textContent = `已把 ${mainBoard.size} 路主局面复制到分析棋盘（黑 ${mainBoard.count(BLACK)} : 白 ${mainBoard.count(WHITE)}），整盘分析以此为基准。`;
}

// 生成分析棋盘的棋盘局面 -> KataGo moves 数组
// 摆子不分先后，这里按行优先生成确定性顺序，供 KataGo 分析用。
function analysisBuildMoves() {
  const b = state.analysis.board;
  if (!b) return [];
  const moves = [];
  const n = b.size;
  // 先黑后白，按行列序排布（KataGo moves 需要有序，但摆子局面无顺序，这里约定先黑后白、行优先）
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = b.get(r, c);
      if (v === BLACK || v === WHITE) {
        moves.push([v === BLACK ? "B" : "W", coordToText(r, c, n)]);
      }
    }
  }
  return moves;
}

// 生成分析棋盘 -> SGF 用 history（含坐标），便于导出
function analysisBuildHistory() {
  const b = state.analysis.board;
  if (!b) return [];
  const n = b.size;
  const history = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = b.get(r, c);
      if (v === BLACK || v === WHITE) {
        history.push({ color: v, r, c, captured: [] });
      }
    }
  }
  return history;
}

function analysisExportSgf() {
  const history = analysisBuildHistory();
  const sgf = toSgf(history, state.analysis.size, BLACK);
  downloadSgf(sgf, "analysis.sgf");
  el.analyzeHint.textContent = "已导出 SGF 棋谱。";
}

// 分析模式对话区并发锁
let _analysisBusy = false;

// 分析模式：把当前分析局面的 KataGo 数据（胜率/候选/目差）按设置的数据量组装成文本。
// level: brief(胜率+top3) | top5(胜率+top5+目差) | full(全量候选+地界+目差)
async function buildAnalysisFacts(level) {
  const a = state.analysis;
  ensureAnalysisBoard();
  const moves = analysisBuildMoves();
  const size = a.size;
  const levelKey = level || cfg.kataLevel || "top5";

  const res = await katagoAnalyze(moves, size, {
    maxVisits: levelKey === "full" ? 120 : 80,
    includeOwnership: levelKey === "full",
  });
  const root = res.rootInfo || {};
  const moveInfos = (res.moveInfos || []).filter(m => m && m.move && m.move !== "pass");
  const lines = [];

  if (typeof root.winrate === "number") {
    lines.push(`当前局面黑方胜率 ${Math.round(root.winrate * 100)}%（白方 ${100 - Math.round(root.winrate * 100)}%）。`);
  }
  if (typeof root.scoreLead === "number") {
    lines.push(`目差：${root.scoreLead >= 0 ? "黑" : "白"}方领先约 ${Math.abs(root.scoreLead).toFixed(1)} 目。`);
  }

  const topN = levelKey === "brief" ? 3 : (levelKey === "full" ? Math.min(moveInfos.length, 10) : 5);
  const ranked = moveInfos.slice().sort((x, y) => {
    const xo = (typeof x.order === "number" && x.order >= 0) ? x.order : Number.MAX_SAFE_INTEGER;
    const yo = (typeof y.order === "number" && y.order >= 0) ? y.order : Number.MAX_SAFE_INTEGER;
    return xo - yo;
  });
  if (ranked.length) {
    lines.push(`KataGo 候选点（按推荐序，显示前 ${Math.min(topN, ranked.length)} 个）：`);
    for (let i = 0; i < Math.min(topN, ranked.length); i++) {
      const m = ranked[i];
      const wr = typeof m.winrate === "number" ? Math.round(m.winrate * 100) : "?";
      const lead = typeof m.scoreLead === "number" ? `${m.scoreLead >= 0 ? "黑+" : "白"}${Math.abs(m.scoreLead).toFixed(1)}` : "?";
      lines.push(`  ${i+1}. ${m.move}（落此点后黑胜率约 ${wr}%，目差 ${lead}）`);
    }
  }

  if (levelKey === "full" && res.ownership) {
    const terr = ownershipToTerritory(res.ownership, size);
    lines.push(`地界概况：黑方约 ${terr.black.size} 个势力点、白方约 ${terr.white.size} 个势力点。`);
  }

  lines.push("（以上数据由 KataGo 计算，你只负责翻译成教练讲解，不要自行判断对错。）");
  return lines.join("\n");
}

// 分析模式：向内嵌对话区教练自由提问 / 提出想法
async function analysisAsk(freeText) {
  if (!cfg.coachKey) { addHintMessage("请先在「设置」页配置教练 AI 的 API Key。", el.analyzeChat); return; }
  if (_analysisBusy) { addHintMessage("教练正在回答上一条，请稍候。", el.analyzeChat); return; }
  const a = state.analysis;
  ensureAnalysisBoard();
  if (!a.board) { addHintMessage("请先复制主局面或在分析盘摆子。", el.analyzeChat); return; }

  const q = (freeText || "").trim();
  if (!q) { addHintMessage("先输入你的想法或问题再发送。", el.analyzeChat); return; }

  addMessage("user", q, null, el.analyzeChat);
  _analysisBusy = true;
  try {
    const facts = await buildAnalysisFacts(cfg.kataLevel);
    const user = [
      `当前分析棋盘局面（${a.size} 路）：`,
      boardCoordList(a.board),
      ``,
      boardText(a.board),
      ``,
      facts,
      ``,
      `学生的问题/想法：${q}`,
    ].join("\n");

    el.analyzeStreaming.hidden = false;
    el.analyzeStreaming.textContent = "";
    await askCoachStream({
      baseUrl: cfg.coachUrl, apiKey: cfg.coachKey, model: cfg.coachModel,
      system: ANALYSIS_SYSTEM, user, temperature: 0.6,
      onToken: (t) => { el.analyzeStreaming.textContent += t; el.analyzeStreaming.scrollTop = el.analyzeStreaming.scrollHeight; }
    }).catch(e => { addHintMessage("教练请求失败：" + e.message, el.analyzeChat); });

    el.analyzeStreaming.hidden = true;
    const finalText = el.analyzeStreaming.textContent;
    el.analyzeStreaming.textContent = "";
    addMessage("assistant", finalText, null, el.analyzeChat);
  } finally {
    _analysisBusy = false;
  }
}

// 分析模式："这个点怎么样"：针对最近选中的格子问教练
async function analysisAskPoint() {
  if (!cfg.coachKey) { addHintMessage("请先在「设置」页配置教练 AI 的 API Key。", el.analyzeChat); return; }
  if (_analysisBusy) { addHintMessage("教练正在回答上一条，请稍候。", el.analyzeChat); return; }
  const a = state.analysis;
  ensureAnalysisBoard();
  if (!a.board) { addHintMessage("请先复制主局面或在分析盘摆子。", el.analyzeChat); return; }
  if (!a.selectedCell) { addHintMessage("请先在分析盘点一个空点（用「点格分析」按钮或右键点一下）。", el.analyzeChat); return; }

  const [r, c] = a.selectedCell;
  const coord = coordToText(r, c, a.size);
  _analysisBusy = true;
  addMessage("user", `这个点 ${coord} 怎么样？`, null, el.analyzeChat);
  try {
    // 复用已缓存的点格结果；否则重算
    let res = a.pointResult;
    if (!res || !res.point || !Array.isArray(res.point.cell) || res.point.cell[0] !== r || res.point.cell[1] !== c) {
      res = await katagoAnalyzePoint(analysisBuildMoves(), a.size, [r, c], { maxVisits: 60 });
      a.pointResult = res;
      el.analyzeResult.textContent = formatPointResult(res);
    }
    const facts = buildPointAnalysisFacts(res, a.size);
    const user = [
      `当前分析棋盘局面（${a.size} 路）：`,
      boardCoordList(a.board),
      ``,
      boardText(a.board),
      ``,
      facts,
      ``,
      `学生想知道这个点 ${coord} 好不好。`,
    ].join("\n");

    el.analyzeStreaming.hidden = false;
    el.analyzeStreaming.textContent = "";
    await askCoachStream({
      baseUrl: cfg.coachUrl, apiKey: cfg.coachKey, model: cfg.coachModel,
      system: ANALYSIS_SYSTEM, user, temperature: 0.6,
      onToken: (t) => { el.analyzeStreaming.textContent += t; el.analyzeStreaming.scrollTop = el.analyzeStreaming.scrollHeight; }
    }).catch(e => { addHintMessage("教练请求失败：" + e.message, el.analyzeChat); });

    el.analyzeStreaming.hidden = true;
    const finalText = el.analyzeStreaming.textContent;
    el.analyzeStreaming.textContent = "";
    addMessage("assistant", finalText, null, el.analyzeChat);
  } finally {
    _analysisBusy = false;
  }
}

// 分析模式："讲解当前局面"：对分析盘整体形势讲一遍
async function analysisExplain() {
  if (!cfg.coachKey) { addHintMessage("请先在「设置」页配置教练 AI 的 API Key。", el.analyzeChat); return; }
  if (_analysisBusy) { addHintMessage("教练正在回答上一条，请稍候。", el.analyzeChat); return; }
  const a = state.analysis;
  ensureAnalysisBoard();
  if (!a.board) { addHintMessage("请先复制主局面或在分析盘摆子。", el.analyzeChat); return; }

  addMessage("user", "讲解一下当前这个局面。", null, el.analyzeChat);
  _analysisBusy = true;
  try {
    const facts = await buildAnalysisFacts(cfg.kataLevel);
    const user = [
      `当前分析棋盘局面（${a.size} 路）：`,
      boardCoordList(a.board),
      ``,
      boardText(a.board),
      ``,
      facts,
      ``,
      `请像复盘教练一样，整体讲解这个局面：双方形势、关键要点，以及下一步大致思路。`,
    ].join("\n");

    el.analyzeStreaming.hidden = false;
    el.analyzeStreaming.textContent = "";
    await askCoachStream({
      baseUrl: cfg.coachUrl, apiKey: cfg.coachKey, model: cfg.coachModel,
      system: ANALYSIS_SYSTEM, user, temperature: 0.6,
      onToken: (t) => { el.analyzeStreaming.textContent += t; el.analyzeStreaming.scrollTop = el.analyzeStreaming.scrollHeight; }
    }).catch(e => { addHintMessage("教练请求失败：" + e.message, el.analyzeChat); });

    el.analyzeStreaming.hidden = true;
    const finalText = el.analyzeStreaming.textContent;
    el.analyzeStreaming.textContent = "";
    addMessage("assistant", finalText, null, el.analyzeChat);
  } finally {
    _analysisBusy = false;
  }
}

// 整盘分析：把主局面之后新增的步骤发给教练整体讲解
async function analysisAllMoves() {
  if (!cfg.coachKey) { addHintMessage("请先在「设置」页配置教练 AI 的 API Key。"); return; }
  if (_coachBusy) { addHintMessage("教练正在回复其他问题，请稍候。"); return; }
  const a = state.analysis;
  ensureAnalysisBoard();
  const edits = a.editHistory || [];
  if (!edits.length) {
    el.analyzeHint.textContent = "还没有在分析盘上摆新子。先「复制主局面」再摆几步，整盘分析会讲解你新增的这些步骤。";
    return;
  }
  const seqText = edits.map((m, i) => {
    const coord = coordToText(m.r, m.c, a.size);
    if (m.op === "erase") return `第${i+1}步 删子 ${coord}`;
    return `第${i+1}步 ${m.color === BLACK ? "黑" : "白"} ${coord}`;
  }).join("、");
  addMessage("user", `整盘分析：在主局面之上新增了 ${edits.length} 步：${seqText}`);

  _coachBusy = true;
  try {
    const explainer = new ExplainAI(cfg.coachUrl, cfg.coachKey, cfg.coachModel);
    // 下一手轮次：按最后一手落子的对方推算（删子不影响轮次）
    const lastEdit = edits[edits.length - 1];
    const nextColor = lastEdit.op === "erase" ? currentTurn() : (lastEdit.color === BLACK ? WHITE : BLACK);
    const built = explainer.buildPrompt(a.board, nextColor, null, "analyze_all", edits);
    let user = built.user;
    if (a.mainHistory && a.mainHistory.length) {
      const head = a.mainHistory.slice(0, 12).map(h => `${h.color === BLACK ? "黑" : "白"}${coordToText(h.r, h.c, a.size)}`).join("、");
      user += `\n\n主局面手顺（前 ${Math.min(12, a.mainHistory.length)} 手）：${head}${a.mainHistory.length > 12 ? " …" : ""}`;
    }
    el.analyzeHint.textContent = "整盘分析已发给教练，请到「教练」tab 查看讲解。";

    $("coach-streaming").hidden = false;
    const streamEl = $("coach-streaming");
    streamEl.textContent = "";
    await askCoachStream({
      baseUrl: cfg.coachUrl, apiKey: cfg.coachKey, model: cfg.coachModel,
      system: built.system, user, temperature: 0.5,
      onToken: (t) => { streamEl.textContent += t; streamEl.scrollTop = streamEl.scrollHeight; }
    }).catch(e => { addHintMessage("教练请求失败：" + e.message); });

    $("coach-streaming").hidden = true;
    const finalText = streamEl.textContent;
    streamEl.textContent = "";
    addMessage("assistant", finalText);
  } finally {
    _coachBusy = false;
  }
}

// ---------- 分析棋盘绘制 ----------
function redrawAnalysis() {
  if (!state.analysis.board) return;
  const canvas = el.analyzeBoard;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 360, h = canvas.clientHeight || 360;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const size = state.analysis.size;
  const n = size;
  const coordPad = state.analysis.showCoords ? w * 0.045 : 0;
  const margin = w * 0.05 + coordPad;
  const cell = (w - margin * 2) / (n - 1);

  // 底纹
  ctx.fillStyle = "#e8c281";
  ctx.fillRect(0, 0, w, h);

  // 坐标标注
  if (state.analysis.showCoords) {
    ctx.fillStyle = "#6b4d28";
    ctx.font = `${Math.round(cell*0.5)}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const letters = "ABCDEFGHJKLMNOPQRST";
    for (let c = 0; c < n; c++) {
      const x = margin + c * cell;
      ctx.fillText(letters[c], x, margin * 0.5);
      ctx.fillText(letters[c], x, h - margin * 0.5);
    }
    for (let r = 0; r < n; r++) {
      const y = margin + r * cell;
      const rowNo = n - r;
      ctx.fillText(String(rowNo), margin * 0.5, y);
      ctx.fillText(String(rowNo), w - margin * 0.5, y);
    }
  }

  // 网格线
  ctx.strokeStyle = "#4a3828";
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const p = margin + i * cell;
    ctx.beginPath(); ctx.moveTo(margin, p); ctx.lineTo(w - margin, p); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p, margin); ctx.lineTo(p, h - margin); ctx.stroke();
  }

  // 星位
  const stars = starPoints(n);
  ctx.fillStyle = "#4a3828";
  for (const [r, c] of stars) {
    ctx.beginPath();
    ctx.arc(margin + c * cell, margin + r * cell, cell * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }

  // 点格分析选中标记（高亮格子）
  if (state.analysis.selectedCell) {
    const [sr, sc] = state.analysis.selectedCell;
    const x = margin + sc * cell, y = margin + sr * cell;
    ctx.fillStyle = "rgba(220, 80, 40, 0.35)";
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.44, 0, Math.PI * 2);
    ctx.fill();
  }

  // 悬停预览（摆子工具下）
  if (state.analysis.hoverCell && !state.analysis.pointMode) {
    const [hr, hc] = state.analysis.hoverCell;
    if (state.analysis.board.get(hr, hc) === EMPTY && state.analysis.activeColor !== EMPTY) {
      drawGhostStone(ctx, hr, hc, state.analysis.activeColor, margin, cell);
    }
  }

  // 棋子
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = state.analysis.board.get(r, c);
      if (v !== EMPTY) drawStone(ctx, r, c, v, margin, cell);
    }
  }
}

// ---------- 分析棋盘事件 ----------
function onAnalyzeMouseMove(ev) {
  const rect = el.analyzeBoard.getBoundingClientRect();
  const cell = analysisPixelToCell(ev.clientX - rect.left, ev.clientY - rect.top);
  state.analysis.hoverCell = cell;
  redrawAnalysis();
}

function onAnalyzeMouseLeave() {
  state.analysis.hoverCell = null;
  redrawAnalysis();
}

function onAnalyzeClick(ev) {
  const a = state.analysis;
  const rect = el.analyzeBoard.getBoundingClientRect();
  const cell = analysisPixelToCell(ev.clientX - rect.left, ev.clientY - rect.top);
  if (!cell) return;
  const [r, c] = cell;

  // 右键 / Shift+点击 => 点格分析
  if (ev.button === 2 || ev.shiftKey) {
    ev.preventDefault();
    analyzePoint(r, c);
    return;
  }

  // 点格分析模式：左键点格直接触发分析（不摆子）
  if (a.pointMode) {
    analyzePoint(r, c);
    return;
  }

  // 左键：摆子 / 删子
  ensureAnalysisBoard();
  const b = state.analysis.board;
  if (a.activeColor === EMPTY) {
    // 删子工具：清空格
    b.setGrid(r, c, EMPTY);
    a.editHistory.push({ op: "erase", color: EMPTY, r, c });
  } else {
    // 摆子工具：直接写子（不 play，避免劫/提子/history 污染）
    b.setGrid(r, c, a.activeColor);
    a.editHistory.push({ op: "place", color: a.activeColor, r, c });
  }
  // 落子/删子后使旧的点格分析结果失效
  if (state.analysis.selectedCell) {
    const [sr, sc] = state.analysis.selectedCell;
    if (sr === r && sc === c) {
      state.analysis.selectedCell = null;
      state.analysis.pointResult = null;
      renderAnalyzeResult(null);
    }
  }
  redrawAnalysis();
}

// ---------- 点格分析 ----------
let _analyzeSeq = 0;
async function analyzePoint(r, c) {
  const a = state.analysis;
  ensureAnalysisBoard();
  const b = a.board;
  const existing = b.get(r, c);
  if (existing !== EMPTY) {
    el.analyzeHint.textContent = "该格已有子，点格分析针对空点才有效（请先删掉该格子的子）。";
    return;
  }
  if (a.analyzing) return;
  a.analyzing = true;
  a.selectedCell = [r, c];
  a.pointResult = null;
  const coord = coordToText(r, c, a.size);
  el.analyzeResult.textContent = `正在分析 ${coord} …`;
  redrawAnalysis();

  const seq = ++_analyzeSeq;
  try {
    const moves = analysisBuildMoves();
    const res = await katagoAnalyzePoint(moves, a.size, [r, c], { maxVisits: 60 });
    if (seq !== _analyzeSeq) return;
    a.pointResult = res;
    el.analyzeResult.textContent = formatPointResult(res);
  } catch (e) {
    el.analyzeResult.textContent = "分析失败： " + (e && e.message ? e.message : String(e));
    a.pointResult = null;
  } finally {
    a.analyzing = false;
    if (seq === _analyzeSeq) redrawAnalysis();
  }
}

function formatPointResult(res) {
  if (!res || !res.point) return "";
  const p = res.point;
  const coord = p.coord;
  const lines = [];
  const side = p.side === "B" ? "黑" : "白";
  lines.push(`点格 ${coord} 下一手${side}方 优劣分析：`);
  if (p.inTopCandidates) {
    lines.push(`KataGo 推荐序位：第 ${p.order + 1} 位`);
  } else {
    lines.push(`KataGo 未列入 top 候选（试下法估算）`);
  }
  if (typeof p.winrate === "number") {
    lines.push(`${side}方下此点后黑方胜率 ${Math.round(p.winrate * 100)}%`);
  }
  if (typeof p.delta === "number") {
    const dp = Math.round(p.delta * 1000) / 10;
    lines.push(`胜率变化：${dp >= 0 ? "+" : ""}${dp}%（${dp >= 0 ? "对黑方" : "对白方"}更有利）`);
  }
  if (typeof p.scoreLead === "number") {
    lines.push(`目差：${p.scoreLead >= 0 ? "黑" : "白"} ${Math.abs(p.scoreLead).toFixed(1)} 目`);
  }
  if (typeof p.visits === "number") {
    lines.push(`搜索访问量：${p.visits}`);
  }
  return lines.join("\n");
}

function renderAnalyzeResult(res) {
  el.analyzeResult.textContent = res ? formatPointResult(res) : "";
}

// ---------- 设置 ----------
function loadCfgToUI() {
  $("cfg-coach-url").value = cfg.coachUrl;
  $("cfg-coach-key").value = cfg.coachKey;
  $("cfg-coach-model").value = cfg.coachModel;
  $("cfg-opp-url").value = cfg.oppUrl;
  $("cfg-opp-key").value = cfg.oppKey;
  $("cfg-opp-model").value = cfg.oppModel;
  $("cfg-kata-level").value = cfg.kataLevel || "top5";
}

function readCfgFromUI() {
  cfg.coachUrl = $("cfg-coach-url").value.trim();
  cfg.coachKey = $("cfg-coach-key").value.trim();
  cfg.coachModel = $("cfg-coach-model").value.trim();
  cfg.oppUrl = $("cfg-opp-url").value.trim();
  cfg.oppKey = $("cfg-opp-key").value.trim();
  cfg.oppModel = $("cfg-opp-model").value.trim();
  cfg.kataLevel = $("cfg-kata-level").value || "top5";
  saveCfg();
}

async function testCfg() {
  const url = $("cfg-coach-url").value.trim();
  const key = $("cfg-coach-key").value.trim();
  const model = $("cfg-coach-model").value.trim();
  $("cfg-test-result").textContent = "正在测试教练 AI…";
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: url, apiKey: key, model,
        messages: [{role:"user", content:"回复一个字：好"}],
        temperature: 0, stream: false,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error + (j.detail||""));
    $("cfg-test-result").textContent = `教练 AI 连接成功，模型回复："${j.text}"`;
  } catch (e) {
    $("cfg-test-result").textContent = "连接失败：" + e.message;
  }
}

// ---------- SGF 载入/保存事件 ----------
function setupEventListeners() {
  // 棋盘
  el.board.addEventListener("mousemove", onBoardMouseMove);
  el.board.addEventListener("mouseleave", onBoardMouseLeave);
  el.board.addEventListener("click", onBoardClick);
  el.board.addEventListener("contextmenu", (e) => e.preventDefault());

  // 尺寸切换
  document.querySelectorAll("#size-seg button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#size-seg button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.size = parseInt(b.dataset.size, 10);
      newGame();
    });
  });

  // 执色切换
  document.querySelectorAll("#color-seg button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#color-seg button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.humanColor = parseInt(b.dataset.color, 10);
      newGame();
    });
  });

  // 对手类型
  $("opponent-type").addEventListener("change", (e) => {
    state.opponentType = e.target.value;
    addHintMessage(state.opponentType === "katago" ? "对手使用 KataGo 引擎" : "对手使用内置 AI");
  });

  // 难度
  document.querySelectorAll("#level-seg button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#level-seg button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.aiLevel = b.dataset.level;
    });
  });

  // 显示开关
  $("opt-show-coords").addEventListener("change", e => { state.showCoords = e.target.checked; render(); });
  $("opt-show-territory").addEventListener("change", e => { state.showTerritory = e.target.checked; render(); });
  $("opt-auto-explain").addEventListener("change", e => { state.autoExplain = e.target.checked; });

  // 对局按钮
  $("btn-new").addEventListener("click", newGame);
  $("btn-pass").addEventListener("click", () => {
    if (!turnIsHuman()) { addHintMessage("现在轮到对方。"); return; }
    state.board.history.push({ color: state.humanColor, r: -1, c: -1, captured: [] });
    render(); checkGameEnd();
    doAiTurn();
  });
  $("btn-undo").addEventListener("click", () => {
    if (state.gameOver) return;
    // 悔两步：撤掉用户上一步 + AI 的上一步
    state.board.undo(); state.board.undo();
    state.lastMove = null;
    render();
  });
  $("btn-resign").addEventListener("click", () => {
    if (state.gameOver) return;
    state.gameOver = true;
    el.hint.textContent = `认输。${state.humanColor === BLACK ? "白方(AI)胜" : "黑方(AI)胜"}`;
  });
  $("btn-auto-play").addEventListener("click", toggleAutoPlay);

  // SGF
  $("btn-save-sgf").addEventListener("click", exportSgf);
  $("btn-load-sgf").addEventListener("click", () => $("sgf-file").click());
  $("sgf-file").addEventListener("change", (e) => { if (e.target.files[0]) importSgfFile(e.target.files[0]); });

  $("btn-export-sgf2").addEventListener("click", exportSgf);
  $("btn-import-sgf2").addEventListener("click", () => $("sgf-file2").click());
  $("sgf-file2").addEventListener("change", (e) => { if (e.target.files[0]) importSgfFile(e.target.files[0]); });
  $("btn-parse-sgf").addEventListener("click", () => parseSgfToBoard($("sgf-text").value));

  $("btn-rev-prev").addEventListener("click", () => reviewStep(-1));
  $("btn-rev-next").addEventListener("click", () => reviewStep(1));

  // 教练快捷按钮
  document.querySelectorAll("[data-coach]").forEach(b => {
    b.addEventListener("click", () => coachAsk(b.dataset.coach));
  });
  $("btn-coach-send").addEventListener("click", sendCoachText);
  $("coach-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendCoachText(); });

  // 死活题
  $("btn-prev-prob").addEventListener("click", () => nextProblem(-1));
  $("btn-next-prob").addEventListener("click", () => nextProblem(1));
  $("btn-prob-tip").addEventListener("click", () => {
    const p = PROBLEMS[state.currentProblem];
    const sz = p.size;
    $("prob-tip").textContent = p.tip + "\n（答案参考：" + p.answer.map(a => coordToText(a[0], a[1], sz)).join(" / ") + "）";
  });
  $("btn-prob-check").addEventListener("click", checkProblemAnswer);
  $("btn-prob-reset").addEventListener("click", resetProblem);

  // 设置
  $("btn-save-cfg").addEventListener("click", () => { readCfgFromUI(); addHintMessage("配置已保存到浏览器本地。"); });
  $("btn-test-cfg").addEventListener("click", testCfg);

  // 分析模式
  el.analyzeBoard.addEventListener("mousemove", onAnalyzeMouseMove);
  el.analyzeBoard.addEventListener("mouseleave", onAnalyzeMouseLeave);
  el.analyzeBoard.addEventListener("click", onAnalyzeClick);
  el.analyzeBoard.addEventListener("contextmenu", (e) => e.preventDefault());

  // 摆子工具切换（黑/白/删）
  document.querySelectorAll("#analyze-color-seg button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#analyze-color-seg button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      const t = b.dataset.analyze;
      state.analysis.activeColor = t === "black" ? BLACK : t === "white" ? WHITE : EMPTY;
      redrawAnalysis();
    });
  });

  $("btn-analyze-clear").addEventListener("click", analysisClear);
  $("btn-analyze-copy").addEventListener("click", analysisCopyMain);
  $("btn-analyze-export").addEventListener("click", analysisExportSgf);
  $("btn-analyze-point").addEventListener("click", () => {
    const a = state.analysis;
    a.pointMode = !a.pointMode;
    const btn = $("btn-analyze-point");
    btn.classList.toggle("active", a.pointMode);
    btn.setAttribute("aria-pressed", String(a.pointMode));
    el.analyzeHint.textContent = a.pointMode
      ? "点格分析模式：点击空点触发 KataGo 分析；再次点击按钮回到摆子。"
      : "点击格子摆子；右键（或 Shift+点击）某格触发 KataGo 点格分析。";
    redrawAnalysis();
  });
  $("btn-analyze-all").addEventListener("click", analysisAllMoves);
  $("btn-analyze-ask-point").addEventListener("click", analysisAskPoint);
  $("btn-analyze-explain").addEventListener("click", analysisExplain);
  $("btn-analyze-send").addEventListener("click", () => { const v = $("analyze-input"); analysisAsk(v.value); v.value = ""; });
  $("analyze-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { const v = $("analyze-input"); analysisAsk(v.value); v.value = ""; } });
  $("opt-analyze-show-coords").addEventListener("change", e => { state.analysis.showCoords = e.target.checked; redrawAnalysis(); });

  // 窗口缩放重绘
  window.addEventListener("resize", () => { render(); redrawAnalysis(); });
}

function sendCoachText() {
  const input = $("coach-input");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  addMessage("user", q);
  coachAskFree(q);
}

async function coachAskFree(q) {
  if (!cfg.coachKey) { addHintMessage("请先配置教练 AI Key。"); return; }
  if (_coachBusy) return;
  _coachBusy = true;
  try {
    const ev = state.board.evaluate();
    const explainer = new ExplainAI(cfg.coachUrl, cfg.coachKey, cfg.coachModel);
    const last = state.lastMove ? [state.lastMove[0], state.lastMove[1]] : null;
    const built = explainer.buildPrompt(state.board, currentTurn(), last, "position");

    const streamEl = $("coach-streaming");
    streamEl.hidden = false;
    streamEl.textContent = "";
    await askCoachStream({
      baseUrl: cfg.coachUrl, apiKey: cfg.coachKey, model: cfg.coachModel,
      system: built.system, user: built.user + "\n\n用户单独提问：\n" + q,
      temperature: 0.6,
      onToken: (t) => { streamEl.textContent += t; streamEl.scrollTop = streamEl.scrollHeight; },
    }).catch(e => addHintMessage("教练请求失败：" + e.message));

    streamEl.hidden = true;
    const txt = streamEl.textContent;
    streamEl.textContent = "";
    addMessage("assistant", txt);
  } finally {
    _coachBusy = false;
  }
}

// ---------- 初始化 ----------
function init() {
  loadCfgToUI();
  setupEventListeners();
  newGame();
  refreshProblemBoard();
  ensureAnalysisBoard();
}

init();


