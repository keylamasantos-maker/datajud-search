// Armazenamento local simples (documentos JSON em pastas) usado pela tela do
// Litigation Audit Desk quando roda no seu computador. Mesma interface de
// "documentos e coleções" que a versão publicada no Claude usa.
const fs = require("fs");
const path = require("path");

module.exports = function kv(root) {
  const base = path.join(root, "kv");
  const seg = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const safe = (p) => {
    const parts = String(p || "").split("/").filter(Boolean);
    if (!parts.length || parts.some((x) => !seg.test(x) || x === "." || x === "..")) throw new Error("Caminho inválido.");
    return parts;
  };
  const docFile = (p) => path.join(base, ...safe(p)) + ".json";
  const colDir = (p) => path.join(base, ...safe(p));

  return {
    getDoc(p) { const f = docFile(p); return fs.existsSync(f) ? { exists: true, data: JSON.parse(fs.readFileSync(f, "utf8")) } : { exists: false }; },
    setDoc(p, data) { const f = docFile(p); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, f); },
    delDoc(p) { const f = docFile(p); if (fs.existsSync(f)) fs.renameSync(f, f + ".deleted-" + Date.now()); },
    listCol(p) {
      const d = colDir(p);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter((n) => n.endsWith(".json")).map((n) => ({ id: n.slice(0, -5), data: JSON.parse(fs.readFileSync(path.join(d, n), "utf8")) }));
    },
  };
};
