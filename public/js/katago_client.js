// 前端 KataGo 客户端，负责对接后端 /api/katago/*。
// 后端启动 KataGo analysis 子进程，前端只需发起 HTTP 请求。

import { coordToText } from "./go_core.js";

export async function katagoAnalyze(moves, size, opts = {}) {
  const resp = await fetch("/api/katago/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      moves,
      size,
      maxVisits: opts.maxVisits,
      includeOwnership: opts.includeOwnership,
    }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({ error: resp.status }));
    throw new Error(j.error || ("KataGo 请求失败 " + resp.status));
  }
  return resp.json();
}

export async function katagoMove(moves, size, level) {
  const resp = await fetch("/api/katago/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moves, size, level }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({ error: resp.status }));
    throw new Error(j.error || ("KataGo 请求失败 " + resp.status));
  }
  return resp.json();
}

// 把 KataGo 的坐标字符串 "F6" 转换成我们的 [r,c]
export function parseKatagoCoord(str, size) {
  if (!str || str === "pass") return null;
  str = str.trim();
  let colLetter = str[0].toUpperCase();
  // KataGo 使用 GTP 标准坐标（同我们，跳过 I）
  const letters = "ABCDEFGHJKLMNOPQRST";
  let c = letters.indexOf(colLetter);
  if (c < 0) {
    // 可能是 (x,y) 形式
    // (x,y) 中 x 是列，y 是行，从 0 开始
    const m = str.match(/\((\d+),\s*(\d+)\)/);
    if (m) {
      const x = parseInt(m[1], 10); // 列
      const y = parseInt(m[2], 10); // 行（从底部数起，-1?）
      // KataGo 的 (x,y) 里 x 是列，y 是 row from bottom = size - 1 - y
      const r = size - 1 - y;
      return [r, x];
    }
    return null;
  }
  const rowNum = parseInt(str.slice(1), 10);
  if (Number.isNaN(rowNum)) return null;
  const r = size - rowNum;
  return [r, c];
}

// 把 KataGo 的 ownership 数组（row-major, 从 A 顶到 T 底）转成 {black:Set, white:Set}
// 实测约定：正值(+)=黑方控制，负值(-)=白方控制
export function ownershipToTerritory(arr, size) {
  const black = new Set();
  const white = new Set();
  for (let i = 0; i < arr.length; i++) {
    const r = Math.floor(i / size);
    const c = i % size;
    const v = arr[i];
    if (v > 0.45) black.add(r + "," + c);
    else if (v < -0.45) white.add(r + "," + c);
  }
  return { black, white };
}

// ---------------- 点格分析（试下法） ----------------

// 规范化「目标格」为 GTP 坐标字符串：接受 [r,c] 或 "C3" 字符串。
function normalizeCoord(cell, size) {
  if (Array.isArray(cell)) {
    return coordToText(cell[0], cell[1], size);
  }
  return String(cell).trim().toUpperCase();
}

// 把 moveInfos 数组里某个 GTP 坐标对应的候选找出来。找不到返回 null。
function findMoveInfo(moveInfos, coord) {
  if (!Array.isArray(moveInfos)) return null;
  return moveInfos.find(m => m && m.move && String(m.move).trim().toUpperCase() === coord) || null;
}

// 点格分析：分析「在某格落一手」的优劣。
// 输入 moves/size 与 katagoAnalyze 相同，cell 为目标格 [r,c] 或 GTP 字符串如 "C3"。
// 可选 opts.side: "B"|"W"，默认按 moves.length 奇偶推算下一手方；其余透传给 katagoAnalyze。
//
// 返回结构：
// {
//   rootInfo, moveInfos,          // 首次 base analyze 的原始结果（含全部候选，供邻域查询）
//   point: {
//     coord,                      // GTP 坐标
//     cell: [r,c],                 // 格子索引
//     side,                        // 下一手方 "B"/"W"
//     inTopCandidates: boolean,    // 该点是否在 KataGo top 候选中
//     order,                       // 在候选中序位（0-based；-1 表示不在候选中）
//     winrate,                     // 该点落子后的黑方胜率（config reportAnalysisWinratesAs=BLACK）
//     scoreLead,
//     delta,                       // 落子后黑方胜率变化（relative to rootInfo.winrate）
//     mode,                        // "top-candidate" | "trial"（试下法）
//     visits,
//     pv,
//   }
// }
export async function katagoAnalyzePoint(moves, size, cell, opts = {}) {
  if (cell == null) throw new Error("katagoAnalyzePoint 需要目标格 cell");
  const coord = normalizeCoord(cell, size);
  // 试下法也要用（trial），base 和 trial 都保持不传 includeOwnership 以省算力
  const base = await katagoAnalyze(moves, size, {
    maxVisits: opts.maxVisits,
    includeOwnership: false,
  });

  const rootInfo = base.rootInfo || {};
  const moveInfos = base.moveInfos || [];
  const side = (opts.side === "B" || opts.side === "W")
    ? opts.side
    : (Array.isArray(moves) && moves.length % 2 === 0 ? "B" : "W");

  const coordCell = parseKatagoCoord(coord, size);

  // 1) 目标格是否已在 top 候选中
  const hit = findMoveInfo(moveInfos, coord);
  if (hit) {
    const order = typeof hit.order === "number" ? hit.order : -1;
    return {
      rootInfo, moveInfos,
      point: {
        coord, cell: coordCell, side,
        inTopCandidates: true,
        order,
        winrate: typeof hit.winrate === "number" ? hit.winrate : null,
        scoreLead: typeof hit.scoreLead === "number" ? hit.scoreLead : null,
        delta: typeof hit.winrate === "number" && typeof rootInfo.winrate === "number"
          ? hit.winrate - rootInfo.winrate : null,
        mode: "top-candidate",
        visits: hit.visits,
        pv: hit.pv || [],
      },
    };
  }

  // 2) 试下法：临时在 moves 后追加一手 [side, coord]，再 analyze 一次，用新的 rootInfo 对比。
  const trialMoves = (Array.isArray(moves) ? moves.slice() : []).concat([[side, coord]]);
  const trial = await katagoAnalyze(trialMoves, size, {
    maxVisits: opts.maxVisits,
    includeOwnership: false,
  });
  const trialRoot = trial.rootInfo || {};
  const delta = (typeof trialRoot.winrate === "number" && typeof rootInfo.winrate === "number")
    ? trialRoot.winrate - rootInfo.winrate : null;

  return {
    rootInfo, moveInfos,
    point: {
      coord, cell: coordCell, side,
      inTopCandidates: false,
      order: -1,
      winrate: typeof trialRoot.winrate === "number" ? trialRoot.winrate : null,
      scoreLead: typeof trialRoot.scoreLead === "number" ? trialRoot.scoreLead : null,
      delta,
      mode: "trial",
      visits: typeof trialRoot.visits === "number" ? trialRoot.visits : null,
      pv: [],
    },
  };
}
