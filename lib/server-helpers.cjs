// 后端纯函数抽离（CommonJS），无副作用，便于单测。
// 这些函数原本内联在 server.cjs 里，抽出来既修 bug 又方便测试。

const path = require("path");

// 常见静态文件 MIME 映射
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

// 把 OpenAI 兼容的 base_url 规范成完整的 chat/completions 地址。
// 兼容：尾斜杠、/v1、/v1/、完整地址、query string、fragment、空/非字符串。
function chatUrl(base) {
  let b = typeof base === "string" ? base.trim() : "";
  if (b === "") return "";
  // 去掉 query string 和 fragment，避免污染路径
  b = b.split(/[?#]/)[0];
  b = b.replace(/\/+$/, "");
  if (b.endsWith("/chat/completions")) return b;
  if (b.endsWith("/v1")) return b + "/chat/completions";
  return b + "/v1/chat/completions";
}

// 解析一个请求路径到本地静态文件绝对路径。
// 返回 null 表示越出 public 目录（应拒绝）。
// 注意：requestPath 应以 "/" 开头；"/" 会被视为 index.html。
// 修复了原先 startsWith(publicDir) 的前缀穿越漏洞（public-evil 之类目录名绕过）。
function resolveStaticPath(publicDir, requestPath) {
  if (typeof requestPath !== "string" || !requestPath.startsWith("/")) {
    return null;
  }
  // 拒绝含 Windows 盘符（:）或 NUL 的可疑路径片段，防绝对路径注入
  if (requestPath.includes(":") || requestPath.includes("\0")) {
    return null;
  }
  const target = requestPath === "/" ? "/index.html" : requestPath;
  let normalized;
  try {
    normalized = path.normalize(path.join(publicDir, target));
  } catch (_e) {
    return null;
  }
  const normalizedPublic = path.normalize(publicDir);
  if (normalized === normalizedPublic) {
    // 解析到 public 根目录本身：等价于 index.html
    return path.join(normalizedPublic, "index.html");
  }
  if (normalized.startsWith(normalizedPublic + path.sep)) {
    return normalized;
  }
  return null; // 路径穿越
}

// KataGo 分析接口参数校验
function isValidBoardSize(n) {
  return Number.isInteger(n) && n >= 5 && n <= 19;
}

// moves：KataGo analysis 的落子序列，每个元素是 [颜色, 坐标] 字符串对，
// 由前端 buildMoveList() 生成：[["B","C3"],["W","D4"],...]
// 颜色 B/W，坐标是 KataGo 坐标（如 C3）或 "pass"/"resign"。
function isValidMoves(moves) {
  if (!Array.isArray(moves)) return false;
  for (const m of moves) {
    if (m === "pass" || m === "resign") continue;
    if (!Array.isArray(m) || m.length !== 2) return false;
    const [color, coord] = m;
    if (typeof color !== "string" || typeof coord !== "string") return false;
    if (color !== "B" && color !== "W" && color !== "b" && color !== "w") return false;
    if (coord === "" || coord === "pass" || coord === "resign") continue;
  }
  return true;
}

// 读请求体，配一个上限防止被人塞超大 body。
// req 需提供 on(event, cb) 和 destroy()（Node http.IncomingMessage）。
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

module.exports = {
  MIME,
  chatUrl,
  resolveStaticPath,
  isValidBoardSize,
  isValidMoves,
  readBody,
};
