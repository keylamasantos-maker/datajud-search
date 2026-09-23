// Reconhece o MODELO da base de Litigation (planilha do escritório) e mapeia
// cada coluna para um campo do sistema, sem depender da posição da coluna.
//
// Como funciona:
// 1) acha a linha de cabeçalho (a planilha tem uma linha de totais antes dela);
// 2) acha a coluna do processo pelo nome (numero_processo / número do processo /
//    CNJ / lawsuit number) e, se o nome mudar, pela coluna em que a maioria dos
//    valores tem formato de número CNJ (20 dígitos);
// 3) descobre os quarters citados nos cabeçalhos (ex.: "Q2/2025", "Q3.2026") e
//    separa as colunas do quarter ATUAL e do ANTERIOR;
// 4) lê do próprio cabeçalho parâmetros do modelo: threshold ("ACIMA DE 125K?")
//    e câmbio ("DOLAR 5,70 Q3/2026").

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const QRE = /\bq\s?([1-4])\s?[\.\/\-]?\s?(20\d{2})\b/i;
const quarterOf = (h) => {
  const m = QRE.exec(h || "");
  return m ? { q: +m[1], y: +m[2], id: `Q${m[1]}-${m[2]}` } : null;
};

// Campos do sistema. `when` recebe o cabeçalho normalizado; `period`:
//   "cur"  = coluna do quarter atual, "prev" = do quarter anterior, null = sem quarter.
const FIELDS = [
  { key: "cnj", label: "Número do processo (CNJ)", required: true, when: (h) => /^(numero[_ ]?(do )?processo|n[ºo°]? ?processo|processo|cnj|lawsuit ?number)$/.test(h) },
  { key: "empresa", label: "Empresa (Crop/Seeds)", required: true, when: (h) => h === "empresa" },
  { key: "statusPrev", label: "Status do quarter anterior", period: "prev", when: (h) => /^(status|comparativo)\b/.test(h) },
  { key: "statusCur", label: "Status do quarter atual (Novo/Andamento/Encerrado)", period: "cur", when: (h) => /^(status|comparativo)\b/.test(h) },
  { key: "repPrev", label: "Reportar no Litigation (anterior)", period: "prev", when: (h) => /^reportar/.test(h) },
  { key: "repCur", label: "Reportar no Litigation (atual)", required: true, period: "cur", when: (h) => /^reportar/.test(h) },
  { key: "litPrev", label: "Classificação Litigation (anterior)", period: "prev", when: (h) => /^litigation\b/.test(h) },
  { key: "litCur", label: "Classificação Litigation (atual)", period: "cur", when: (h) => /^litigation\b/.test(h) },
  { key: "cod", label: "Código interno", when: (h) => h === "cod_processo" },
  { key: "situacao", label: "Situação", required: true, when: (h) => h === "situacao" },
  { key: "natureza", label: "Natureza", when: (h) => h === "natureza" },
  { key: "tipo", label: "Tipo de processo", when: (h) => h === "tipo_processo" },
  { key: "posicao", label: "Posição atual (fase)", required: true, when: (h) => h === "posicao_atual" },
  { key: "distrib", label: "Data de distribuição", date: true, when: (h) => h === "data_distribuicao" },
  { key: "entrada", label: "Data de entrada", date: true, when: (h) => h === "data_entrada" },
  { key: "encerramento", label: "Data de encerramento", date: true, when: (h) => h === "data_encerramento" },
  { key: "motivoEnc", label: "Motivo do encerramento", when: (h) => h === "motivo_encerramento" },
  { key: "vara", label: "Vara / competência", when: (h) => h === "competencia_originaria" },
  { key: "comarca", label: "Comarca/UF", when: (h) => h === "comarca_uf" },
  { key: "objetos", label: "Objetos da ação", when: (h) => h === "objetos_acao" },
  { key: "autor", label: "Autor (Plaintiff)", required: true, when: (h) => h === "autor" },
  { key: "reu", label: "Réu (Defendant)", when: (h) => h === "reu" },
  { key: "outras", label: "Outras partes", when: (h) => h === "outras_partes" },
  { key: "contratacao", label: "Tipo de contratação", when: (h) => h === "tipo_contratacao" },
  { key: "funcao", label: "Função", when: (h) => h === "funcao" },
  { key: "valorOrig", label: "Valor do pedido original", num: true, when: (h) => h === "valor_do_pedido_original" },
  { key: "acimaPrev", label: "Acima do threshold? (anterior)", period: "prev", when: (h) => /^acima de/.test(h) },
  { key: "acimaCur", label: "Acima do threshold? (atual)", period: "cur", when: (h) => /^acima de/.test(h) },
  { key: "valorPrev", label: "Valor atualizado BRL (anterior)", num: true, period: "prev", when: (h) => /^valor_do_pedido_atualizado\b/.test(h) },
  { key: "valorCur", label: "Valor atualizado BRL (atual)", required: true, num: true, period: "cur", when: (h) => /^valor_do_pedido_atualizado\b/.test(h) },
  { key: "usdPrev", label: "Valor USD (anterior)", num: true, period: "prev", when: (h) => /^dolar\b/.test(h) },
  { key: "usdCur", label: "Valor USD (atual)", required: true, num: true, period: "cur", when: (h) => /^dolar\b/.test(h) },
  { key: "dataAtual", label: "Data de atualização", date: true, when: (h) => h === "data_atualizacao" },
  { key: "prob", label: "Probabilidade de perda", required: true, when: (h) => /^probabilidade/.test(h) },
  { key: "vProv", label: "Valor provável (Loss Reserve)", required: true, num: true, when: (h) => /^valor_provavel/.test(h) },
  { key: "vPoss", label: "Valor possível", num: true, when: (h) => /^valor_possivel/.test(h) },
  { key: "vRem", label: "Valor remoto", num: true, when: (h) => /^valor_remoto/.test(h) },
  { key: "garantia", label: "Garantias (total)", num: true, when: (h) => h === "valor_historico_total_garantias_oferecidas" },
  { key: "relPrev", label: "Relatório (anterior)", period: "prev", when: (h) => /^relatorio\b/.test(h) },
  { key: "relCur", label: "Relatório (atual)", period: "cur", when: (h) => /^relatorio\b/.test(h) },
  { key: "achPrev", label: "Ação no reporting (anterior)", period: "prev", when: (h) => /^ach\b/.test(h) },
  { key: "achCur", label: "Ação no reporting (atual)", period: "cur", when: (h) => /^ach\b/.test(h) },
];

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
const looksCnj = (v) => onlyDigits(v).length === 20 && /\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}/.test(String(v).replace(/\s/g, ""));

function findHeaderRow(rows) {
  let best = { idx: 0, score: -1 };
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const hs = (rows[i] || []).map(norm);
    let score = 0;
    for (const h of hs) if (h && FIELDS.some((f) => f.when(h))) score++;
    if (score > best.score) best = { idx: i, score };
  }
  return best;
}

function colLetter(n) {
  let s = "";
  n++;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function excelDate(v) {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const s = String(v).trim();
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(+s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[0];
  return null;
}
function toNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === "-") return null;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return +s;
  const br = s.replace(/[^\d,.\-]/g, "");
  if (/,\d{1,2}$/.test(br)) return +br.replace(/\./g, "").replace(",", ".");
  const n = +br.replace(/,/g, "");
  return isNaN(n) ? null : n;
}
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "-" ? null : s;
};

/**
 * @param rows  array de linhas (arrays) como devolvido por parseXlsx
 * @param opts  { cycleId?: "Q3-2026" }  força qual quarter é o atual
 */
function mapModel(rows, opts = {}) {
  const warnings = [];
  const { idx: hIdx, score } = findHeaderRow(rows);
  const headers = (rows[hIdx] || []).map((h) => String(h ?? ""));
  const H = headers.map(norm);
  if (score < 5) warnings.push("Não reconheci o cabeçalho do modelo com segurança: confira o mapeamento abaixo.");

  // quarters presentes nos cabeçalhos
  const qs = {};
  H.forEach((h) => { const q = quarterOf(h); if (q) qs[q.id] = q; });
  const qList = Object.values(qs).sort((a, b) => a.y * 10 + a.q - (b.y * 10 + b.q));
  let cur = opts.cycleId ? qs[opts.cycleId] || quarterOf(opts.cycleId.replace("-", "/")) : qList[qList.length - 1];
  if (opts.cycleId && !qs[opts.cycleId]) warnings.push(`A planilha não cita ${opts.cycleId} nos cabeçalhos; quarters encontrados: ${qList.map((q) => q.id).join(", ") || "nenhum"}.`);
  const curId = cur ? cur.id : null;

  const map = {}; // key -> column index
  const used = new Set();
  for (const f of FIELDS) {
    for (let i = 0; i < H.length; i++) {
      if (used.has(i) || !H[i] || !f.when(H[i])) continue;
      const q = quarterOf(H[i]);
      if (f.period === "cur" && !(q && q.id === curId)) continue;
      if (f.period === "prev" && q && q.id === curId) continue;
      if (f.period === "prev" && !q && !/^dolar/.test(H[i])) continue;
      if (!f.period && q && f.key !== "cnj") { /* colunas sem período podem ter data no nome */ }
      map[f.key] = i; used.add(i);
      if (f.period === "prev" && q && cur && !(q.y * 10 + q.q < cur.y * 10 + cur.q)) warnings.push(`Coluna "${headers[i]}" foi tratada como quarter anterior, mas cita ${q.id}.`);
      break;
    }
  }

  // "Status - Q2.2025" é o anterior; "Comparativo - Q3.2026" o atual; sem quarter não entra.
  // Coluna do processo: se o nome não foi reconhecido, procura pelo formato CNJ.
  let cnjBy = "cabeçalho";
  if (map.cnj === undefined) {
    let best = { i: -1, share: 0 };
    for (let i = 0; i < headers.length; i++) {
      let n = 0, ok = 0;
      for (let r = hIdx + 1; r < Math.min(rows.length, hIdx + 201); r++) {
        const v = rows[r] && rows[r][i];
        if (v === undefined || v === null || String(v).trim() === "") continue;
        n++; if (looksCnj(v)) ok++;
      }
      const share = n ? ok / n : 0;
      if (share > best.share) best = { i, share };
    }
    if (best.share >= 0.6) { map.cnj = best.i; cnjBy = `formato CNJ (${Math.round(best.share * 100)}% dos valores)`; }
  }

  // parâmetros lidos do próprio modelo
  const params = {};
  const acimaH = map.acimaCur !== undefined ? headers[map.acimaCur] : null;
  const t = acimaH && /acima de\s*([\d.,]+)\s*(k|mil)?/i.exec(norm(acimaH));
  if (t) params.threshold = toNum(t[1]) * (t[2] ? 1000 : 1);
  const usdH = map.usdCur !== undefined ? headers[map.usdCur] : null;
  const fx = usdH && /(\d+[.,]\d+)/.exec(usdH);
  if (fx) params.fx = +fx[1].replace(",", ".");
  // cabeçalho de USD anterior com quarter diferente do anterior esperado
  if (map.usdPrev !== undefined && map.valorPrev !== undefined) {
    const a = quarterOf(H[map.usdPrev]), b = quarterOf(H[map.valorPrev]);
    if (a && b && a.id !== b.id) warnings.push(`Cabeçalho "${headers[map.usdPrev]}" cita ${a.id}, mas o valor BRL anterior é ${b.id}: provável erro de digitação no modelo.`);
  }

  const missing = FIELDS.filter((f) => f.required && map[f.key] === undefined).map((f) => f.label);
  if (missing.length) warnings.push("Campos obrigatórios não encontrados: " + missing.join(", ") + ".");

  // linhas
  const records = [];
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some((v) => clean(v))) continue;
    const rec = { _row: r + 1 };
    for (const f of FIELDS) {
      const i = map[f.key];
      if (i === undefined) continue;
      const v = row[i];
      rec[f.key] = f.date ? excelDate(v) : f.num ? toNum(v) : clean(v);
    }
    rec.cnjRaw = rec.cnj;
    rec.cnj = onlyDigits(rec.cnj) || null;
    if (!rec.cnjRaw && !rec.autor) continue;
    records.push(rec);
  }

  const mapping = FIELDS.map((f) => ({
    key: f.key, label: f.label, required: !!f.required,
    col: map[f.key] !== undefined ? colLetter(map[f.key]) : null,
    header: map[f.key] !== undefined ? headers[map[f.key]] : null,
    how: f.key === "cnj" && map.cnj !== undefined ? cnjBy : undefined,
  }));
  const unmapped = headers.map((h, i) => ({ col: colLetter(i), header: h })).filter((x, i) => x.header && !used.has(i) && i !== map.cnj);

  return {
    headerRow: hIdx + 1,
    headers,
    cycleId: curId,
    quarters: qList.map((q) => q.id),
    params,
    mapping,
    unmapped,
    warnings,
    processColumn: map.cnj !== undefined ? { col: colLetter(map.cnj), header: headers[map.cnj], how: cnjBy } : null,
    records,
  };
}

module.exports = { mapModel, FIELDS, excelDate, toNum, norm, colLetter };
