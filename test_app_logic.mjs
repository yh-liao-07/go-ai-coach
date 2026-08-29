// app.js 抽离出来的纯逻辑测试（ESM，node test_app_logic.mjs 直接跑）。
import {
  currentTurnCore, turnIsHumanCore, starPoints,
  pixelToCellCore, probPixelToCellCore,
  buildMoveListCore, checkProblemAnswerCore, isTwoPassGameEnd,
} from "./public/js/app_logic.js";
import { BLACK, WHITE } from "./public/js/go_core.js";

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("  FAIL: " + name); }
}
function section(s) { console.log("\n== " + s + " =="); }

// ---------- 1. 回合判定 ----------
section("回合判定");
{
  t("0 步 -> 黑先", currentTurnCore(0) === BLACK);
  t("1 步 -> 白", currentTurnCore(1) === WHITE);
  t("2 步 -> 黑", currentTurnCore(2) === BLACK);
  t("人类执黑，0 步轮到人类", turnIsHumanCore(0, BLACK) === true);
  t("人类执黑，1 步不轮到人类", turnIsHumanCore(1, BLACK) === false);
  t("人类执白，0 步不轮到人类(黑先)", turnIsHumanCore(0, WHITE) === false);
  t("人类执白，1 步轮到人类", turnIsHumanCore(1, WHITE) === true);
}

// ---------- 2. 星位 ----------
section("星位");
{
  t("9 路 5 个星位含天元", starPoints(9).length === 5 && starPoints(9).some(p => p[0]===4 && p[1]===4));
  t("13 路 5 个星位", starPoints(13).length === 5);
  t("19 路 9 个星位", starPoints(19).length === 9);
}

// ---------- 3. 像素→格子 ----------
section("像素→格子（主棋盘）");
{
  // width=600, n=9, showCoords=true
  const w = 600, n = 9;
  const coordPad = w * 0.045;         // 27
  const margin = w * 0.05 + coordPad; // 30 + 27 = 57
  const cell = (w - margin * 2) / (n - 1); // (600-114)/8 = 60.75
  // 左上角 (0,0) 格中心 = (margin, margin)
  t("左上角格映射为 [0,0]", JSON.stringify(pixelToCellCore(margin, margin, w, n, true)) === "[0,0]");
  // 右下角 (8,8) 格中心 = margin + 8*cell
  t("右下角格映射为 [8,8]", JSON.stringify(pixelToCellCore(margin + 8*cell, margin + 8*cell, w, n, true)) === "[8,8]");
  // 越界（负坐标）
  t("负坐标越界返回 null", pixelToCellCore(-10, -10, w, n, true) === null);
  // 越界（超出右边界）
  t("超出右边界返回 null", pixelToCellCore(w + 100, margin, w, n, true) === null);
  // 中心点（天元 4,4）
  t("棋盘中心映射为 [4,4]", JSON.stringify(pixelToCellCore(margin + 4*cell, margin + 4*cell, w, n, true)) === "[4,4]");
}

section("像素→格子（题库）");
{
  const w = 360, n = 9;
  const margin = w * 0.08;            // 28.8
  const cell = (w - margin*2)/(n-1);  // (360-57.6)/8 = 37.8
  t("题库左上角 [0,0]", JSON.stringify(probPixelToCellCore(margin, margin, w, n)) === "[0,0]");
  t("题库越界 null", probPixelToCellCore(-5, -5, w, n) === null);
}

// ---------- 4. buildMoveList ----------
section("buildMoveList");
{
  const size = 9;
  const hist = [
    { color: BLACK, r: 2, c: 2, captured: [] },
    { color: WHITE, r: 3, c: 3, captured: [] },
    { color: BLACK, r: -1, c: -1, captured: [] }, // pass，应被过滤
  ];
  const ml = buildMoveListCore(hist, size);
  t("pass 被过滤，只剩 2 手", ml.length === 2);
  t("第一手格式 ['B','C7']（9路坐标）", JSON.stringify(ml[0]) === '["B","C7"]');
  t("颜色正确", ml[1][0] === "W");
}

// ---------- 5. 死活题判定 ----------
section("死活题判定");
{
  const ans = [[0,0],[1,1]];
  t("答案顺序无关（正序）", checkProblemAnswerCore([{r:0,c:0},{r:1,c:1}], ans) === true);
  t("答案顺序无关（反序）", checkProblemAnswerCore([{r:1,c:1},{r:0,c:0}], ans) === true);
  t("少一个 -> false", checkProblemAnswerCore([{r:0,c:0}], ans) === false);
  t("多一个 -> false", checkProblemAnswerCore([{r:0,c:0},{r:1,c:1},{r:2,c:2}], ans) === false);
  t("全错 -> false", checkProblemAnswerCore([{r:5,c:5}], ans) === false);
  t("空答案对空题 -> true", checkProblemAnswerCore([], []) === true);
}

// ---------- 6. 终局判定 ----------
section("终局判定");
{
  const mk = (r) => ({ color: BLACK, r, c: r<0?-1:0, captured: [] });
  t("少于2手 false", isTwoPassGameEnd([mk(0)]) === false);
  t("两队普通落子 false", isTwoPassGameEnd([mk(0), mk(1)]) === false);
  t("连续两次 pass true", isTwoPassGameEnd([mk(0), mk(-1), mk(-1)]) === true);
  t("一次 pass 一次落子 false", isTwoPassGameEnd([mk(-1), mk(2)]) === false);
}

console.log(`\n========== app 逻辑测试结果: ${pass} 通过, ${fail} 失败 ==========`);
if (fail > 0) process.exit(1);
