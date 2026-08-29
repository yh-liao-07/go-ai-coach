// KataGo 引擎管理：spawn analysis 子进程，用 JSON 协议通信，把结果封装成 Promise。
// 只依赖 Node 内置 child_process / path / fs。

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const KATAGO_DIR = path.join(__dirname, "katago");
const DEFAULT_MODEL = path.join(KATAGO_DIR, "kata1-b6c96.txt.gz");
const DEFAULT_CONFIG = path.join(KATAGO_DIR, "custom.cfg");

// 难度 -> 搜索参数（visits 供 selectMove，pda 控制强度）
const LEVELS = {
  "入门": { pda: -2.5, visits: 15 },
  "进阶": { pda: 0, visits: 40 },
  "挑战": { pda: 0, visits: 100 },
};

class KataGoEngine {
  constructor(modelFile, configFile) {
    this.model = modelFile || DEFAULT_MODEL;
    this.config = configFile || DEFAULT_CONFIG;
    this.proc = null;
    this.pending = new Map(); // id -> resolve
    this.nextId = 1;
    this.buf = "";
  }

  // 启动子进程；返回 true 表示就绪
  start() {
    if (this.proc) return true;
    const exe = path.join(KATAGO_DIR, "katago.exe");
    if (!fs.existsSync(exe)) {
      throw new Error("未找到 katago.exe，请先下载引擎到 katago 目录");
    }
    if (!fs.existsSync(this.model)) {
      throw new Error("未找到模型文件: " + this.model);
    }
    this.proc = spawn(exe, ["analysis", "-model", this.model, "-config", this.config], { cwd: KATAGO_DIR });
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => this._onErr(d));
    this.proc.on("exit", (code) => {
      this.proc = null;
      this._rejectAll(new Error("KataGo 进程退出 (code=" + code + ")"));
    });
    this.proc.on("error", (e) => this._rejectAll(e));
    return true;
  }

  _onData(d) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      this._onLine(line.trim());
    }
  }

  _onLine(line) {
    let obj;
    try { obj = JSON.parse(line); } catch (e) { return; }
    if (obj.id && this.pending.has(obj.id)) {
      const cb = this.pending.get(obj.id);
      this.pending.delete(obj.id);
      if (obj.error) cb.reject(new Error(obj.error));
      else cb.resolve(obj);
    }
  }

  _onErr(d) {
    const s = d.toString("utf8");
    // 只在错误日志里包含关键行，避免刷屏
    if (/error|Error/i.test(s)) {
      console.error("[katago]", s.trim().slice(0, 300));
    }
  }

  _rejectAll(err) {
    for (const [, cb] of this.pending) cb.reject(err);
    this.pending.clear();
  }

  // 发一个查询，等结果
  query(q) {
    this.start();
    if (!this.proc) return Promise.reject(new Error("KataGo 未运行"));
    const id = "q" + (this.nextId++);
    q.id = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(q) + "\n", (err) => {
        if (err) { this.pending.delete(id); reject(err); }
      });
      // 兜底超时
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("KataGo 查询超时"));
        }
      }, 120000);
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (e) {}
      setTimeout(() => { try { this.proc.kill(); } catch (e) {} }, 3000);
    }
  }

  // ---- 高层封装 ----

  // 分析一个局面，返回 {rootInfo, moveInfos, ownership}
  async analyze(moves, size, opts = {}) {
    const maxVisits = opts.maxVisits || 120;
    const includeOwnership = !!opts.includeOwnership;
    const q = {
      moves,
      rules: "chinese",
      komi: 7.5,
      boardXSize: size,
      boardYSize: size,
      maxVisits,
      includeOwnership,
      analyzeTurns: [moves.length],
    };
    if (opts.pda !== undefined && opts.pda !== 0) {
      q.overrideSettings = { playoutDoublingAdvantage: opts.pda };
    }
    const res = await this.query(q);
    return res;
  }

  // 选一步棋（对手）。返回 {move, winrate, scoreLead} 或 "pass"。
  async selectMove(moves, size, level = "入门") {
    const cfg = LEVELS[level] || LEVELS["入门"];
    const q = {
      moves,
      rules: "chinese",
      komi: 7.5,
      boardXSize: size,
      boardYSize: size,
      maxVisits: cfg.visits,
      analyzeTurns: [moves.length],
    };
    // 通过 overrideSettings 控制强度
    if (cfg.pda) {
      q.overrideSettings = { playoutDoublingAdvantage: cfg.pda };
    }
    const res = await this.query(q);
    const info = res.moveInfos && res.moveInfos[0];
    if (!info) return "pass";
    const mv = info.move;
    if (!mv || mv === "pass") return "pass";
    // 去掉带 pass 的情况
    return {
      move: mv,
      winrate: info.winrate,
      scoreLead: info.scoreLead,
      visits: info.visits,
    };
  }
}

// 单例
let instance = null;
function getEngine() {
  if (!instance) {
    instance = new KataGoEngine();
  }
  return instance;
}

module.exports = { KataGoEngine, getEngine, LEVELS, KATAGO_DIR };
