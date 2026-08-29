// 从 app.js 抽离出来的纯逻辑，不碰 DOM 和全局 state，方便单独测试。
// 算法与 app.js 保持一致，app.js 直接引用这里的函数。

import { BLACK, WHITE, opponent, coordToText } from "./go_core.js";

// 黑先常数
export const BLACK_MOVE_FIRST = BLACK;

// 当前该谁下（按 history 长度奇偶：偶数=黑先）
export function currentTurnCore(historyLength) {
  return historyLength % 2 === 0 ? BLACK : WHITE;
}

// 是否轮到"人类"走。humanColor 是人类执色，黑先交替。
export function turnIsHumanCore(historyLength, humanColor) {
  return currentTurnCore(historyLength) === humanColor;
}

// 星位（天元/星）坐标，按棋盘大小返回 [[r,c],...]
export function starPoints(n) {
  if (n === 9) return [[2,2],[2,6],[6,2],[6,6],[4,4]];
  if (n === 13) return [[3,3],[3,9],[9,9],[9,3],[6,6]];
  return [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
}

// 把 canvas 内的像素坐标转成格子索引 [r,c]，越界返回 null。
// 主棋盘用：margin 里含坐标标注占的位置。
export function pixelToCellCore(px, py, width, n, showCoords) {
  const coordPad = showCoords ? width * 0.045 : 0;
  const margin = width * 0.05 + coordPad;
  const cell = (width - margin * 2) / (n - 1);
  const c = Math.round((px - margin) / cell);
  const r = Math.round((py - margin) / cell);
  if (r < 0 || r >= n || c < 0 || c >= n) return null;
  return [r, c];
}

// 死活题棋盘用：不画坐标，margin 固定 8%。
export function probPixelToCellCore(px, py, width, n) {
  const margin = width * 0.08;
  const cell = (width - margin * 2) / (n - 1);
  const c = Math.round((px - margin) / cell);
  const r = Math.round((py - margin) / cell);
  if (r < 0 || r >= n || c < 0 || c >= n) return null;
  return [r, c];
}

// history（含 pass，r<0）→ KataGo moves 数组 [["B","C3"],...]，过滤掉 pass。
export function buildMoveListCore(history, size) {
  return history
    .filter(h => h.r >= 0)
    .map(h => [h.color === BLACK ? "B" : "W", coordToText(h.r, h.c, size)]);
}

// 死活题答案判定：用户落的子集合与答案集合是否完全一致（顺序无关）。
// userMoves: [{r,c}...]；answer: [[r,c]...]
export function checkProblemAnswerCore(userMoves, answer) {
  const userSet = new Set(userMoves.map(m => `${m.r},${m.c}`));
  const ansSet = new Set(answer.map(a => `${a[0]},${a[1]}`));
  if (userSet.size !== ansSet.size) return false;
  for (const a of ansSet) if (!userSet.has(a)) return false;
  return true;
}

// 终局判定：连续两次 pass（r<0）即结束。
// history 元素形如 {color, r, c, captured}，pass 时 r<0。
export function isTwoPassGameEnd(history) {
  const h = history;
  if (h.length < 2) return false;
  return h[h.length - 1].r < 0 && h[h.length - 2].r < 0;
}
