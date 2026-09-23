// Lê o Word do Litigation Report (.docx) sem dependências: cada caso é uma
// tabela de duas colunas (rótulo | valor). Além do texto, conta as marcas de
// revisão (Track Changes: w:ins / w:del) por caso e por campo.
const zlib = require("zlib");

function unzip(buffer) {
  const SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("Arquivo .docx inválido (não é um zip).");
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(ptr + 10);
    const csize = buffer.readUInt32LE(ptr + 20);
    const nlen = buffer.readUInt16LE(ptr + 28), xlen = buffer.readUInt16LE(ptr + 30), clen = buffer.readUInt16LE(ptr + 32);
    const loc = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString("utf8", ptr + 46, ptr + 46 + nlen);
    ptr += 46 + nlen + xlen + clen;
    const start = loc + 30 + buffer.readUInt16LE(loc + 26) + buffer.readUInt16LE(loc + 28);
    const data = buffer.subarray(start, start + csize);
    out.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
  }
  return out;
}

const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// texto "aceito": inclui inserções, ignora exclusões (w:delText)
function cellText(xml) {
  return xml
    .split(/<\/w:p>/)
    .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unesc(m[1])).join(""))
    .filter((t) => t.trim())
    .join(" ")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
const revCount = (xml) => (xml.match(/<w:(ins|del)\b[^>]*>/g) || []).length;

const LABELS = [
  ["case name", "caseName"], ["plaintiff", "plaintiff"], ["defendant", "defendant"], ["venue", "venue"],
  ["type of matter", "matter"], ["lawsuit number", "lawsuit"], ["case description", "status"], ["case stage", "stage"],
  ["financial relief sought (local", "reliefBRL"], ["financial relief sought (usd", "reliefUSD"], ["exchange rate", "fx"],
  ["loss reserve", "reserve"], ["likelihood", "risk"], ["date of first court filing", "filing"], ["estimated date", "estCompletion"],
  ["actual date", "actualCompletion"], ["comments of case reporter", "comments"], ["this report has been submitted", "submittedBy"],
  ["date of last update", "lastUpdate"], ["management", "mgmt"], ["contacts", "contacts"],
];
const labelKey = (s) => {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const [p, k] of LABELS) if (t.startsWith(p)) return k;
  return null;
};

function money(s) {
  if (!s) return null;
  const m = /([\d.,]*\d)/.exec(String(s).replace(/\s/g, ""));
  if (!m) return null;
  let x = m[1];
  if (x.includes(",") && x.lastIndexOf(",") > x.lastIndexOf(".")) x = x.replace(/\./g, "").replace(",", ".");
  else x = x.replace(/,/g, "");
  const n = parseFloat(x);
  return isNaN(n) ? null : n;
}
const fxNum = (s) => { const m = /(\d+[.,]\d+)/.exec(s || ""); return m ? +m[1].replace(",", ".") : null; };

function enrich(rec) {
  rec.cnj = String(rec.lawsuit || "").replace(/\D/g, "") || null;
  rec.reliefBRLn = money(rec.reliefBRL);
  rec.reliefUSDn = money(rec.reliefUSD);
  rec.reserveN = money(rec.reserve);
  rec.fxN = fxNum(rec.fx);
  return rec;
}

/** @returns {scope, title, records:[{caseName,..., rev, revFields}]} */
function parseReport(buffer, kind) {
  const files = unzip(buffer);
  const doc = files.get("word/document.xml");
  if (!doc) throw new Error("Não encontrei word/document.xml dentro do arquivo.");
  const xml = doc.toString("utf8");
  const head = cellText(xml.slice(0, 60000)).slice(0, 4000);
  const scope = /\bseeds\b/i.test(head) && !/\bcrop\b/i.test(head) ? "Seeds" : "Crop";
  const records = [];
  for (const tm of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) {
    const tbl = tm[0];
    const rec = { kind, rev: revCount(tbl), revFields: [] };
    let isCase = false;
    for (const rm of tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
      const cells = [...rm[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => c[0]);
      if (cells.length < 2) continue;
      const key = labelKey(cellText(cells[0]));
      if (!key) continue;
      if (key === "caseName") isCase = true;
      if (rec[key] === undefined) {
        rec[key] = cellText(cells.slice(1).join(""));
        if (revCount(cells.slice(1).join(""))) rec.revFields.push(key);
      }
    }
    if (isCase) records.push(enrich(rec));
  }
  return { scope, records };
}

module.exports = { parseReport, enrich, money };

/* ---------- escrita: Word com Track Changes ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipFiles(files) {
  const loc = [], cen = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), comp = zlib.deflateRawSync(f.data), crc = crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    loc.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, name);
    off += 30 + name.length + comp.length;
  }
  const cenBuf = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cenBuf.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cenBuf, e]);
}
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Aplica alterações como marcas de revisão.
 * @param changes { [cnj]: { [fieldKey]: newText } }
 * @returns { buffer, applied:[{cnj, caseName, field, from, to}], missing:[cnj] }
 */
function applyTrackChanges(buffer, changes, author = "Litigation Audit Desk") {
  const files = unzip(buffer);
  let xml = files.get("word/document.xml").toString("utf8");
  const when = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let rid = 900000;
  const applied = [], seen = new Set();
  xml = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    let cnj = null, caseName = "";
    for (const rm of tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
      const cs = [...rm[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => c[0]);
      if (cs.length < 2) continue;
      const k = labelKey(cellText(cs[0]));
      if (k === "lawsuit") cnj = cellText(cs.slice(1).join("")).replace(/\D/g, "");
      if (k === "caseName") caseName = cellText(cs.slice(1).join(""));
    }
    const ch = cnj && changes[cnj];
    if (!ch) return tbl;
    seen.add(cnj);
    return tbl.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (tr) => {
      const cells = [...tr.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => c[0]);
      if (cells.length < 2) return tr;
      const key = labelKey(cellText(cells[0]));
      if (!key || ch[key] === undefined) return tr;
      const cell = cells[1];
      const val = ch[key];
      if (val && typeof val === "object" && val.append) {
        // inserção ao final do texto existente (ex.: novo andamento no Status Update)
        const runs = cell.match(/<w:rPr>[\s\S]*?<\/w:rPr>/g) || [];
        const rPrA = runs.length ? runs[runs.length - 1] : "";
        const insA = `<w:ins w:id="${rid++}" w:author="${esc(author)}" w:date="${when}"><w:r>${rPrA}<w:t xml:space="preserve"> ${esc(val.append)}</w:t></w:r></w:ins>`;
        const at = cell.lastIndexOf("</w:p>");
        if (at < 0) return tr;
        applied.push({ cnj, caseName, field: key, from: "", to: "+ " + val.append });
        return tr.replace(cell, cell.slice(0, at) + insA + cell.slice(at));
      }
      const from = cellText(cell), to = String(val);
      if (from.replace(/\s+/g, " ").trim() === to.trim()) return tr;
      const tcPr = (/<w:tcPr>[\s\S]*?<\/w:tcPr>/.exec(cell) || [""])[0];
      const pPr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(cell) || [""])[0];
      const rPr = (/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(cell.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, "")) || [""])[0];
      const del = from ? `<w:del w:id="${rid++}" w:author="${esc(author)}" w:date="${when}"><w:r>${rPr}<w:delText xml:space="preserve">${esc(from)}</w:delText></w:r></w:del>` : "";
      const ins = `<w:ins w:id="${rid++}" w:author="${esc(author)}" w:date="${when}"><w:r>${rPr}<w:t xml:space="preserve">${esc(to)}</w:t></w:r></w:ins>`;
      const newCell = `<w:tc>${tcPr}<w:p>${pPr}${del}${ins}</w:p></w:tc>`;
      applied.push({ cnj, caseName, field: key, from, to });
      return tr.replace(cell, newCell);
    });
  });
  const out = [];
  for (const [name, data] of files) out.push({ name, data: name === "word/document.xml" ? Buffer.from(xml, "utf8") : data });
  return { buffer: zipFiles(out), applied, missing: Object.keys(changes).filter((c) => !seen.has(c)) };
}

module.exports.applyTrackChanges = applyTrackChanges;
