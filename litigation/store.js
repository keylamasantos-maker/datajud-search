// Histórico por quarter em pastas (pode apontar para o OneDrive com a variável
// de ambiente LITIGATION_DIR). Nenhum arquivo de entrada ou saída é
// sobrescrito: cada versão ganha carimbo de data/hora no nome.
//
// <LITIGATION_DIR>/2026/Q3/01_Input | 02_Audit | 03_Validated | 04_Final Reports
//                        /Q3/cycle.json          (estado de trabalho do ciclo)
//                        /Q3/02_Audit/audit_trail.jsonl (append-only)
const fs = require("fs");
const path = require("path");

const ROOT = process.env.LITIGATION_DIR || path.join(__dirname, "..", "litigation-data");
const SUB = ["01_Input", "02_Audit", "03_Validated", "04_Final Reports"];
const idRe = /^Q([1-4])-(\d{4})$/;

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
function dirOf(id) {
  const m = idRe.exec(id);
  if (!m) throw new Error("Quarter inválido (use o formato Q3-2026).");
  return path.join(ROOT, m[2], `Q${m[1]}`);
}
function ensure(id) {
  const d = dirOf(id);
  for (const s of SUB) fs.mkdirSync(path.join(d, s), { recursive: true });
  return d;
}
function writeJsonAtomic(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function listCycles() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const y of fs.readdirSync(ROOT).filter((x) => /^\d{4}$/.test(x))) {
    for (const q of fs.readdirSync(path.join(ROOT, y)).filter((x) => /^Q[1-4]$/.test(x))) {
      const f = path.join(ROOT, y, q, "cycle.json");
      if (fs.existsSync(f)) out.push(JSON.parse(fs.readFileSync(f, "utf8")));
    }
  }
  return out.sort((a, b) => (a.id.slice(3) + a.id[1] < b.id.slice(3) + b.id[1] ? 1 : -1));
}
function getCycle(id) {
  const f = path.join(dirOf(id), "cycle.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
function saveCycle(c) {
  ensure(c.id);
  c.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(dirOf(c.id), "cycle.json"), c);
  return c;
}
// grava arquivo versionado numa subpasta e devolve o caminho relativo ao ciclo
function putFile(id, sub, name, data) {
  const d = ensure(id);
  const ext = path.extname(name);
  const base = path.basename(name, ext).replace(/[^\w.\- ()]+/g, "_").slice(0, 80);
  const rel = path.join(sub, `${base}__${stamp()}${ext}`);
  fs.writeFileSync(path.join(d, rel), data);
  return rel;
}
const readJson = (id, rel) => JSON.parse(fs.readFileSync(path.join(dirOf(id), rel), "utf8"));
const readBuf = (id, rel) => fs.readFileSync(path.join(dirOf(id), rel));
function appendTrail(id, entry) {
  const d = ensure(id);
  fs.appendFileSync(path.join(d, "02_Audit", "audit_trail.jsonl"), JSON.stringify(entry) + "\n");
}
function readTrail(id) {
  const f = path.join(dirOf(id), "02_Audit", "audit_trail.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function prevId(id) {
  const m = idRe.exec(id);
  const q = +m[1], y = +m[2];
  return q === 1 ? `Q4-${y - 1}` : `Q${q - 1}-${y}`;
}

module.exports = { ROOT, dirOf, ensure, listCycles, getCycle, saveCycle, putFile, readJson, readBuf, appendTrail, readTrail, prevId, stamp };
