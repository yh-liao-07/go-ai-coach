const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");

const results = [];
const re = /\{[\s\S]*?\n\s*\}/g;
let m;
while ((m = re.exec(text)) !== null) {
  const body = m[0];
  if (body.indexOf('"name"') < 0) continue;

  const get = (key) => {
    const re1 = new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"');
    const k1 = body.match(re1);
    if (k1) return k1[1];
    const re2 = new RegExp('"' + key + '"' + "\\s*:\\s*'([^']*)'");
    const k2 = body.match(re2);
    return k2 ? k2[1] : null;
  };
  const name = get("name");
  if (!name) continue;

  const size = parseInt((body.match(/["']size["']\s*:\s*(\d+)/) || [0, 9])[1], 10);
  const yourColor = get("your_color") || "B";
  const tip = get("tip") || "";
  const explain = get("explain") || "";

  const setup = [];
  const sre = /\(\s*["']([BW])["']\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  let sm;
  while ((sm = sre.exec(body)) !== null) {
    setup.push([sm[1], parseInt(sm[2], 10), parseInt(sm[3], 10)]);
  }

  const answers = [];
  const answerSeg = body.match(/["']answer["']\s*:\s*\[([^\]]*)\]/);
  if (answerSeg) {
    const are = /\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
    let am;
    while ((am = are.exec(answerSeg[1])) !== null) {
      answers.push([parseInt(am[1], 10), parseInt(am[2], 10)]);
    }
  }

  results.push({ name, size, setup, answer: answers, your_color: yourColor, tip, explain });
  console.log("parsed:", name, "| setup", setup.length, "| answer", JSON.stringify(answers));
}

const js = "// 死活题库（自动从 Python 版 problems.py 生成）\n" +
  "// 涵盖：做活、杀棋、提子、叫吃、连接、断点、征子、扑、倒扑、双活等基础概念\n\n" +
  "export const PROBLEMS = " + JSON.stringify(results, null, 2) + ";\n";

fs.writeFileSync(process.argv[3], js, "utf8");
console.log("生成完成，共 " + results.length + " 题");
