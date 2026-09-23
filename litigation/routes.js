// Módulo Litigation Reporting & Audit (MVP v0.1) plugado no servidor do datajud-search.
// Rotas: /litigation (tela) e /api/lit/* (API). Ver README.md desta pasta.
const fs = require("fs");
const path = require("path");
const os = require("os");
const store = require("./store.js");
const { mapModel } = require("./template.js");
const docx = require("./docx.js");
const E = require("./engine.js");
const { makeSync } = require("./datajud.js");
const makeKv = require("./kv.js");

const DEFAULT_PARAMS = { threshold: 125000, fx: 5.7, materiality: 0.2, fxTol: 0.01, wordScope: ["Crop"], djScope: "population" };
const DECISIONS = {
  ACCEPT: "Accept external data",
  KEEP: "Keep internal data",
  MANUAL: "Manual correction",
  JUSTIFIED: "Justified exception",
};
const RISK_EN = { "Provável": "Probable", "Possível": "Possible", "Remota": "Remote" };
const ORD = ["1st", "2nd", "3rd", "4th"];
const fmtBR = (v) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

module.exports = function litigation(deps) {
  const sync = makeSync(deps);
  const { buildXlsx, parseXlsx } = deps;
  const jobs = {}; // cycleId -> {running, done, total, startedAt, error}
  const cache = {}; // cycleId -> {stamp, ctx, issues}
  const KV = makeKv(store.ROOT);

  /* ---------- helpers ---------- */
  const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
  const sendFile = (res, buf, name, type) => {
    res.writeHead(200, { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": buf.length });
    res.end(buf);
  };
  const readBody = (req) => new Promise((ok, bad) => { const ch = []; req.on("data", (c) => ch.push(c)); req.on("end", () => ok(Buffer.concat(ch))); req.on("error", bad); });
  const readJsonBody = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString("utf8")) : {}; };
  const who = (req, body) => { let h = req.headers["x-user"] || ""; try { h = decodeURIComponent(h); } catch (e) {} return (body && body.user) || h || os.userInfo().username || "usuário"; };
  const need = (id) => { const c = store.getCycle(id); if (!c) throw Object.assign(new Error(`Quarter ${id} não existe.`), { code: 404 }); return c; };

  function trail(c, entry) {
    const e = Object.assign({ ts: new Date().toISOString(), quarter: c.id }, entry);
    store.appendTrail(c.id, e);
    return e;
  }

  /* ---------- contexto do ciclo ---------- */
  function loadCtx(c) {
    const key = c.updatedAt;
    if (cache[c.id] && cache[c.id].stamp === key) return cache[c.id];
    const excel = c.inputs.excel ? store.readJson(c.id, c.inputs.excel.parsed).records : [];
    const word = [];
    const scopes = new Set();
    for (const w of c.inputs.wordGeneral || []) { store.readJson(c.id, w.parsed).records.forEach((r) => word.push(r)); scopes.add(w.scope); }
    if (c.inputs.wordClosed) store.readJson(c.id, c.inputs.wordClosed.parsed).records.forEach((r) => word.push(r));
    const dj = c.datajud ? store.readJson(c.id, c.datajud.file).results : {};
    const djMeta = c.datajud ? store.readJson(c.id, c.datajud.file) : null;
    let baseline = null, baselineClosed = null, baselineFrom = "Colunas do quarter anterior na própria planilha";
    const prev = store.getCycle(store.prevId(c.id));
    if (prev && prev.status === "CLOSED" && prev.closed && prev.closed.validated) {
      const v = store.readJson(prev.id, prev.closed.validated);
      baseline = {}; v.records.forEach((r) => { baseline[r.cnj] = r; });
      baselineClosed = new Set(v.closedReport || []);
      baselineFrom = `${prev.id} fechado em ${prev.closed.at.slice(0, 10)} (base validada)`;
    }
    const docxRev = {};
    let hasRev = false;
    word.forEach((w) => { if (w.kind === "general" && w.rev !== undefined && w.cnj) docxRev[w.cnj] = w.rev; if (w.kind === "general" && w.rev > 0) hasRev = true; });
    const params = Object.assign({}, DEFAULT_PARAMS, c.params, { wordScope: scopes.size ? [...scopes] : c.params.wordScope || ["Crop"] });
    const ctx = { cycleId: c.id, params, excel, word, dj, baseline, baselineClosed, docxRev: hasRev ? docxRev : null };
    const issues = c.inputs.excel ? E.runAudit(ctx) : [];
    const out = { stamp: key, ctx, issues, baselineFrom, djMeta };
    cache[c.id] = out;
    return out;
  }

  function withDecisions(c, issues) {
    return issues.map((i) => {
      const d = c.decisions[i.key];
      return Object.assign({}, i, { status: d ? "Validated" : "Open", decision: d || null, ruleName: E.RULE[i.rule].name, allowed: E.RULE[i.rule].acoes });
    });
  }

  function thrClass(r, P, base) {
    const u1 = r.usdCur, u0 = base ? base.usdCur : r.usdPrev;
    if (u1 === null || u1 === undefined) return "—";
    const a1 = u1 >= P.threshold;
    if (u0 !== null && u0 !== undefined) {
      const a0 = u0 >= P.threshold;
      if (a1 && !a0) return "Crossed Threshold – IN";
      if (!a1 && a0) return "Crossed Threshold – OUT";
    }
    return a1 ? "Above Threshold" : "Below Threshold";
  }

  function stats(c, L, issues) {
    const s = { total: issues.length, open: 0, blocking: 0, bySev: { C: { open: 0, done: 0 }, R: { open: 0, done: 0 }, Q: { open: 0, done: 0 } }, byRule: {} };
    for (const i of issues) {
      const open = i.status === "Open";
      s.bySev[i.sev][open ? "open" : "done"]++;
      if (open) s.open++;
      if (open && i.block) s.blocking++;
      const r = (s.byRule[i.rule] = s.byRule[i.rule] || { open: 0, done: 0 });
      r[open ? "open" : "done"]++;
    }
    const pop = new Set(issues.map((i) => i.cnj));
    s.cases = L.ctx.excel.length;
    s.reportable = L.ctx.excel.filter((r) => r.repCur === "Sim").length;
    return s;
  }

  function statusOf(c, st) {
    if (c.status === "CLOSED") return "CLOSED";
    if (!c.inputs.excel) return "AWAITING INPUT";
    return st.blocking === 0 ? "READY TO CLOSE" : "OPEN";
  }

  function population(L) {
    const { ctx } = L;
    const P = ctx.params;
    const words = {}; ctx.word.forEach((w) => { if (w.cnj) (words[w.cnj] = words[w.cnj] || []).push(w); });
    const cnjs = new Set();
    ctx.excel.forEach((r) => { if (r.repCur === "Sim" || r.repPrev === "Sim" || (r.litCur && r.litCur !== "NÃO ENTRA")) cnjs.add(r.cnj); });
    Object.keys(words).forEach((k) => cnjs.add(k));
    const exBy = {}; ctx.excel.forEach((r) => { if (!exBy[r.cnj]) exBy[r.cnj] = r; });
    return [...cnjs].filter(Boolean).map((cnj) => {
      const r = exBy[cnj] || {}, ws = words[cnj] || [], S = E.djSummary(ctx.dj[cnj]);
      const g = ws.find((w) => w.kind === "general"), cl = ws.find((w) => w.kind === "closed");
      return {
        cnj, cnjFmt: E.fmtCnj(cnj), autor: r.autor || (g || cl || {}).plaintiff || (g || cl || {}).caseName, empresa: r.empresa || "—",
        posicao: r.posicao || null, wordStage: g ? g.stage : cl ? cl.stage : null, report: g ? "General" : cl ? "Closed" : r.repCur === "Sim" ? ((P.wordScope || []).includes(r.empresa) ? "Não está no Word" : `Word ${r.empresa} não carregado`) : "—",
        repCur: r.repCur || null, statusCur: r.statusCur || null, prob: r.prob || null, vProv: r.vProv ?? null, valorCur: r.valorCur ?? null, usdCur: r.usdCur ?? null,
        thr: r.cnj ? thrClass(r, P, ctx.baseline && ctx.baseline[cnj]) : "—",
        djFound: !!S, djLast: S && S.lastAny ? S.lastAny : null, djLastRel: S && S.lastRel ? { d: S.lastRel.d, n: S.lastRel.n, c: E.RELEVANT[S.lastRel.c] } : null,
        djNotFound: !!(L.djMeta && L.djMeta.notFound && L.djMeta.notFound.includes(cnj)),
      };
    });
  }

  /* ---------- valores validados (base saneada + Word) ---------- */
  const WORD_FIELD = { "Case Stage": "stage", "Case Stage × Status": "stage", "Loss Reserve": "reserve", "Financial Relief USD": "reliefUSD", "Financial Relief BRL": "reliefBRL", "Date of First Court Filing": "filing", "Status Update": "status", "Estimated Date of Case Completion": "estCompletion", "Lawsuit Number": "lawsuit" };
  function overrides(c, issues) {
    // decisões que alteram valor: MANUAL (valor digitado) e ACCEPT (valor sugerido/externo)
    const out = {};
    for (const i of issues) {
      const d = c.decisions[i.key];
      if (!d) continue;
      let v = null;
      if (d.decision === "MANUAL") v = d.value;
      if (d.decision === "ACCEPT") v = i.suggested || null;
      if (v === null || v === undefined || v === "") continue;
      (out[i.cnj] = out[i.cnj] || []).push({ field: i.field, value: v, rule: i.rule, decision: d.decision });
    }
    return out;
  }

  function wordChanges(c, L, issues) {
    // Valores que o Word do quarter deve refletir: base validada + decisões
    const { ctx } = L;
    const q = E.quarterInfo(c.id);
    const exBy = {}; ctx.excel.forEach((r) => { if (!exBy[r.cnj]) exBy[r.cnj] = r; });
    const ov = overrides(c, issues);
    const ch = {};
    for (const w of ctx.word.filter((x) => x.kind === "general" && x.cnj)) {
      const r = exBy[w.cnj];
      if (!r) continue;
      const set = {};
      const st = E.stageFromExcel(r.posicao);
      if (st && E.stageFromWord(w.stage) !== st) set.stage = E.STAGE_LABEL[st];
      if (r.valorCur && Math.abs((w.reliefBRLn || 0) - r.valorCur) > 0.01) set.reliefBRL = `BRL ${fmtBR(r.valorCur)}`;
      const usd = r.valorCur ? r.valorCur / ctx.params.fx : null;
      if (usd && Math.abs((w.reliefUSDn || 0) - usd) / usd > 0.001) set.reliefUSD = `USD ${fmtBR(usd)}`;
      if (r.prob && RISK_EN[r.prob] && !new RegExp(RISK_EN[r.prob], "i").test(w.risk || "")) set.risk = RISK_EN[r.prob];
      if (r.prob === "Provável" && r.vProv > 0 && Math.abs((w.reserveN || 0) - r.vProv) > 0.01) set.reserve = `BRL ${fmtBR(r.vProv)}`;
      const y = w.cnj.length === 20 ? w.cnj.slice(9, 13) : null;
      if (y && !(w.filing || "").includes(y)) set.filing = y;
      if (q) { const lu = `${ORD[q.q - 1]} Quarter ${q.y}`; if ((w.lastUpdate || "").trim() !== lu) set.lastUpdate = lu; }
      // decisão de manter o dado do Word (KEEP/JUSTIFIED) impede a alteração automática do campo
      const keepRules = { stage: ["AUD-006", "AUD-007", "AUD-008", "AUD-022"], filing: ["AUD-005"], reliefBRL: ["AUD-015"], reliefUSD: ["AUD-015"], reserve: ["AUD-012", "AUD-013"] };
      for (const [k, rules] of Object.entries(keepRules)) {
        if (set[k] === undefined) continue;
        if (issues.some((i) => i.cnj === w.cnj && rules.includes(i.rule) && c.decisions[i.key] && ["KEEP", "JUSTIFIED"].includes(c.decisions[i.key].decision))) delete set[k];
      }
      for (const o of ov[w.cnj] || []) { const k = WORD_FIELD[o.field]; if (k && k !== "status") set[k] = o.value; }
      if (Object.keys(set).length) ch[w.cnj] = set;
    }
    return ch;
  }

  function buildValidatedRows(c, L, issues) {
    // Reabre o Excel original (layout do modelo preservado) e acrescenta colunas de auditoria.
    const raw = parseXlsx(store.readBuf(c.id, c.inputs.excel.file));
    const m = mapModel(raw, { cycleId: c.id });
    const hdr = m.headerRow - 1;
    const byRow = {}; L.ctx.excel.forEach((r) => { byRow[r._row] = r; });
    const iss = {}; issues.forEach((i) => { (iss[i.cnj] = iss[i.cnj] || []).push(i); });
    const ov = overrides(c, issues);
    const rows = raw.map((row) => row.slice());
    rows[hdr] = [...rows[hdr], "AUDIT_STATUS", "AUDIT_ISSUES", "AUDIT_DECISIONS", "VALIDATED_CHANGES"];
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = byRow[i + 1];
      if (!r) continue;
      const li = iss[r.cnj] || [];
      const open = li.filter((x) => !c.decisions[x.key]);
      rows[i] = [...rows[i], li.length ? (open.length ? `OPEN (${open.length})` : "VALIDATED") : "OK",
        li.map((x) => x.rule).join(", "),
        li.filter((x) => c.decisions[x.key]).map((x) => `${x.rule}: ${c.decisions[x.key].decision}`).join("; "),
        (ov[r.cnj] || []).map((o) => `${o.field} = ${o.value}`).join("; ")];
    }
    return rows;
  }

  const issueRow = (c, i) => {
    const d = c.decisions[i.key];
    return [E.fmtCnj(i.cnj), i.plaintiff || "", i.rule, E.RULE[i.rule].name, { C: "Critical", R: "Relevant", Q: "Data Quality" }[i.sev], i.block ? "Sim" : "Não", i.field || "", i.prev || "", i.excel || "", i.word || "", i.datajud || "", i.latest || "", i.reason || "", i.action || "", d ? DECISIONS[d.decision] : "", d ? d.value || "" : "", d ? d.justification || "" : "", d ? d.by : "", d ? d.at : "", d ? "Validated" : "Open"];
  };
  const ISSUE_HDR = ["Lawsuit Number", "Plaintiff", "Validation ID", "Regra", "Severity", "Bloqueia fechamento", "Field", "Previous Quarter", "Current Excel", "Word", "DataJud", "Latest Proceeding", "Reason", "Suggested Action", "Decision", "Valor corrigido", "Justification", "Validated By", "Validated At", "Status"];
  const TRAIL_HDR = ["Timestamp", "Quarter", "Lawsuit Number", "Validation ID", "Field", "Old Value", "New Value", "Source", "Reason", "Decision", "Justification", "User"];
  const trailRow = (t) => [t.ts, t.quarter, t.cnj ? E.fmtCnj(t.cnj) : "", t.rule || "", t.field || "", t.old || "", t.new || "", t.source || "", t.reason || "", t.decision || "", t.justification || "", t.user || ""];

  function startSync(c, scope) {
    if (jobs[c.id] && jobs[c.id].running) return jobs[c.id];
    const L = loadCtx(c);
    let cnjs;
    if (scope === "all") cnjs = L.ctx.excel.map((r) => r.cnj);
    else {
      cnjs = population(L).map((p) => p.cnj);
      if (scope === "missing") cnjs = cnjs.filter((x) => !L.ctx.dj[x]);
    }
    const job = (jobs[c.id] = { running: true, done: 0, total: 0, startedAt: new Date().toISOString(), scope, count: cnjs.length });
    sync(cnjs, (p) => Object.assign(job, p))
      .then((result) => {
        const cur = store.getCycle(c.id);
        // mescla com a sincronização anterior quando só os faltantes foram consultados
        if (scope === "missing" && cur.datajud) {
          const old = store.readJson(c.id, cur.datajud.file);
          result.results = Object.assign({}, old.results, result.results);
          result.notFound = [...new Set([...(old.notFound || []).filter((x) => !result.results[x]), ...result.notFound])];
        }
        const file = store.putFile(c.id, "02_Audit", `datajud_${c.id}.json`, JSON.stringify(result));
        cur.datajud = { file, at: result.fetchedAt, queried: result.queried, found: Object.keys(result.results).length, notFound: result.notFound.length, errors: result.errors.length, unroutable: result.unroutable.length, scope };
        store.saveCycle(cur);
        trail(cur, { source: "DataJud", reason: `Sincronização (${scope}): ${cur.datajud.found} encontrados, ${cur.datajud.notFound} não localizados, ${cur.datajud.errors} lotes com erro`, user: "sistema" });
        Object.assign(job, { running: false, finishedAt: new Date().toISOString(), result: cur.datajud });
      })
      .catch((e) => Object.assign(job, { running: false, error: e.message }));
    return job;
  }

  /* ---------- rotas ---------- */
  async function route(req, res) {
    const u = new URL(req.url, "http://localhost");
    const p = u.pathname;

    if (req.method === "GET" && (p === "/litigation" || p === "/litigation/")) {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }
    if (!p.startsWith("/api/lit/") && !p.startsWith("/api/kv/")) return false;

    try {
      // armazenamento da tela (mesma interface da versão publicada no Claude)
      if (p === "/api/kv/doc") {
        const dp = u.searchParams.get("path");
        if (req.method === "GET") return send(res, 200, KV.getDoc(dp));
        if (req.method === "PUT") { KV.setDoc(dp, await readJsonBody(req)); return send(res, 200, { ok: true }); }
        if (req.method === "DELETE") { KV.delDoc(dp); return send(res, 200, { ok: true }); }
      }
      if (p === "/api/kv/col" && req.method === "GET") return send(res, 200, { docs: KV.listCol(u.searchParams.get("path")) });
      // Processar: consulta o DataJud para um lote de CNJs
      if (p === "/api/lit/datajud-batch" && req.method === "POST") {
        const b = await readJsonBody(req);
        const cnjs = (b.cnjs || []).map((x) => String(x).replace(/\D/g, "")).filter((x) => x.length === 20).slice(0, 100);
        return send(res, 200, await sync(cnjs));
      }

      if (req.method === "GET" && p === "/api/lit/meta") {
        return send(res, 200, { engine: E.ENGINE_VERSION, rules: E.RULES, decisions: DECISIONS, dataDir: store.ROOT, user: os.userInfo().username, defaults: DEFAULT_PARAMS });
      }
      if (req.method === "GET" && p === "/api/lit/cycles") {
        const list = store.listCycles().map((c) => {
          let st = null;
          try { const L = loadCtx(c); st = stats(c, L, withDecisions(c, L.issues)); } catch (e) { st = null; }
          return { id: c.id, status: st ? statusOf(c, st) : c.status, createdAt: c.createdAt, updatedAt: c.updatedAt, inputs: summarizeInputs(c), datajud: c.datajud || null, stats: st, closed: c.closed || null };
        });
        return send(res, 200, { cycles: list, dataDir: store.ROOT });
      }
      if (req.method === "POST" && p === "/api/lit/cycles") {
        const b = await readJsonBody(req);
        const id = String(b.id || "").toUpperCase();
        if (store.getCycle(id)) throw Object.assign(new Error(`${id} já existe.`), { code: 409 });
        const prev = store.getCycle(store.prevId(id));
        const params = Object.assign({}, DEFAULT_PARAMS, prev ? prev.params : {}, b.params || {});
        const c = store.saveCycle({ id, status: "OPEN", createdAt: new Date().toISOString(), createdBy: who(req, b), params, inputs: { wordGeneral: [] }, decisions: {}, baselineOf: prev ? prev.id : null });
        trail(c, { source: "Sistema", reason: `Novo ciclo aberto${prev ? ` (baseline: ${prev.id}, status ${prev.status})` : ""}`, user: c.createdBy });
        return send(res, 201, { cycle: c });
      }

      const m = /^\/api\/lit\/cycles\/(Q[1-4]-\d{4})(\/.*)?$/.exec(p);
      if (!m) return send(res, 404, { error: "Rota não encontrada." });
      const id = m[1], sub = m[2] || "";
      const c = need(id);
      const frozen = c.status === "CLOSED";

      if (req.method === "GET" && sub === "") {
        const L = loadCtx(c);
        const issues = withDecisions(c, L.issues);
        const st = stats(c, L, issues);
        const ex = c.inputs.excel ? store.readJson(c.id, c.inputs.excel.parsed) : null;
        return send(res, 200, { cycle: Object.assign({}, c, { status: statusOf(c, st) }), stats: st, inputs: summarizeInputs(c), mapping: ex ? ex.mapping : null, baselineFrom: L.baselineFrom, job: jobs[id] || null, params: L.ctx.params, djMeta: L.djMeta ? { notFound: L.djMeta.notFound, errors: L.djMeta.errors, unroutable: L.djMeta.unroutable } : null });
      }

      if (req.method === "POST" && sub === "/upload") {
        if (frozen) throw Object.assign(new Error("Quarter fechado: não aceita novos arquivos."), { code: 409 });
        const kind = u.searchParams.get("kind");
        const name = u.searchParams.get("filename") || "arquivo";
        const buf = await readBody(req);
        const by = who(req);
        if (kind === "excel") {
          if (!/\.xlsx$/i.test(name)) throw new Error("Envie a base em .xlsx.");
          const rows = parseXlsx(buf);
          const mm = mapModel(rows, { cycleId: id });
          if (!mm.processColumn) throw new Error("Não encontrei a coluna do número do processo nem por nome nem pelo formato CNJ.");
          const file = store.putFile(id, "01_Input", name, buf);
          const parsed = store.putFile(id, "01_Input", `excel_parsed_${id}.json`, JSON.stringify({ mapping: mm.mapping, unmapped: mm.unmapped, warnings: mm.warnings, headerRow: mm.headerRow, quarters: mm.quarters, processColumn: mm.processColumn, params: mm.params, records: mm.records }));
          c.inputs.excel = { name, file, parsed, at: new Date().toISOString(), by, rows: mm.records.length, processColumn: mm.processColumn, headerRow: mm.headerRow, warnings: mm.warnings, detectedParams: mm.params };
          // parâmetros lidos do modelo (threshold e câmbio) passam a valer, salvo se o usuário já tiver alterado
          if (mm.params.threshold && !c.paramsLocked) c.params.threshold = mm.params.threshold;
          if (mm.params.fx && !c.paramsLocked) c.params.fx = mm.params.fx;
          store.saveCycle(c);
          trail(c, { source: "Upload", field: "Excel do quarter", new: name, reason: `${mm.records.length} processos; coluna do processo ${mm.processColumn.col} (${mm.processColumn.how})`, user: by });
          let job = null;
          if (u.searchParams.get("datajud") !== "0") job = startSync(store.getCycle(id), c.params.djScope || "population");
          return send(res, 200, { ok: true, mapping: mm.mapping, processColumn: mm.processColumn, headerRow: mm.headerRow, warnings: mm.warnings, rows: mm.records.length, params: mm.params, job });
        }
        if (kind === "word-general" || kind === "word-closed") {
          if (!/\.docx$/i.test(name)) throw new Error("Envie o relatório em .docx.");
          const rep = docx.parseReport(buf, kind === "word-general" ? "general" : "closed");
          if (!rep.records.length) throw new Error("Não encontrei casos no Word (tabelas com Case Name / Lawsuit number).");
          const file = store.putFile(id, "01_Input", name, buf);
          const parsed = store.putFile(id, "01_Input", `${kind}_parsed.json`, JSON.stringify(rep));
          const info = { name, file, parsed, at: new Date().toISOString(), by, scope: rep.scope, records: rep.records.length, withRevisions: rep.records.filter((r) => r.rev > 0).length };
          if (kind === "word-general") c.inputs.wordGeneral = [...(c.inputs.wordGeneral || []).filter((w) => w.scope !== rep.scope), info];
          else c.inputs.wordClosed = info;
          store.saveCycle(c);
          trail(c, { source: "Upload", field: kind === "word-general" ? `Word General (${rep.scope})` : "Word Closed Cases", new: name, reason: `${rep.records.length} casos`, user: by });
          return send(res, 200, { ok: true, info });
        }
        throw new Error("Tipo de arquivo não reconhecido.");
      }

      if (req.method === "POST" && sub === "/params") {
        if (frozen) throw Object.assign(new Error("Quarter fechado."), { code: 409 });
        const b = await readJsonBody(req);
        const old = Object.assign({}, c.params);
        for (const k of ["threshold", "fx", "materiality", "fxTol"]) if (b[k] !== undefined && b[k] !== "" && !isNaN(+b[k])) c.params[k] = +b[k];
        if (b.djScope) c.params.djScope = b.djScope;
        c.paramsLocked = true;
        store.saveCycle(c);
        trail(c, { source: "Parâmetros", field: "Parâmetros do ciclo", old: JSON.stringify(old), new: JSON.stringify(c.params), user: who(req, b) });
        return send(res, 200, { params: c.params });
      }

      if (sub === "/datajud") {
        if (req.method === "POST") {
          if (!c.inputs.excel) throw new Error("Importe a base Excel antes de consultar o DataJud.");
          const b = await readJsonBody(req);
          return send(res, 200, { job: startSync(c, b.scope || "population") });
        }
        return send(res, 200, { job: jobs[id] || null, datajud: c.datajud || null });
      }

      if (req.method === "GET" && sub === "/audit") {
        const L = loadCtx(c);
        const issues = withDecisions(c, L.issues);
        const st = stats(c, L, issues);
        return send(res, 200, { status: statusOf(c, st), stats: st, issues, cases: population(L) });
      }

      const cm = /^\/case\/(\d{5,25})$/.exec(sub);
      if (req.method === "GET" && cm) {
        const cnj = cm[1];
        const L = loadCtx(c);
        const issues = withDecisions(c, L.issues).filter((i) => i.cnj === cnj);
        const ex = L.ctx.excel.filter((r) => r.cnj === cnj);
        const words = L.ctx.word.filter((w) => w.cnj === cnj);
        const inst = L.ctx.dj[cnj] || null;
        const pop = population(L);
        const idx = pop.findIndex((x) => x.cnj === cnj);
        return send(res, 200, {
          cnj, cnjFmt: E.fmtCnj(cnj), excel: ex, word: words, baseline: L.ctx.baseline ? L.ctx.baseline[cnj] || null : null, baselineFrom: L.baselineFrom,
          datajud: inst, djSummary: E.djSummary(inst), djStage: inst ? E.STAGE_LABEL[E.djStage(E.djSummary(inst))] : null,
          djNotFound: !!(L.djMeta && L.djMeta.notFound && L.djMeta.notFound.includes(cnj)),
          issues, trail: store.readTrail(id).filter((t) => t.cnj === cnj),
          prev: idx > 0 ? pop[idx - 1].cnj : null, next: idx >= 0 && idx < pop.length - 1 ? pop[idx + 1].cnj : null,
          params: L.ctx.params,
        });
      }

      if (req.method === "POST" && sub === "/decisions") {
        if (frozen) throw Object.assign(new Error("Quarter fechado: decisões congeladas."), { code: 409 });
        const b = await readJsonBody(req);
        const L = loadCtx(c);
        const i = L.issues.find((x) => x.key === b.key);
        if (!i) throw new Error("Inconsistência não encontrada (a base pode ter sido reimportada).");
        const user = who(req, b);
        if (b.decision === "REOPEN") {
          const oldD = c.decisions[i.key];
          delete c.decisions[i.key];
          store.saveCycle(c);
          trail(c, { cnj: i.cnj, rule: i.rule, field: i.field, old: oldD ? `${oldD.decision}${oldD.value ? " = " + oldD.value : ""}` : "", new: "Reaberta", source: "Validação humana", reason: b.justification || "Decisão reaberta", decision: "REOPEN", user });
          return send(res, 200, { ok: true });
        }
        if (!DECISIONS[b.decision]) throw new Error("Decisão inválida.");
        if (!E.RULE[i.rule].acoes.includes(b.decision)) throw new Error(`A regra ${i.rule} não admite "${DECISIONS[b.decision]}".`);
        if (b.decision === "MANUAL" && !String(b.value || "").trim()) throw new Error("Informe o valor corrigido.");
        const just = String(b.justification || "").trim();
        if ((b.decision === "KEEP" || b.decision === "JUSTIFIED" || i.sev === "C") && just.length < 5) throw new Error("Justificativa obrigatória para esta decisão.");
        const d = { decision: b.decision, value: b.decision === "MANUAL" ? String(b.value).trim() : b.decision === "ACCEPT" ? i.suggested || i.datajud || null : null, justification: just, by: user, at: new Date().toISOString(), rule: i.rule, cnj: i.cnj, field: i.field };
        c.decisions[i.key] = d;
        store.saveCycle(c);
        trail(c, {
          cnj: i.cnj, rule: i.rule, field: i.field,
          old: [i.excel && `Excel: ${i.excel}`, i.word && `Word: ${i.word}`, i.prev && `Anterior: ${i.prev}`].filter(Boolean).join(" | "),
          new: d.value || (b.decision === "KEEP" ? "Mantido o dado interno" : b.decision === "JUSTIFIED" ? "Divergência mantida" : ""),
          source: b.decision === "ACCEPT" ? (i.datajud ? "DataJud" : "Sugestão do sistema") : b.decision === "MANUAL" ? "Correção manual" : "Base interna",
          reason: i.reason, decision: DECISIONS[b.decision], justification: just, user,
        });
        return send(res, 200, { ok: true, decision: d });
      }

      const xm = /^\/export\/(validated|audit|trail|word-changes|word)$/.exec(sub);
      if (req.method === "GET" && xm) {
        const L = loadCtx(c);
        const issues = withDecisions(c, L.issues);
        const tag = c.id.replace("-", "_");
        const draft = c.status === "CLOSED" ? "" : "_DRAFT";
        if (xm[1] === "validated") {
          if (!c.inputs.excel) throw new Error("Sem base importada.");
          return sendFile(res, buildXlsx(c.id, buildValidatedRows(c, L, issues)), `Litigation_${tag}_VALIDATED${draft}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        }
        if (xm[1] === "audit") return sendFile(res, buildXlsx("Audit", [ISSUE_HDR, ...issues.map((i) => issueRow(c, i))]), `Litigation_${tag}_AUDIT_REPORT${draft}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        if (xm[1] === "trail") return sendFile(res, buildXlsx("Audit Trail", [TRAIL_HDR, ...store.readTrail(id).map(trailRow)]), `Litigation_${tag}_AUDIT_TRAIL.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        const ch = wordChanges(c, L, issues);
        if (xm[1] === "word-changes") {
          const FL = { stage: "Case Stage", reliefBRL: "Financial Relief (BRL)", reliefUSD: "Financial Relief (USD)", risk: "Risk of loss", reserve: "Loss Reserve", filing: "Date of First Court Filing", lastUpdate: "Date of Last Update", estCompletion: "Estimated Date of Case Completion", lawsuit: "Lawsuit number" };
          const rows = [["Lawsuit Number", "Case Name", "Field", "Current Word", "New Value"]];
          const cur = {}; L.ctx.word.forEach((w) => { if (w.kind === "general") cur[w.cnj] = w; });
          const names = {}; L.ctx.word.forEach((w) => { names[w.cnj] = w.caseName; });
          Object.entries(ch).forEach(([cnj, set]) => Object.entries(set).forEach(([k, v]) => rows.push([E.fmtCnj(cnj), names[cnj] || "", FL[k] || k, (cur[cnj] || {})[k] || "", v])));
          return sendFile(res, buildXlsx("Word changes", rows), `Litigation_${tag}_WORD_CHANGES${draft}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        }
        const g = (c.inputs.wordGeneral || [])[0];
        if (!g) throw new Error("Importe o Word General para gerar o relatório com Track Changes.");
        const out = docx.applyTrackChanges(store.readBuf(c.id, g.file), ch, `Litigation Audit Desk (${who(req)})`);
        return sendFile(res, out.buffer, `Litigation Report ${c.id} - General${draft}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      }

      if (req.method === "POST" && sub === "/close") {
        if (frozen) throw Object.assign(new Error("Quarter já está fechado."), { code: 409 });
        const b = await readJsonBody(req);
        const L = loadCtx(c);
        const issues = withDecisions(c, L.issues);
        const st = stats(c, L, issues);
        if (st.blocking > 0) throw Object.assign(new Error(`Ainda há ${st.blocking} inconsistências bloqueadoras em aberto.`), { code: 409 });
        const user = who(req, b);
        const tag = c.id.replace("-", "_");
        const files = [];
        // 1. base validada (JSON = baseline do próximo quarter; XLSX = layout do modelo + auditoria)
        const ov = overrides(c, issues);
        const accepted023 = new Set(issues.filter((i) => i.rule === "AUD-023" && c.decisions[i.key] && c.decisions[i.key].decision === "ACCEPT").map((i) => i.cnj));
        const closedReport = [...new Set([...L.ctx.word.filter((w) => w.kind === "closed").map((w) => w.cnj), ...accepted023])];
        const validated = { quarter: c.id, closedAt: new Date().toISOString(), params: L.ctx.params, records: L.ctx.excel.map((r) => Object.assign({}, r, { _overrides: ov[r.cnj] || [] })), closedReport };
        const vJson = store.putFile(c.id, "03_Validated", `Litigation_${tag}_VALIDATED.json`, JSON.stringify(validated));
        files.push(vJson);
        files.push(store.putFile(c.id, "03_Validated", `Litigation_${tag}_VALIDATED.xlsx`, buildXlsx(c.id, buildValidatedRows(c, L, issues))));
        // 2. relatórios finais
        files.push(store.putFile(c.id, "04_Final Reports", `Litigation_${tag}_AUDIT_REPORT.xlsx`, buildXlsx("Audit", [ISSUE_HDR, ...issues.map((i) => issueRow(c, i))])));
        const ch = wordChanges(c, L, issues);
        const g = (c.inputs.wordGeneral || [])[0];
        if (g) {
          const out = docx.applyTrackChanges(store.readBuf(c.id, g.file), ch, `Litigation Audit Desk (${user})`);
          files.push(store.putFile(c.id, "04_Final Reports", `Litigation Report ${c.id} - General.docx`, out.buffer));
        }
        c.status = "CLOSED";
        c.closed = { at: new Date().toISOString(), by: user, validated: vJson, files, summary: st };
        store.saveCycle(c);
        trail(c, { source: "Quarter Close", reason: `Quarter fechado: ${issues.length} inconsistências, ${Object.keys(c.decisions).length} decisões`, decision: "CLOSE QUARTER", user });
        files.push(store.putFile(c.id, "04_Final Reports", `Litigation_${tag}_AUDIT_TRAIL.xlsx`, buildXlsx("Audit Trail", [TRAIL_HDR, ...store.readTrail(id).map(trailRow)])));
        c.closed.files = files;
        store.saveCycle(c);
        return send(res, 200, { ok: true, closed: c.closed, dir: store.dirOf(c.id) });
      }

      return send(res, 404, { error: "Rota não encontrada." });
    } catch (e) {
      return send(res, e.code && Number.isInteger(e.code) ? e.code : 400, { error: e.message });
    }
  }

  function summarizeInputs(c) {
    const i = c.inputs || {};
    return {
      excel: i.excel ? { name: i.excel.name, at: i.excel.at, by: i.excel.by, rows: i.excel.rows, processColumn: i.excel.processColumn, headerRow: i.excel.headerRow, warnings: i.excel.warnings } : null,
      wordGeneral: (i.wordGeneral || []).map((w) => ({ name: w.name, at: w.at, by: w.by, scope: w.scope, records: w.records, withRevisions: w.withRevisions })),
      wordClosed: i.wordClosed ? { name: i.wordClosed.name, at: i.wordClosed.at, records: i.wordClosed.records } : null,
    };
  }

  return {
    handle(req, res) {
      const u = req.url || "";
      if (!(u === "/litigation" || u === "/litigation/" || u.startsWith("/api/lit/") || u.startsWith("/api/kv/"))) return false;
      route(req, res).catch((e) => send(res, 500, { error: e.message }));
      return true;
    },
  };
};
