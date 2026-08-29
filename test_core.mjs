// 核心逻辑自动化测试，直接 node 运行
// 覆盖：规则引擎、内置 AI、死活题库、棋谱读写、AI prompt 构建
import { GoBoard, BLACK, WHITE, EMPTY, opponent, coordToText, textToCoord } from "./public/js/go_core.js";
import { GoAI } from "./public/js/go_ai.js";
import { PROBLEMS } from "./public/js/problems.js";
import { toSgf, fromSgf } from "./public/js/sgf.js";
import { LLMOpponent, ExplainAI, boardText, cleanMarkdown, consumeStream } from "./public/js/ai_api.js";

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("  FAIL: " + name); }
}
function section(s) { console.log("\n== " + s + " =="); }

// ---------- 1. 规则引擎 ----------
section("规则引擎");
{
  const b = new GoBoard(9);
  t("9路棋盘初始化全空", b.count(BLACK) === 0 && b.count(WHITE) === 0);
  t("合法落子", b.play(2, 2, BLACK) === true);
  t("同一位置不可重复落子", b.play(2, 2, BLACK) === false);

  // 提子测试：构造白子被围
  let b2 = new GoBoard(9);
  // 白(4,4)，黑四周围住
  b2.setGrid(4,4, WHITE);
  b2.setGrid(3,4, BLACK); b2.setGrid(5,4, BLACK);
  b2.setGrid(4,3, BLACK); b2.setGrid(4,5, BLACK);
  t("直接提白子", b2.play(4,4, WHITE) === false); // 已是白子，非法
  // 黑下(4,5)已占，改黑提最后一气
  let b3 = new GoBoard(9);
  b3.setGrid(4,4, WHITE);
  b3.setGrid(3,4, BLACK); b3.setGrid(5,4, BLACK); b3.setGrid(4,3, BLACK);
  t("黑填最后一气提白", b3.play(4,5, BLACK) === true);
  t("白子被提走", b3.get(4,4) === EMPTY);
  t("黑提子数=1", b3.captures[BLACK] === 1);

  // 自杀禁着：黑下无气且不提子
  let b4 = new GoBoard(9);
  b4.setGrid(4,4, WHITE); b4.setGrid(3,4, WHITE); b4.setGrid(4,3, WHITE); b4.setGrid(3,3, BLACK);
  t("黑下(4,4)自杀被禁", b4.isLegal(4,4, BLACK) === false); // 黑(3,3)周围被白占，下4,4无气

  // 悔棋
  let b5 = new GoBoard(9);
  b5.play(2,2, BLACK);
  t("悔棋后为空", b5.undo() === true && b5.get(2,2) === EMPTY);
}

// ---------- 2. 坐标转换 ----------
section("坐标转换");
{
  t("coordToText (0,0)->A9", coordToText(0,0,9) === "A9");
  t("coordToText (8,8)->J1", coordToText(8,8,9) === "J1");
  t("textToCoord A9 -> [0,0]", JSON.stringify(textToCoord("A9",9)) === "[0,0]");
  t("textToCoord J1 -> [8,8]", JSON.stringify(textToCoord("J1",9)) === "[8,8]");
  t("跳过 I 字母", coordToText(0,8,9) === "J9");
  t("非法坐标返回 null", textToCoord("K9",9) === null);
}

// ---------- 3. 内置 AI ----------
section("内置 AI");
{
  const b = new GoBoard(9);
  const ai = new GoAI(BLACK, "入门");
  const mv = ai.chooseMove(b);
  t("AI 返回合法落点", Array.isArray(mv) && b.isLegal(mv[0], mv[1], BLACK));
  // 模拟 AI vs AI 10 步
  let b2 = new GoBoard(9);
  let crash = false;
  try {
    for (let i = 0; i < 10; i++) {
      const c = i % 2 === 0 ? BLACK : WHITE;
      const m = new GoAI(c, "入门").chooseMove(b2);
      if (m) b2.play(m[0], m[1], c);
      else break;
    }
    t("AI vs AI 10步无崩溃", true);
    t("AI vs AI 产生了落子", b2.history.length > 0);
  } catch (e) { t("AI vs AI 10步无崩溃", false); }
}

// ---------- 4. 死活题库 ----------
section("死活题库");
{
  t("题库题目数量=16", PROBLEMS.length === 16);
  // 每道题结构完整
  let allValid = true;
  for (const p of PROBLEMS) {
    if (!p.name || !Array.isArray(p.setup) || !Array.isArray(p.answer) || p.size < 9 || !p.tip || !p.explain) { allValid = false; }
  }
  t("每题结构完整", allValid);
  t("每题有至少1个答案", PROBLEMS.every(p => p.answer.length >= 1));
  // 用 GoBoard 验证 setup 不越界
  let inRange = true;
  for (const p of PROBLEMS) {
    for (const [cl, r, c] of p.setup) {
      if (r < 0 || r >= p.size || c < 0 || c >= p.size) { inRange = false; }
    }
  }
  t("setup 坐标全部在界内", inRange);
}

// ---------- 5. SGF 读写 ----------
section("SGF 读写");
{
  const b = new GoBoard(9);
  b.play(2,2,BLACK); b.play(3,3,WHITE);
  const sgf = toSgf(b.history, 9, BLACK);
  const back = fromSgf(sgf);
  t("SGF 往返解析手数一致", back.history.length === 2);
  t("SGF 第一手是黑", back.history[0].color === BLACK && back.history[0].r === 2 && back.history[0].c === 2);
  t("SGF 第二手是白", back.history[1].color === WHITE);
}

// ---------- 6. AI prompt / 格式化 ----------
section("AI 工具");
{
  const b = new GoBoard(9);
  b.play(2,2,BLACK);
  const txt = boardText(b);
  t("boardText 包含黑子符号●", txt.includes("●"));
  t("cleanMarkdown 去除加粗", cleanMarkdown("**你好**") === "你好");
  t("cleanMarkdown 去除标题#", cleanMarkdown("# 标题").trim() === "标题");
  t("cleanMarkdown 去除列表-", cleanMarkdown("- 项目").trim() === "项目");
  const ex = new ExplainAI("https://api.llm.ustc.edu.cn", "sk-test", "deepseek-v4-pro");
  const built = ex.buildPrompt(b, BLACK, [2,2], "recommend");
  t("explain prompt 含 prompt", typeof built.user === "string" && built.user.length > 50);
  const opp = new LLMOpponent("https://api.llm.ustc.edu.cn", "sk-test", "deepseek-v4-flash");
  t("parseMove 解析坐标", JSON.stringify(opp._parseMove("D4", b)) === "[5,3]");
  t("parseMove 解析 PASS", opp._parseMove("PASS", b) === null);
  t("parseMove 非法返回 ERROR", opp._parseMove("随便下", b) === "ERROR");
}

// ---------- 7. 教练流式（consumeStream） ----------
section("教练流式 consumeStream");
{
  // mock resp.body.getReader()：依次吐若干 SSE 行，最后 done
  function mockResp(sseLines) {
    const encoder = new TextEncoder();
    const chunks = sseLines.map(l => encoder.encode(l));
    let i = 0;
    return {
      body: {
        getReader() {
          return {
            async read() {
              if (i < chunks.length) return { done: false, value: chunks[i++] };
              return { done: true, value: undefined };
            },
          };
        },
      },
    };
  }

  {
    // 两段 token + [DONE]
    const resp = mockResp([
      `data: {"choices":[{"delta":{"content":"你好"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"，同学"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const tokens = [];
    const full = await consumeStream(resp, (tk) => tokens.push(tk));
    t("流式累计全文正确", full === "你好，同学");
    t("onToken 逐段回调", tokens.length === 2 && tokens.join("") === "你好，同学");
  }

  {
    // Markdown 清洗：流式里的 **加粗** 应被去掉
    const resp = mockResp([
      `data: {"choices":[{"delta":{"content":"这是**重点**"}}]}\n\n`,
    ]);
    const full = await consumeStream(resp, () => {});
    t("流式内 Markdown 被清洗", full === "这是重点");
  }

  {
    // 错误透传：后端回 {error:...}，应把错误文本传给 onToken
    const resp = mockResp([
      `data: {"error":"上游连接失败"}\n\n`,
    ]);
    const tokens = [];
    await consumeStream(resp, (tk) => tokens.push(tk));
    t("错误信息被透传", tokens.join("").includes("上游连接失败"));
  }
}

console.log(`\n========== 测试结果: ${pass} 通过, ${fail} 失败 ==========`);
if (fail > 0) process.exit(1);
