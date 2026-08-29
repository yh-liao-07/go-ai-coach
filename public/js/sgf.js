// 棋谱读写：
// 用 SGF 这种围棋通用格式，方便和其他软件互通。
// 只实现用到的部分：棋盘大小、对局信息、每手坐标。

import { coordToText } from "./go_core.js";

export function toSgf(history, size, humanColor = 1, komi = 6.5) {
  const lines = [];
  lines.push("(;GM[1]FF[4]CA[UTF-8]");
  lines.push(`SZ[${size}]KM[${komi}]`);
  const pb = humanColor === 1 ? "你" : "AI";
  const pw = humanColor === 2 ? "你" : "AI";
  lines.push(`PB[${pb}]PW[${pw}]`);
  const moves = [];
  for (const h of history) {
    const letter = h.color === 1 ? "B" : "W";
    if (h.r < 0) {
      moves.push(`${letter}[]`);  // pass
    } else {
      const colS = String.fromCharCode(97 + h.c);
      const rowS = String.fromCharCode(97 + h.r);
      moves.push(`${letter}[${colS}${rowS}]`);
    }
  }
  lines.push(";" + moves.join(";"));
  lines.push(")");
  return lines.join("\n");
}

export function fromSgf(text) {
  let size = 19;
  const sm = text.match(/SZ\[(\d+)\]/i);
  if (sm) size = parseInt(sm[1], 10);

  const history = [];
  const mm = /;\s*([BW])\s*\[([a-s]*)\]/gi;
  let m;
  while ((m = mm.exec(text)) !== null) {
    const color = m[1].toUpperCase() === "B" ? 1 : 2;
    const coord = m[2];
    if (!coord) {
      history.push({ color, r: -1, c: -1, captured: [] });
    } else {
      const c = coord.charCodeAt(0) - 97;
      const r = coord.charCodeAt(1) - 97;
      history.push({ color, r, c, captured: [] });
    }
  }
  return { size, history };
}

export function downloadSgf(content, filename) {
  const blob = new Blob([content], { type: "application/x-go-sgf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function readSgfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file, "utf-8");
  });
}

// 把 SGF 里的历史（含 pass 的 r=-1）重新在棋盘上回放，得到可显示的棋盘状态。
// 返回一个新 GoBoard。注意：这里直接落子（忽略非法），用于回放展示。
export function replayHistory(GoBoard, size, history) {
  const board = new GoBoard(size);
  for (const h of history) {
    if (h.r < 0) continue; // 跳过 pass
    // 用 play 保证规则正确（含提子），若非法则跳过
    board.play(h.r, h.c, h.color);
  }
  return board;
}
