// 内置 AI 对手：
// 入门级机器人，够陪新手练手。
// 评分维度：吃子、逃命、占地、打吃、连接、形状

import { GoBoard, BLACK, WHITE, EMPTY, opponent } from "./go_core.js";

export class GoAI {
  constructor(color, level = "入门") {
    this.color = color;
    this.level = level;
  }

  chooseMove(board) {
    const size = board.size;
    const legal = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (board.isLegal(r, c, this.color)) legal.push([r, c]);
      }
    }
    if (!legal.length) return null;

    const moveCount = board.history.length;
    const scored = [];
    for (const [r, c] of legal) {
      const s = this._score(board, r, c, moveCount);
      scored.push({ s, r, c });
    }

    scored.sort((a, b) => b.s - a.s);
    const pool = this.level === "入门" ? scored.slice(0, Math.max(5, Math.floor(scored.length / 3)))
      : this.level === "进阶" ? scored.slice(0, Math.max(3, Math.floor(scored.length / 5)))
      : scored.slice(0, Math.max(2, Math.floor(scored.length / 8)));

    const top = pool[0].s;
    const best = pool.filter(m => m.s >= top - 3);
    const pick = best[Math.floor(Math.random() * best.length)];
    return [pick.r, pick.c];
  }

  _score(board, r, c, moveCount) {
    const color = this.color;
    const opp = opponent(color);
    const size = board.size;
    let score = 0;

    const test = board.copy();
    const beforeOpp = board.count(opp);
    test.play(r, c, color);
    const afterOpp = test.count(opp);
    const captured = beforeOpp - afterOpp;

    // 吃子大赚
    score += captured * 30;

    // 自己的气
    const { liberties: libs } = test.group(r, c);
    const myLibs = libs.size;
    if (myLibs === 1 && captured === 0) score -= 40;
    score += Math.min(myLibs, 8) * 2;

    // 打吃对方
    for (const [nr, nc] of test.neighbors(r, c)) {
      if (test.get(nr, nc) === opp) {
        const { liberties: ol } = test.group(nr, nc);
        if (ol.size === 1) score += 15;
        else if (ol.size === 2) score += 5;
      }
    }

    // 救自己危棋
    for (const [nr, nc] of board.neighbors(r, c)) {
      if (board.get(nr, nc) === color) {
        const { liberties: oldLibs } = board.group(nr, nc);
        if (oldLibs.size <= 2) score += (3 - oldLibs.size) * 8;
      }
    }

    // 开局布局
    if (moveCount < 10) {
      const edge = Math.min(r, c, size - 1 - r, size - 1 - c);
      if (edge === 2 || edge === 3) score += 6;
      if (edge === 0) score -= 10;
      if (edge === 1) score -= 4;
      if (size === 9 && [[2,2],[2,6],[6,2],[6,6],[4,4]].some(([a,b]) => a===r && b===c)) score += 8;
      if (size === 13 && [[3,3],[3,9],[6,6],[9,3],[9,9]].some(([a,b]) => a===r && b===c)) score += 8;
      if (size === 19) {
        const stars = [[3,3],[3,9],[3,15],[9,3],[9,9],[9,15],[15,3],[15,9],[15,15]];
        if (stars.some(([a,b]) => a===r && b===c)) score += 8;
      }
    }

    // 别贴对方子
    for (const [nr, nc] of board.neighbors(r, c)) {
      if (board.get(nr, nc) === opp) score -= 1.5;
    }

    // 别填自己眼
    if (this._isOwnEye(board, r, c, color)) score -= 60;

    // 中腹略偏好
    score -= Math.abs(r - (size - 1) / 2.0) * 0.1;
    score -= Math.abs(c - (size - 1) / 2.0) * 0.1;

    // 进阶/挑战级别额外评估
    if (this.level === "进阶" || this.level === "挑战") {
      const before = board.evaluate();
      const after = test.evaluate();
      if (color === BLACK) score += (after.black - before.black) * 0.5;
      else score += (after.white - before.white) * 0.5;
    }

    if (this.level === "挑战") {
      for (const [nr, nc] of board.neighbors(r, c)) {
        if (board.get(nr, nc) === color) score += 1.5;
      }
    }

    return Math.round(score * 100) / 100;
  }

  _isOwnEye(board, r, c, color) {
    for (const [nr, nc] of board.neighbors(r, c)) {
      if (board.get(nr, nc) !== color) return false;
    }
    const diag = [[r - 1, c - 1], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c + 1]];
    const on = diag.filter(([nr, nc]) => board.inBoard(nr, nc)).map(([nr, nc]) => board.get(nr, nc));
    const own = on.reduce((n, v) => n + (v === color ? 1 : 0), 0);
    return own >= on.length - 1;
  }
}
