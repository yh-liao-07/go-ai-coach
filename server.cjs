// 一个只依赖 Node 内置 http/https 的小后端。
// 它做两件事：
//   1) 托管 public/ 目录下的前端网页；
//   2) 把浏览器发来的 LLM 请求转发给 OpenAI 兼容接口（如 USTC 平台），
//      用 SSE 实时把 token 流式回传给前端，避免浏览器直接调大模型时的 CORS 和 Key 暴露问题。

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { getEngine } = require("./katago_engine.cjs");
const { MIME, chatUrl, resolveStaticPath, isValidBoardSize, isValidMoves, readBody } = require("./lib/server-helpers.cjs");

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, "public");

function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendJSON(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

// readBody 已抽到 lib/server-helpers.cjs（可单测）。

// chatUrl / MIME / resolveStaticPath / 参数校验 已抽到 lib/server-helpers.cjs（可单测）。

// 关键：调用外部大模型并把这个流继续往下游（浏览器）转发。
// 这里只转发「模型、消息、温度」等基础字段，不转任何 Key。
async function proxyChat(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJSON(res, 400, { error: "bad json" }); }

  const { baseUrl, apiKey, model, messages, temperature, stream } = body;
  if (!baseUrl || !apiKey || !messages || !model) {
    return sendJSON(res, 400, { error: "缺少 baseUrl / apiKey / model / messages" });
  }

  const url = chatUrl(baseUrl);
  const outPayload = {
    model,
    messages,
    temperature: temperature === undefined ? 0.5 : Number(temperature),
    stream: stream !== false,
  };

  const upstream = https.request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
        Accept: stream === false ? "application/json" : "text/event-stream",
      },
      timeout: 120000,
    },
    (upRes) => {
      const status = upRes.statusCode || 0;
      if (status >= 400) {
        // 上游报错时把原文读出来回怼给前端，方便看原因
        let errBody = "";
        upRes.on("data", (c) => (errBody += c));
        upRes.on("end", () => {
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "upstream " + status, detail: errBody.slice(0, 600), apiUrl: url }));
        });
        return;
      }

      if (stream === false) {
        // 非流式：聚合后一句回给前端
        let full = "";
        upRes.setEncoding("utf8");
        upRes.on("data", (c) => (full += c));
        upRes.on("end", () => {
          try {
            const obj = JSON.parse(full);
            const text = obj.choices?.[0]?.message?.content || "";
            sendJSON(res, 200, { text });
          } catch (e) {
            sendJSON(res, 500, { error: " parse upstream", detail: full.slice(0, 400) });
          }
        });
        return;
      }

      // 流式：透传 SSE。设置响应头后直接把上游的 data 行转给浏览器。
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();

      let buf = "";
      upRes.setEncoding("utf8");
      upRes.on("data", (chunk) => {
        buf += chunk;
        // 按行切，把完整的行发下去；可能跨块，所以保留尾巴
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          res.write(line + "\n");
        }
      });
      upRes.on("end", () => {
        if (buf) res.write(buf);
        res.end();
      });
      upRes.on("error", (e) => { try { res.write("data: " + JSON.stringify({ error: String(e.message) }) + "\n\n"); res.end(); } catch (_) {} });
    }
  );

  upstream.on("error", (e) => {
    try {
      res.writeHead(502, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write("data: " + JSON.stringify({ error: "无法连接上游： " + e.message + "，apiUrl=" + url }) + "\n\n");
      res.end();
    } catch (_) {}
  });
  upstream.end(JSON.stringify(outPayload));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(u.pathname);

  if (p === "/api/chat") {
    return proxyChat(req, res);
  }
  if (p === "/api/health") {
    // 只读探测：不启动引擎，避免副作用/竞态。
    // 仅静态检查 katago.exe 和模型文件是否存在，来报告引擎是否"就绪"。
    const katagoReady = (() => {
      try {
        return fs.existsSync(path.join(__dirname, "katago", "katago.exe")) &&
               fs.existsSync(path.join(__dirname, "katago", "kata1-b6c96.txt.gz"));
      } catch (e) { return false; }
    })();
    return sendJSON(res, 200, { ok: true, pid: process.pid, katago: katagoReady });
  }
  if (p === "/api/katago/analyze") {
    try {
      const body = JSON.parse(await readBody(req));
      const { moves, size, maxVisits, includeOwnership } = body;
      if (!isValidMoves(moves) || !isValidBoardSize(size)) {
        return sendJSON(res, 400, { error: "缺少或非法的 moves 或 size" });
      }
      const result = await getEngine().analyze(moves, size, { maxVisits, includeOwnership });
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: "KataGo 分析失败：" + e.message });
    }
  }
  if (p === "/api/katago/move") {
    try {
      const body = JSON.parse(await readBody(req));
      const { moves, size, level } = body;
      if (!isValidMoves(moves) || !isValidBoardSize(size)) {
        return sendJSON(res, 400, { error: "缺少或非法的 moves 或 size" });
      }
      const result = await getEngine().selectMove(moves, size, level || "入门");
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 500, { error: "KataGo 选点失败：" + e.message });
    }
  }

  // 静态文件服务（用 resolveStaticPath 防目录穿越）
  const abs = resolveStaticPath(PUBLIC_DIR, p);
  if (abs === null) {
    return sendJSON(res, 403, { error: "forbidden" });
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      return sendJSON(res, 404, { error: "not found: " + p });
    }
    const ext = path.extname(abs).toLowerCase();
    send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream" });
  });
});

server.on("close", () => {
  try { getEngine().stop(); } catch (e) {}
});
process.on("SIGINT", () => { try { getEngine().stop(); } catch (e) {} process.exit(); });

server.listen(PORT, () => {
  console.log(`围棋AI学习助手 已启动: http://127.0.0.1:${PORT}`);
  console.log("按 Ctrl+C 停止。");
});
