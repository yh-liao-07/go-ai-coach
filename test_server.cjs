// 后端纯函数 + 集成测试（CommonJS，零依赖，node test_server.cjs 直接跑）。
// 覆盖：chatUrl 边界、静态路径穿越防护、参数校验、/api/health 只读 + 集成请求。
const { MIME, chatUrl, resolveStaticPath, isValidBoardSize, isValidMoves, readBody } = require("./lib/server-helpers.cjs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("  FAIL: " + name); }
}
function section(s) { console.log("\n== " + s + " =="); }

async function main() {
  // ---------- 1. chatUrl 边界 ----------
  section("chatUrl");
  {
    t("裸域名 -> /v1/chat/completions",
      chatUrl("https://api.llm.ustc.edu.cn") === "https://api.llm.ustc.edu.cn/v1/chat/completions");
    t("/v1 结尾 -> +/chat/completions",
      chatUrl("https://api.llm.ustc.edu.cn/v1") === "https://api.llm.ustc.edu.cn/v1/chat/completions");
    t("/v1/ 尾斜杠 -> 正确",
      chatUrl("https://api.llm.ustc.edu.cn/v1/") === "https://api.llm.ustc.edu.cn/v1/chat/completions");
    t("完整 /chat/completions -> 原样",
      chatUrl("https://api.llm.ustc.edu.cn/v1/chat/completions") === "https://api.llm.ustc.edu.cn/v1/chat/completions");
    t("带 query string 不污染路径",
      chatUrl("https://api.llm.ustc.edu.cn/v1?key=abc") === "https://api.llm.ustc.edu.cn/v1/chat/completions");
    t("带 fragment 不污染路径",
      chatUrl("https://api.llm.ustc.edu.cn/v1#top") === "https://api.llm.ustc.edu.cn/v1/chat/completions");
    t("空字符串 -> 空",
      chatUrl("") === "");
    t("非字符串(数字) -> 空",
      chatUrl(123) === "");
    t("纯空白 -> 空",
      chatUrl("   ") === "");
    t("http 协议也兼容",
      chatUrl("http://localhost:8000") === "http://localhost:8000/v1/chat/completions");
  }

  // ---------- 2. resolveStaticPath 路径穿越防护 ----------
  section("resolveStaticPath 路径穿越");
  {
    const pub = path.join("C:", "app", "public");
    const j = (...p) => path.join("C:", "app", "public", ...p);
    t("根路径 -> index.html",
      resolveStaticPath(pub, "/") === j("index.html"));
    t("普通文件",
      resolveStaticPath(pub, "/js/app.js") === j("js", "app.js"));
    t("嵌套文件",
      resolveStaticPath(pub, "/css/style.css") === j("css", "style.css"));
    t("单层 ../ 穿越被拒",
      resolveStaticPath(pub, "/../server.cjs") === null);
    t("多层 ../../ 穿越 -> null",
      resolveStaticPath(pub, "/../../etc/passwd") === null);
    t("绝对路径注入(含盘符) -> null",
      resolveStaticPath(pub, "/C:/Windows/win.ini") === null);
    t("public2 前缀绕过 -> null（关键回归）",
      resolveStaticPath(pub, "/../public2/secret.txt") === null);
    t("非字符串 -> null",
      resolveStaticPath(pub, 123) === null);
    t("不以 / 开头 -> null",
      resolveStaticPath(pub, "js/app.js") === null);
  }

  // ---------- 3. KataGo 参数校验 ----------
  section("参数校验");
  {
    t("valid size 9", isValidBoardSize(9) === true);
    t("valid size 19", isValidBoardSize(19) === true);
    t("size 0 非法", isValidBoardSize(0) === false);
    t("size 4 非法（<5）", isValidBoardSize(4) === false);
    t("size 20 非法（>19）", isValidBoardSize(20) === false);
    t("size 非整数非法", isValidBoardSize(9.5) === false);
    t("size 字符串非法", isValidBoardSize("9") === false);
    t("valid moves 空数组", isValidMoves([]) === true);
    t("valid moves B/W", isValidMoves([["B","C3"],["W","D4"]]) === true);
    t("valid moves 小写 b/w", isValidMoves([["b","c3"]]) === true);
    t("valid moves pass 字符串", isValidMoves(["pass", ["B","C3"]]) === true);
    t("valid moves 元素含 resign", isValidMoves([["W","resign"]]) === true);
    t("moves 非数组非法", isValidMoves("x") === false);
    t("moves 元素非数组非法", isValidMoves([[0,0]]) === false);
    t("moves 元素长度错非法", isValidMoves([["B"]]) === false);
    t("moves 颜色非法", isValidMoves([["X","C3"]]) === false);
    t("moves 坐标非字符串非法", isValidMoves([["B",3]]) === false);
  }

  // ---------- 4. readBody 大小上限 ----------
  section("readBody");
  {
    // 构造一个会触发 data/end 事件的 mock req
    function mockReq(chunks, { destroy } = {}) {
      const handlers = {};
      let destroyed = false;
      const req = {
        on(ev, cb) { handlers[ev] = cb; },
        destroy() { destroyed = true; if (destroy) destroy(); },
        _destroyed: () => destroyed,
        _emit(ev, arg) { if (handlers[ev]) handlers[ev](arg); },
      };
      // 异步触发 data 然后 end
      setImmediate(() => {
        for (const c of chunks) { handlers.data && handlers.data(c); if (destroyed) return; }
        if (!destroyed) handlers.end && handlers.end();
      });
      return req;
    }

    // 正常 body
    const okReq = mockReq([Buffer.from("hello")]);
    const okBody = await readBody(okReq);
    t("正常 body 正确读取", okBody === "hello");

    // 超限 body：limit=5，发两个 3 字节 chunk，第二个触发超限
    let destroyed = false;
    const bigReq = mockReq([Buffer.from("abc"), Buffer.from("def")], { destroy: () => { destroyed = true; } });
    try {
      await readBody(bigReq, 5);
      t("超限 body 应 reject", false);
    } catch (e) {
      t("超限 body 触发 reject", e.message === "body too large");
    }
  }

  // ---------- 5. 集成测试：起服务器，测 /api/health 与路径穿越 ----------
  section("集成测试（真实 HTTP）");
  {
    const PORT = 9887;
    const serverPath = path.join(__dirname, "server.cjs");
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: "ignore",
    });

    function req(method, pathname, body) {
      return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({
          host: "127.0.0.1", port: PORT, method, path: pathname,
          headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
        }, (res) => {
          let txt = "";
          res.on("data", (c) => txt += c);
          res.on("end", () => resolve({ status: res.statusCode, body: txt }));
        });
        r.on("error", () => resolve({ status: 0, body: "" }));
        if (data) r.write(data);
        r.end();
      });
    }

    try {
      await new Promise(r => setTimeout(r, 800));

      const h = await req("GET", "/api/health");
      t("health 返回 200", h.status === 200);
      let hj; try { hj = JSON.parse(h.body); } catch { hj = {}; }
      t("health 含 ok 和 katago 字段", hj.ok === true && typeof hj.katago === "boolean");

      const traversal = await req("GET", "/../server.cjs");
      t("路径穿越请求被拒（403/404）", traversal.status === 403 || traversal.status === 404);

      const absolute = await req("GET", "/C:/Windows/win.ini");
      t("绝对路径注入被拒（403）", absolute.status === 403);

      const missing = await req("POST", "/api/katago/analyze", { moves: null, size: null });
      t("analyze 缺参返回 400", missing.status === 400);

      const badSize = await req("POST", "/api/katago/move", { moves: [["B","C3"]], size: 99 });
      t("move size 非法返回 400", badSize.status === 400);

      const index = await req("GET", "/");
      t("首页可访问返回 200", index.status === 200);
    } finally {
      try { child.kill(); } catch (e) {}
    }
  }

  console.log(`\n========== 后端测试结果: ${pass} 通过, ${fail} 失败 ==========`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
