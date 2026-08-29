// 围棋规则核心：
// 只管棋盘状态和规则判定，不碰界面，方便单独测试。
// 黑=1 白=2 空=0

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export function opponent(color) {
  return color === BLACK ? WHITE : BLACK;
}

export class GoBoard {
  constructor(size = 9) {
    this.size = size;
    // 棋盘用一维数组存，下标 = row * size + col
    this.grid = new Array(size * size).fill(EMPTY);
    // 简单劫：记录上一手提完子后的局面，禁止下一手把局面还原回去
    this.koPoint = null;
    // 历史落子，方便悔棋和棋谱回放
    this.history = [];        // 每项: {color, r, c, captured: []}
    this.captures = { 1: 0, 2: 0 };
  }

  index(r, c) { return r * this.size + c; }
  inBoard(r, c) { return r >= 0 && r < this.size && c >= 0 && c < this.size; }
  get(r, c) {
    if (!this.inBoard(r, c)) return EMPTY;
    return this.grid[this.index(r, c)];
  }
  setGrid(r, c, v) { this.grid[this.index(r, c)] = v; }

  copy() {
    const nb = new GoBoard(this.size);
    nb.grid = this.grid.slice();
    nb.koPoint = this.koPoint;
    nb.history = this.history.map(h => ({ ...h, captured: h.captured ? [...h.captured] : [] }));
    nb.captures = { ...this.captures };
    return nb;
  }

  count(color) {
    return this.grid.reduce((n, v) => n + (v === color ? 1 : 0), 0);
  }

  // ---------- 棋串与气 ----------
  group(r, c) {
    const color = this.get(r, c);
    if (color === EMPTY) return { stones: new Set(), liberties: new Set() };
    const stones = new Set();
    const liberties = new Set();
    const stack = [[r, c]];
    const seen = new Set();
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const key = cr + "," + cc;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.get(cr, cc) === color) {
        stones.add(key);
        for (const [nr, nc] of this.neighbors(cr, cc)) {
          const nv = this.get(nr, nc);
          if (nv === EMPTY) liberties.add(nr + "," + nc);
          else if (nv === color && !seen.has(nr + "," + nc)) stack.push([nr, nc]);
        }
      }
    }
    return { stones, liberties };
  }

  *neighbors(r, c) {
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      if (this.inBoard(nr, nc)) yield [nr, nc];
    }
  }

  libertyCount(r, c) {
    const { liberties } = this.group(r, c);
    return liberties.size;
  }

  captureAround(r, c, color) {
    const captured = new Set();
    for (const [nr, nc] of this.neighbors(r, c)) {
      if (this.get(nr, nc) === opponent(color)) {
        const { stones, liberties } = this.group(nr, nc);
        if (liberties.size === 0 && stones.size > 0) {
          for (const key of stones) {
            const [sr, sc] = key.split(",").map(Number);
            this.setGrid(sr, sc, EMPTY);
            captured.add(key);
          }
        }
      }
    }
    return captured;
  }

  isLegal(r, c, color) {
    if (!this.inBoard(r, c) || this.get(r, c) !== EMPTY) return false;
    if (this.koPoint === r + "," + c) return false;
    this.setGrid(r, c, color);
    const captured = this.captureAround(r, c, color);
    const { liberties } = this.group(r, c);
    const legal = liberties.size > 0;
    this.setGrid(r, c, EMPTY);
    for (const key of captured) {
      const [cr, cc] = key.split(",").map(Number);
      this.setGrid(cr, cc, opponent(color));
    }
    return legal;
  }

  play(r, c, color) {
    if (!this.isLegal(r, c, color)) return false;
    this.setGrid(r, c, color);
    const captured = this.captureAround(r, c, color);
    const capturedList = [...captured].map(k => {
      const [cr, cc] = k.split(",").map(Number);
      return [cr, cc];
    });
    if (capturedList.length === 1 && this.libertyCount(r, c) === 1) {
      this.koPoint = capturedList[0][0] + "," + capturedList[0][1];
    } else {
      this.koPoint = null;
    }
    this.captures[color] += capturedList.length;
    this.history.push({ color, r, c, captured: capturedList });
    return true;
  }

  undo() {
    if (!this.history.length) return false;
    const last = this.history.pop();
    this.setGrid(last.r, last.c, EMPTY);
    const opp = opponent(last.color);
    for (const [cr, cc] of last.captured) {
      this.setGrid(cr, cc, opp);
    }
    this.captures[last.color] -= last.captured.length;
    this.koPoint = null;
    return true;
  }

  // ---------- 死活判断（初学者向，启发式） ----------
  eyesOfGroup(stones) {
    const eyes = [];
    const emptyAdj = new Set();
    const stoneArr = [...stones].map(k => k.split(",").map(Number));
    for (const [sr, sc] of stoneArr) {
      for (const [nr, nc] of this.neighbors(sr, sc)) {
        if (this.get(nr, nc) === EMPTY) emptyAdj.add(nr + "," + nc);
      }
    }
    for (const key of emptyAdj) {
      const [er, ec] = key.split(",").map(Number);
      let real = true;
      for (const [nr, nc] of this.neighbors(er, ec)) {
        if (!stones.has(nr + "," + nc)) { real = false; break; }
      }
      if (!real) continue;
      const diag = [[er - 1, ec - 1], [er - 1, ec + 1], [er + 1, ec - 1], [er + 1, ec + 1]];
      const onBoard = diag.filter(([r, c]) => this.inBoard(r, c)).map(([r, c]) => stones.has(r + "," + c) ? 1 : 0);
      const own = onBoard.reduce((a, b) => a + b, 0);
      if (own >= onBoard.length - 1) eyes.push(key);
    }
    return eyes;
  }

  lifeStatus(r, c) {
    const { stones, liberties } = this.group(r, c);
    if (liberties.size === 0 && stones.size === 0) return "空";
    const eyes = this.eyesOfGroup(stones);
    if (eyes.length >= 2) return "活";
    if (liberties.size === 0) return "死";
    if (eyes.length === 0 && liberties.size <= 2) {
      let surroundOpp = 0;
      const opp = opponent(this.get(r, c));
      for (const key of stones) {
        const [sr, sc] = key.split(",").map(Number);
        for (const [nr, nc] of this.neighbors(sr, sc)) {
          if (this.get(nr, nc) === opp) surroundOpp++;
        }
      }
      if (surroundOpp >= liberties.size) return "危";
    }
    return "待定";
  }

  // ---------- 形势评估 ----------
  evaluate() {
    let blackScore = this.captures[1];
    let whiteScore = this.captures[2];
    const visited = new Set();
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        const key = r + "," + c;
        if (visited.has(key) || this.get(r, c) !== EMPTY) continue;
        const region = new Set();
        const borders = new Set();
        const stack = [[r, c]];
        while (stack.length) {
          const [cr, cc] = stack.pop();
          const ck = cr + "," + cc;
          if (region.has(ck)) continue;
          region.add(ck);
          visited.add(ck);
          for (const [nr, nc] of this.neighbors(cr, cc)) {
            const v = this.get(nr, nc);
            if (v === EMPTY) stack.push([nr, nc]);
            else borders.add(v);
          }
        }
        if (borders.size === 1 && borders.has(1)) blackScore += region.size;
        else if (borders.size === 1 && borders.has(2)) whiteScore += region.size;
        else { blackScore += region.size / 2; whiteScore += region.size / 2; }
      }
    }
    blackScore += this.count(1);
    whiteScore += this.count(2);
    return { black: blackScore, white: whiteScore };
  }

  // ---------- 领地估算 ----------
  estimateTerritory() {
    const blackPts = new Set();
    const whitePts = new Set();
    const neutralPts = new Set();
    const visited = new Set();

    const board = this;
    function* neighbors8(r, c) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (board.inBoard(nr, nc)) yield [nr, nc];
        }
      }
    }

    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (visited.has(r + "," + c) || this.get(r, c) !== EMPTY) continue;
        const region = new Set();
        const borders = new Set();
        const stack = [[r, c]];
        while (stack.length) {
          const [cr, cc] = stack.pop();
          const ck = cr + "," + cc;
          if (region.has(ck)) continue;
          region.add(ck);
          visited.add(ck);
          for (const [nr, nc] of this.neighbors(cr, cc)) {
            const v = this.get(nr, nc);
            if (v === EMPTY) stack.push([nr, nc]);
            else borders.add(v);
          }
        }
        if (borders.size === 1 && borders.has(1)) { for (const k of region) blackPts.add(k); }
        else if (borders.size === 1 && borders.has(2)) { for (const k of region) whitePts.add(k); }
        else {
          let bw = 0, ww = 0;
          for (const key of region) {
            const [er, ec] = key.split(",").map(Number);
            for (const [nr, nc] of neighbors8(er, ec)) {
              const v = this.get(nr, nc);
              if (v === 1) bw++;
              else if (v === 2) ww++;
            }
          }
          if (bw > ww * 1.5) { for (const k of region) blackPts.add(k); }
          else if (ww > bw * 1.5) { for (const k of region) whitePts.add(k); }
          else { for (const k of region) neutralPts.add(k); }
        }
      }
    }
    return { black: blackPts, white: whitePts, neutral: neutralPts };
  }
}

const LETTERS = "ABCDEFGHJKLMNOPQRST";

export function coordToText(r, c, size) {
  const colLetter = LETTERS[c] || "?";
  const rowNumber = size - r;
  return `${colLetter}${rowNumber}`;
}

export function textToCoord(text, size) {
  text = String(text).trim().toUpperCase();
  if (text.length < 2) return null;
  const colLetter = text[0];
  const ci = LETTERS.indexOf(colLetter);
  if (ci < 0) return null;
  const rowNum = parseInt(text.slice(1), 10);
  if (Number.isNaN(rowNum)) return null;
  const r = size - rowNum;
  if (r < 0 || r >= size || ci < 0 || ci >= size) return null;
  return [r, ci];
}
