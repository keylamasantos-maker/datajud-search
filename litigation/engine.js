/* ===== Litigation Audit Engine v0.1 : AUD-001..AUD-026 ===== */
const ENGINE_VERSION = '0.1';
const SEV = { C: 'Critical', R: 'Relevant', Q: 'Quality' };

const RULES = [
  { id:'AUD-001', sev:'C', block:true,  name:'Número CNJ inválido', src:['Excel','Word'],
    se:'Número não tem 20 dígitos ou o dígito verificador (módulo 97, Res. CNJ 65/2008) não confere.',
    entao:'Sinaliza o registro; não entra em nenhum cruzamento até ser corrigido.',
    evid:'Número recebido, dígito calculado × informado.', acoes:['MANUAL','JUSTIFIED'] },
  { id:'AUD-002', sev:'C', block:true,  name:'Processo duplicado', src:['Excel','Word'],
    se:'O mesmo CNJ normalizado aparece em mais de uma linha do Excel ou em mais de um bloco do Word.',
    entao:'Sinaliza todas as ocorrências; a população reportável não fecha até restar uma.',
    evid:'Linhas/blocos em que o CNJ se repete.', acoes:['MANUAL','JUSTIFIED'] },
  { id:'AUD-003', sev:'R', block:false, name:'CNJ × Plaintiff divergente', src:['Excel','Word'],
    se:'Para o mesmo CNJ, o autor no Excel e o Plaintiff no Word têm similaridade de nome < 60%.',
    entao:'Sinaliza possível troca de processo entre registros.',
    evid:'Nome Excel × nome Word, % de similaridade.', acoes:['ACCEPT','KEEP','MANUAL'] },
  { id:'AUD-004', sev:'R', block:false, name:'CNJ × Defendant divergente', src:['Excel','Word'],
    se:'Empresa do Excel (Crop/Seeds) diverge da Defendant do Word.',
    entao:'Sinaliza para confirmar a entidade ré reportada.',
    evid:'Empresa Excel × Defendant Word.', acoes:['ACCEPT','KEEP','MANUAL'] },
  { id:'AUD-005', sev:'R', block:false, name:'Ano CNJ × Filing Date incompatível', src:['Word','Excel'],
    se:'Date of First Court Filing (Word) ≠ ano do CNJ, ou data de distribuição (Excel) em ano diferente do CNJ.',
    entao:'Sinaliza campo de data para correção.',
    evid:'Ano no CNJ, ano no Word, data no Excel.', acoes:['ACCEPT','MANUAL','JUSTIFIED'] },
  { id:'AUD-006', sev:'C', block:true,  name:'Excel Stage × DataJud incompatível', src:['Excel','DataJud'],
    se:'Posição atual do Excel é incompatível com o grau/movimentos do DataJud (ex.: 1ª instância no Excel com atividade em G2/TST posterior; Arquivado no Excel sem baixa no DataJud).',
    entao:'Review Required: confirmar a fase.',
    evid:'Posição Excel, graus e última movimentação por grau no DataJud.', acoes:['ACCEPT','KEEP','MANUAL','JUSTIFIED'] },
  { id:'AUD-007', sev:'C', block:true,  name:'Word Stage × Excel Stage divergente', src:['Word','Excel'],
    se:'Case Stage do Word, normalizado, não corresponde à posição atual do Excel (1ª inst.→Pending; 2ª/3ª→On Appeal; Execução→Enforcement; Acordo→Settlement; Arquivado→Completed).',
    entao:'Sinaliza divergência entre documento e base.',
    evid:'Stage Word × posição Excel.', acoes:['ACCEPT','KEEP','MANUAL','JUSTIFIED'] },
  { id:'AUD-008', sev:'C', block:true,  name:'Stage × último andamento incompatível', src:['Word','DataJud'],
    se:'Stage ativo, mas o último andamento relevante no DataJud é trânsito em julgado, baixa ou arquivamento; ou Completed com andamento substantivo posterior.',
    entao:'Review Required.',
    evid:'Stage, último andamento relevante e data.', acoes:['ACCEPT','KEEP','JUSTIFIED'] },
  { id:'AUD-009', sev:'C', block:true,  name:'Risk mudou × Reserve não mudou', src:['Baseline','Excel'],
    se:'Probabilidade de perda mudou em relação ao quarter anterior e o valor provisionado ficou igual.',
    entao:'Review Required (não conclui erro de provisão).',
    evid:'Risk anterior/atual, reserve anterior/atual.', acoes:['KEEP','MANUAL','JUSTIFIED'] },
  { id:'AUD-010', sev:'C', block:true,  name:'Reserve mudou × nenhum evento', src:['Baseline','Excel','DataJud'],
    se:'Provisão variou mais que a materialidade e não há andamento relevante no DataJud desde o último fechamento.',
    entao:'Review Required: justificar a variação.',
    evid:'Reserve anterior/atual, variação %, andamentos no período.', acoes:['KEEP','MANUAL','JUSTIFIED'] },
  { id:'AUD-011', sev:'C', block:true,  name:'Evento relevante × Reserve não revisada', src:['DataJud','Excel'],
    se:'Há sentença, acórdão, trânsito, execução, homologação de cálculos, pagamento, acordo ou baixa no DataJud depois do último fechamento e a provisão não mudou (ou não há baseline para comparar).',
    entao:'Pergunta: "Foi identificado andamento processual relevante desde o último reporting. A provisão e/ou classificação de risco requer revisão?" → Review Required.',
    evid:'Evento, data, grau; reserve anterior/atual.', acoes:['KEEP','MANUAL','JUSTIFIED'] },
  { id:'AUD-012', sev:'C', block:true,  name:'Probable × Reserve vazia/zero', src:['Excel','Word'],
    se:'Probabilidade Provável/Probable e valor provável/Loss Reserve vazio ou zero.',
    entao:'Sinaliza; bloqueia fechamento.',
    evid:'Risk e reserve em cada fonte.', acoes:['MANUAL','JUSTIFIED'] },
  { id:'AUD-013', sev:'C', block:true,  name:'Completed × Reserve existente', src:['Excel','Word'],
    se:'Caso encerrado (Excel Encerrado/Arquivado ou Word Completed) com provisão > 0.',
    entao:'Sinaliza para baixa da provisão ou justificativa.',
    evid:'Situação, stage, reserve.', acoes:['MANUAL','JUSTIFIED'] },
  { id:'AUD-014', sev:'C', block:true,  name:'Completed × DataJud incompatível', src:['Excel','Word','DataJud'],
    se:'Caso encerrado internamente, mas o DataJud não tem baixa/arquivamento ou tem movimento após a data de encerramento.',
    entao:'Review Required.',
    evid:'Data de encerramento, última movimentação DataJud.', acoes:['ACCEPT','KEEP','JUSTIFIED'] },
  { id:'AUD-015', sev:'R', block:false, name:'BRL ÷ FX ≠ USD', src:['Word','Excel'],
    se:'|BRL ÷ câmbio − USD| > 1% no Word, ou valor atualizado ÷ câmbio ≠ coluna USD no Excel.',
    entao:'Sinaliza erro de conversão.',
    evid:'BRL, câmbio, USD informado × calculado.', acoes:['ACCEPT','MANUAL','JUSTIFIED'] },
  { id:'AUD-016', sev:'C', block:true,  name:'Cruzamento do threshold', src:['Excel','Baseline'],
    se:'USD atual e USD anterior ficam em lados opostos do threshold (IN/OUT), ou flag "acima do threshold" não bate com o valor para caso ativo.',
    entao:'Sinaliza Crossed Threshold IN/OUT; altera população reportável.',
    evid:'USD anterior, USD atual, threshold, flag.', acoes:['ACCEPT','KEEP','JUSTIFIED'] },
  { id:'AUD-017', sev:'C', block:true,  name:'Caso novo acima do threshold', src:['Excel','Word'],
    se:'Caso marcado como Novo no quarter e acima do threshold.',
    entao:'Confirma inclusão no relatório; se não estiver no Word, bloqueia.',
    evid:'Status Novo, USD, presença no Word.', acoes:['ACCEPT','JUSTIFIED'] },
  { id:'AUD-018', sev:'C', block:true,  name:'Caso sumiu sem justificativa', src:['Baseline','Excel','Word'],
    se:'Reportado no quarter anterior e ausente no atual (nem no Word geral, nem no Closed Cases), sem encerramento ou ação justificada.',
    entao:'Sinaliza; bloqueia fechamento.',
    evid:'Status anterior, status atual, ação registrada.', acoes:['KEEP','JUSTIFIED'] },
  { id:'AUD-019', sev:'R', block:false, name:'Variação material de valor', src:['Excel','Baseline'],
    se:'Valor atualizado do pedido variou mais que a materialidade (padrão 20%) entre quarters.',
    entao:'Sinaliza para conferência.',
    evid:'Valor anterior, atual, variação %.', acoes:['KEEP','MANUAL','JUSTIFIED'] },
  { id:'AUD-020', sev:'R', block:false, name:'Data impossível/inconsistente', src:['Word','Excel'],
    se:'Data no texto do Status posterior ao fim do quarter ou anterior ao ano do CNJ; encerramento antes da distribuição; campo de data preenchido com texto de outro campo.',
    entao:'Sinaliza para correção.',
    evid:'Data encontrada e referência violada.', acoes:['MANUAL','JUSTIFIED'] },
  { id:'AUD-021', sev:'R', block:false, name:'DataJud tem andamento após o Last Update', src:['Word','DataJud'],
    se:'Último andamento relevante no DataJud é posterior ao fim do período indicado em Date of Last Update.',
    entao:'Sugere texto em inglês com os andamentos relevantes; aceito ou editado, entra no Word como marca de revisão no Status Update.',
    evid:'Last Update × data do andamento.', acoes:['ACCEPT','KEEP','JUSTIFIED'] },
  { id:'AUD-022', sev:'C', block:true,  name:'Narrativa × campos estruturados', src:['Word'],
    se:'O texto do Status indica trânsito, arquivamento, acordo ou pagamento e o Stage é ativo; ou Stage Completed com texto "awaiting/pending"; ou Closed Case com Stage ≠ Completed.',
    entao:'Sinaliza incoerência no documento.',
    evid:'Trecho do texto e Stage.', acoes:['MANUAL','KEEP','JUSTIFIED'] },
  { id:'AUD-023', sev:'R', block:false, name:'Closed case permanece no General', src:['Word','Excel'],
    se:'Caso Completed/encerrado aparece no General Report.',
    entao:'Candidato a migração GENERAL → CLOSED.',
    evid:'Stage, situação, ação do quarter.', acoes:['ACCEPT','KEEP','JUSTIFIED'] },
  { id:'AUD-024', sev:'R', block:false, name:'Closed case reaparece', src:['Baseline','Excel','Word'],
    se:'Caso encerrado/reportado como Closed no quarter anterior volta à população reportável.',
    entao:'Sinaliza reabertura para confirmação.',
    evid:'Status anterior (Closed), status atual.', acoes:['ACCEPT','KEEP','JUSTIFIED'] },
  { id:'AUD-025', sev:'Q', block:false, name:'Campo obrigatório vazio', src:['Word'],
    se:'Campo obrigatório do Word vazio ou ilegível (Lawsuit number, Stage, Relief BRL/USD, Risk, Filing, Last Update, Status, Loss Reserve quando Probable).',
    entao:'Sinaliza para preenchimento.',
    evid:'Campos vazios.', acoes:['MANUAL','JUSTIFIED'] },
  { id:'AUD-026', sev:'R', block:false, name:'Mudança sem Track Changes', src:['Baseline','Word (.docx)'],
    se:'Valor ou fase mudou entre quarters e o bloco do caso no .docx não tem marca de revisão (w:ins/w:del).',
    entao:'Sinaliza alteração silenciosa.',
    evid:'Campos alterados, nº de revisões no bloco.', acoes:['KEEP','JUSTIFIED'] },
];
const RULE = Object.fromEntries(RULES.map(r => [r.id, r]));

/* ---------- helpers ---------- */
const normCnj = s => { const d = String(s ?? '').replace(/\D/g, ''); return d || null; };
const fmtCnj = d => d && d.length === 20 ? `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d[13]}.${d.slice(14,16)}.${d.slice(16)}` : (d || '—');
function cnjValid(d) {
  if (!d || d.length !== 20) return { ok:false, why:`${d ? d.length : 0} dígitos (esperado 20)` };
  const n = BigInt(d.slice(0,7) + d.slice(9,13) + d[13] + d.slice(14,16) + d.slice(16) + '00');
  const dv = 98n - (n % 97n);
  const calc = String(dv).padStart(2,'0');
  return calc === d.slice(7,9) ? { ok:true } : { ok:false, why:`DV informado ${d.slice(7,9)}, calculado ${calc}` };
}
const strip = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
function nameSim(a, b) {
  const A = new Set(strip(a).split(' ').filter(w => w.length > 2 && !['dos','das','de','da','do'].includes(w)));
  const B = new Set(strip(b).split(' ').filter(w => w.length > 2 && !['dos','das','de','da','do'].includes(w)));
  if (!A.size || !B.size) return 1;
  let i = 0; A.forEach(w => { if (B.has(w)) i++; });
  return i / Math.min(A.size, B.size);
}
const num = x => (x === null || x === undefined || x === '' || isNaN(+x)) ? null : +x;
const pct = (a, b) => (a && b) ? (b - a) / Math.abs(a) : null;

function stageFromExcel(p) {
  const s = strip(p);
  if (!s) return null;
  if (s.startsWith('1')) return 'PENDING';
  if (s.startsWith('2') || s.startsWith('3') || s.includes('recursal')) return 'APPEAL';
  if (s.includes('execu')) return 'ENFORCEMENT';
  if (s.includes('acordo')) return 'SETTLEMENT';
  if (s.includes('arquiv')) return 'COMPLETED';
  if (s.includes('administ')) return 'PENDING';
  return null;
}
function stageFromWord(t) {
  const s = strip(t);
  if (!s) return null;
  if (s.includes('complet')) return 'COMPLETED';
  if (s.includes('appeal')) return 'APPEAL';
  if (s.includes('enforce') || s.includes('execution')) return 'ENFORCEMENT';
  if (s.includes('settle')) return 'SETTLEMENT';
  if (s.includes('pending') || s.includes('court') || s.includes('cort')) return 'PENDING';
  return 'OTHER';
}
const STAGE_LABEL = { PENDING:'Action Pending in Court', APPEAL:'On Appeal', ENFORCEMENT:'Enforcement', SETTLEMENT:'Negotiated Settlement', COMPLETED:'Completed', OTHER:'(não padronizado)' };
const RELEVANT = { transito:'Trânsito em julgado', baixa:'Baixa/Arquivamento', acordo:'Acordo', pagamento:'Pagamento/Levantamento', calculos:'Homologação/Liquidação', execucao:'Execução', acordao:'Acórdão', sentenca:'Sentença/Julgamento', recurso:'Recurso' };

function quarterInfo(cid) { // 'Q3-2026'
  const m = /Q(\d)-(\d{4})/.exec(cid || ''); if (!m) return null;
  const q = +m[1], y = +m[2];
  const endM = q * 3, start = `${y}-${String(endM - 2).padStart(2,'0')}-01`;
  const end = new Date(Date.UTC(y, endM, 0)).toISOString().slice(0,10);
  const prevEnd = new Date(Date.UTC(y, endM - 3, 0)).toISOString().slice(0,10);
  return { q, y, start, end, prevEnd, prevId: q === 1 ? `Q4-${y-1}` : `Q${q-1}-${y}` };
}
function lastUpdateEnd(s) { // "2nd Quarter 2026"
  const m = /(\d)\s*(st|nd|rd|th)?\s*quarter\s*(\d{4})/i.exec(s || ''); if (!m) return null;
  const q = +m[1], y = +m[3];
  return new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0,10);
}

/* DataJud: summary of one CNJ = array of instances (one per grau/tribunal) */
function djSummary(inst) {
  if (!inst || !inst.length) return null;
  const all = [];
  inst.forEach(i => (i.rel || []).forEach(r => all.push({ ...r, grau: i.grau, trib: i.trib })));
  all.sort((a, b) => a.d < b.d ? -1 : 1);
  const lastAny = inst.map(i => i.last && { ...i.last, grau: i.grau }).filter(Boolean).sort((a, b) => a.d < b.d ? -1 : 1).pop() || null;
  const flags = {}; inst.forEach(i => Object.entries(i.flags || {}).forEach(([k, d]) => { if (!flags[k] || flags[k] < d) flags[k] = d; }));
  const graus = [...new Set(inst.map(i => i.grau))];
  const lastByGrau = {}; inst.forEach(i => { if (i.last && (!lastByGrau[i.grau] || lastByGrau[i.grau] < i.last.d)) lastByGrau[i.grau] = i.last.d; });
  const lastRel = all[all.length - 1] || null;
  const minAjuiz = inst.map(i => i.ajuiz).filter(Boolean).sort()[0] || null;
  return { graus, lastAny, lastRel, rel: all, flags, lastByGrau, ajuiz: minAjuiz };
}
function djStage(s) {
  if (!s) return null;
  const f = s.flags, last = s.lastAny?.d || '';
  if (f.baixa && f.baixa >= last.slice(0,10) && !['G2','SUP','GS'].some(g => (s.lastByGrau[g] || '') > f.baixa)) return 'COMPLETED';
  if (f.execucao || f.calculos) {
    const e = [f.execucao, f.calculos].filter(Boolean).sort().pop();
    if (!f.baixa || e > f.baixa) return 'ENFORCEMENT';
  }
  const g1 = s.lastByGrau.G1 || '', g2 = s.lastByGrau.G2 || '', sup = s.lastByGrau.SUP || s.lastByGrau.GS || '';
  if ((g2 || sup) && (g2 > g1 || sup > g1)) return 'APPEAL';
  return 'PENDING';
}


/* Frase em inglês para o Status Update a partir dos andamentos relevantes do DataJud */
const COURT = { G1: 'the Labor Court', G2: 'the Regional Labor Court', SUP: 'the Superior Labor Court (TST)', GS: 'the Superior Labor Court (TST)' };
const PHRASE = {
  sentenca: (c) => `${c} issued a judgment`,
  acordao: (c) => `${c} ruled on the appeal`,
  recurso: (c) => `an appeal was filed before ${c}`,
  transito: () => 'the decision became final and binding',
  execucao: () => 'the enforcement phase began',
  calculos: () => 'the enforcement calculations were addressed by the court',
  pagamento: () => 'a payment or release of funds was recorded',
  acordo: () => 'a settlement was recorded in the case',
  baixa: () => 'the case was archived',
};
function statusSentence(evs) {
  const seen = new Set(), out = [];
  for (const e of evs) {
    const k = e.c + e.d; if (seen.has(k)) continue; seen.add(k);
    const [y, m, d] = e.d.split('-');
    const court = COURT[e.grau] || 'the court';
    const txt = (PHRASE[e.c] || (() => e.n))(court);
    out.push(`On ${m}/${d}/${y}, ${txt}.`);
  }
  return out.slice(-4).join(' ');
}

/* ---------- main ---------- */
function runAudit(ctx) {
  // ctx: {cycleId, params:{threshold, fx, materiality, fxTol}, excel:[], word:[], dj:{cnj:[inst]}, baseline:{cnj:row}|null, baselineClosed:Set, docxRev:{cnj:n}|null}
  const P = Object.assign({ threshold: 125000, fx: 5.70, materiality: 0.20, fxTol: 0.01, wordScope: ['Crop'] }, ctx.params || {});
  const Q = quarterInfo(ctx.cycleId);
  const issues = [];
  const add = (rid, cnj, o) => issues.push(Object.assign({ key: `${rid}_${cnj || o.ref || 'x'}${o.suffix ? '_' + o.suffix : ''}`, rule: rid, sev: RULE[rid].sev, block: RULE[rid].block, cnj }, o));

  const ex = ctx.excel || [], wd = ctx.word || [];
  const exBy = {}; ex.forEach((r, i) => { r._i = i; (exBy[r.cnj] = exBy[r.cnj] || []).push(r); });
  const wdGen = wd.filter(w => w.kind === 'general'), wdClosed = wd.filter(w => w.kind === 'closed');
  const wdBy = {}; wdGen.forEach(w => { (wdBy[w.cnj] = wdBy[w.cnj] || []).push(w); });
  const closedBy = {}; wdClosed.forEach(w => { closedBy[w.cnj] = w; });
  const base = ctx.baseline || null;

  // population = reportable now or before, or present in any Word
  const inPop = r => r.repCur === 'Sim' || r.repPrev === 'Sim' || (r.litCur && r.litCur !== 'NÃO ENTRA');
  const pop = new Set();
  ex.forEach(r => { if (inPop(r)) pop.add(r.cnj); });
  wd.forEach(w => w.cnj && pop.add(w.cnj));

  const scope = new Set(P.wordScope || ['Crop']);
  const inScope = r => scope.has(r.empresa);
  const plaintiffOf = c => (exBy[c]?.[0]?.autor) || (wdBy[c]?.[0]?.plaintiff) || (closedBy[c]?.plaintiff) || '';

  // AUD-001 (all Excel rows + Word)
  ex.forEach(r => { const v = cnjValid(r.cnj); if (!v.ok) add('AUD-001', r.cnj, { ref: 'ex' + r._i, field: 'Lawsuit Number', excel: r.cnjRaw, reason: v.why, action: 'Corrigir o número na base (linha ' + (r._i + 3) + ').' }); });
  wd.forEach((w, i) => { const v = cnjValid(w.cnj); if (!v.ok) add('AUD-001', w.cnj, { ref: 'wd' + i, suffix: 'w' + i, field: 'Lawsuit Number', plaintiff: w.plaintiff, word: w.lawsuit || '(vazio)', reason: `Word (${w.caseName}): ${w.lawsuit ? v.why : 'campo vazio'}`, action: 'Preencher/corrigir o Lawsuit number no Word.' }); });
  // AUD-002
  Object.entries(exBy).forEach(([c, rs]) => { if (c && rs.length > 1) add('AUD-002', c, { field: 'Lawsuit Number', reason: `CNJ aparece ${rs.length}× no Excel (linhas ${rs.map(r => r._i + 3).join(', ')}).`, action: 'Manter uma linha e registrar a exclusão.' }); });
  Object.entries(wdBy).forEach(([c, ws]) => { if (c && c !== 'null' && ws.length > 1) add('AUD-002', c, { suffix: 'w', field: 'Lawsuit Number', reason: `CNJ aparece ${ws.length}× no Word geral (${ws.map(w => w.caseName).join(' / ')}).`, action: 'Remover o bloco duplicado do Word.' }); });
  const wdNames = {}; wdGen.forEach(w => { const k = strip(w.caseName); (wdNames[k] = wdNames[k] || []).push(w); });
  Object.values(wdNames).forEach(ws => { if (ws.length > 1 && new Set(ws.map(w => w.cnj)).size > 1) ws.forEach(w => { /* same name, different CNJs: informative only */ }); });

  for (const c of pop) {
    if (!c) continue;
    const r = exBy[c]?.[0] || null, w = wdBy[c]?.[0] || null, cl = closedBy[c] || null;
    const W = w || cl;
    const pl = plaintiffOf(c);
    const inst = ctx.dj?.[c] || null, S = djSummary(inst);
    const b = base?.[c] || null;
    const cnjYear = c.length === 20 ? +c.slice(9,13) : null;
    const exStage = r ? stageFromExcel(r.posicao) : null;
    const wStage = W ? stageFromWord(W.stage) : null;
    const closedInternal = r && (r.situacao === 'Encerrado' || exStage === 'COMPLETED');
    const common = { plaintiff: pl };

    // AUD-003
    if (r && W && r.autor && W.plaintiff) { const s = nameSim(r.autor, W.plaintiff); if (s < 0.6) add('AUD-003', c, { ...common, field: 'Plaintiff', excel: r.autor, word: W.plaintiff, reason: `Similaridade de nome ${(s * 100).toFixed(0)}%.`, action: 'Confirmar se o CNJ pertence a este autor.' }); }
    // AUD-004
    if (r && W && W.defendant) {
      const isSeeds = /seeds|sementes/i.test(W.defendant), exSeeds = r.empresa === 'Seeds';
      if (isSeeds !== exSeeds) add('AUD-004', c, { ...common, field: 'Defendant', excel: `${r.empresa} · ${r.reu || ''}`, word: W.defendant, reason: `Excel indica ${r.empresa}; Word reporta "${W.defendant}".`, action: 'Confirmar a entidade ré e o relatório (Crop/Seeds).' });
    }
    // AUD-005
    if (cnjYear) {
      const wy = W && /\b(19|20)\d{2}\b/.exec(W.filing || '')?.[0];
      if (wy && +wy !== cnjYear) add('AUD-005', c, { ...common, field: 'Date of First Court Filing', excel: r?.distrib, word: W.filing, reason: `CNJ é de ${cnjYear}; Word informa ${wy}.`, action: `Ajustar Filing para ${cnjYear}.`, suggested: String(cnjYear) });
      else if (r?.distrib && +r.distrib.slice(0,4) !== cnjYear && Math.abs(+r.distrib.slice(0,4) - cnjYear) > 0) add('AUD-005', c, { ...common, suffix: 'x', field: 'Data de distribuição', excel: r.distrib, reason: `CNJ é de ${cnjYear}; distribuição no Excel em ${r.distrib.slice(0,4)}.`, action: 'Conferir data de distribuição.' });
    }
    // AUD-006
    if (r && S) {
      const d = djStage(S);
      let bad = null;
      if (exStage === 'PENDING' && (d === 'APPEAL' || d === 'ENFORCEMENT' || d === 'COMPLETED')) bad = d;
      else if (exStage === 'APPEAL' && (d === 'ENFORCEMENT' || d === 'COMPLETED')) bad = d;
      else if (exStage === 'COMPLETED' && d !== 'COMPLETED') bad = d;
      else if (exStage === 'ENFORCEMENT' && d === 'COMPLETED') bad = d;
      if (bad) add('AUD-006', c, { ...common, field: 'Case Stage', excel: r.posicao, datajud: STAGE_LABEL[bad] + ` (graus: ${S.graus.join(', ')})`, latest: S.lastAny && `${S.lastAny.d} · ${S.lastAny.n} (${S.lastAny.grau})`, reason: `Excel em "${r.posicao}", DataJud indica ${STAGE_LABEL[bad]}.`, action: 'Review Required: confirmar a fase atual.', suggested: STAGE_LABEL[bad] });
    }
    // AUD-007
    if (r && w && exStage && wStage && exStage !== wStage) add('AUD-007', c, { ...common, field: 'Case Stage', excel: r.posicao, word: w.stage, reason: `Word "${w.stage}" × Excel "${r.posicao}" (esperado ${STAGE_LABEL[exStage]}).`, action: 'Alinhar Stage do Word com a base.', suggested: STAGE_LABEL[exStage] });
    // AUD-008
    if (W && S && S.lastRel) {
      const lr = S.lastRel, active = wStage && wStage !== 'COMPLETED';
      if (active && ['transito', 'baixa'].includes(lr.c) && lr.c === (Object.entries(S.flags).sort((a, b) => a[1] < b[1] ? 1 : -1)[0] || [])[0]) add('AUD-008', c, { ...common, field: 'Case Stage', word: W.stage, datajud: `${RELEVANT[lr.c]} em ${lr.d}`, latest: `${lr.d} · ${lr.n} (${lr.grau})`, reason: `Stage ativo, mas último andamento relevante é ${RELEVANT[lr.c]}.`, action: 'Review Required: avaliar encerramento.' });
      if (wStage === 'COMPLETED' && ['sentenca', 'acordao', 'recurso', 'execucao'].includes(lr.c) && (!S.flags.baixa || lr.d > S.flags.baixa)) add('AUD-008', c, { ...common, suffix: 'c', field: 'Case Stage', word: W.stage, latest: `${lr.d} · ${lr.n}`, reason: 'Completed, mas há andamento substantivo posterior à baixa.', action: 'Review Required.' });
    }
    // AUD-009 / AUD-010 (need baseline)
    if (b && r) {
      const riskChanged = b.prob && r.prob && b.prob !== r.prob;
      const rb = num(b.vProv) || 0, rc = num(r.vProv) || 0;
      if (riskChanged && rb === rc) add('AUD-009', c, { ...common, field: 'Loss Reserve', prev: `${b.prob} · BRL ${fmtN(rb)}`, excel: `${r.prob} · BRL ${fmtN(rc)}`, reason: 'Risco mudou e provisão ficou igual.', action: 'Review Required.' });
      const v = pct(rb, rc);
      if (rb && v !== null && Math.abs(v) > P.materiality && S && !S.rel.some(x => x.d > Q.prevEnd && x.c !== 'recurso')) add('AUD-010', c, { ...common, field: 'Loss Reserve', prev: `BRL ${fmtN(rb)}`, excel: `BRL ${fmtN(rc)}`, reason: `Provisão variou ${(v * 100).toFixed(0)}% sem andamento relevante no DataJud desde ${Q.prevEnd}.`, action: 'Justificar a variação.' });
    }
    // AUD-011
    if (S && Q) {
      const ev = S.rel.filter(x => x.d > Q.prevEnd && x.c !== 'recurso');
      if (ev.length) {
        const rb = b ? (num(b.vProv) || 0) : null, rc = r ? (num(r.vProv) || 0) : null;
        if (rb === null || rb === rc) { const e = ev[ev.length - 1]; add('AUD-011', c, { ...common, field: 'Loss Reserve / Risk', excel: r ? `${r.prob} · BRL ${fmtN(rc)}` : null, prev: b ? `BRL ${fmtN(rb)}` : '(sem baseline)', datajud: ev.map(x => `${x.d} ${RELEVANT[x.c]}`).slice(-3).join(' · '), latest: `${e.d} · ${e.n} (${e.grau})`, reason: 'Foi identificado andamento processual relevante desde o último reporting. A provisão e/ou classificação de risco requer revisão?', action: 'Review Required.' }); }
      }
    }
    // AUD-012
    if (r && r.prob === 'Provável' && !(num(r.vProv) > 0) && inPop(r)) add('AUD-012', c, { ...common, field: 'Loss Reserve', excel: `Provável · valor provável ${fmtN(num(r.vProv))}`, reason: 'Excel: Provável sem valor provável.', action: 'Informar a provisão ou rever o risco.' });
    if (W && /probable/i.test(W.risk || '') && !(W.reserveN > 0)) add('AUD-012', c, { ...common, suffix: 'w', field: 'Loss Reserve', word: `${W.risk} · ${W.reserve || '(vazio)'}`, excel: r ? `${r.prob} · BRL ${fmtN(num(r.vProv))}` : null, reason: 'Word: Probable sem Loss Reserve.', action: 'Preencher Loss Reserve no Word.', suggested: r && num(r.vProv) ? `BRL ${fmtN(num(r.vProv))}` : null });
    // AUD-013
    const wCompleted = wStage === 'COMPLETED';
    if ((closedInternal || wCompleted) && ((r && num(r.vProv) > 0) || (W && W.reserveN > 0))) add('AUD-013', c, { ...common, field: 'Loss Reserve', excel: r ? `${r.situacao} · ${r.posicao} · BRL ${fmtN(num(r.vProv))}` : null, word: W ? `${W.stage} · ${W.reserve || ''}` : null, reason: 'Caso encerrado com provisão.', action: 'Baixar provisão ou justificar.' });
    // AUD-014
    if ((closedInternal || wCompleted) && S) {
      const enc = r?.encerramento || null;
      if (!S.flags.baixa && !S.flags.transito) add('AUD-014', c, { ...common, field: 'Case Stage', excel: r ? `${r.situacao} ${enc || ''}` : null, word: W?.stage, datajud: 'Sem baixa/arquivamento/trânsito', latest: S.lastAny && `${S.lastAny.d} · ${S.lastAny.n}`, reason: 'Encerrado internamente, sem baixa no DataJud.', action: 'Review Required.' });
      else if (enc && S.lastAny && S.lastAny.d > enc && !['baixa','transito'].includes(S.lastRel?.c)) add('AUD-014', c, { ...common, suffix: 'p', field: 'Case Stage', excel: `Encerrado em ${enc}`, latest: `${S.lastAny.d} · ${S.lastAny.n}`, reason: 'Há movimentação após a data de encerramento.', action: 'Review Required.' });
    }
    // AUD-015
    if (W && W.reliefBRLn && W.reliefUSDn) {
      const fx = W.fxN || P.fx, calc = W.reliefBRLn / fx;
      if (Math.abs(calc - W.reliefUSDn) / calc > P.fxTol) add('AUD-015', c, { ...common, field: 'Financial Relief USD', word: `BRL ${fmtN(W.reliefBRLn)} ÷ ${fx} → USD ${fmtN(W.reliefUSDn)}`, reason: `USD informado ${fmtN(W.reliefUSDn)}; calculado ${fmtN(calc)} (${(((W.reliefUSDn - calc) / calc) * 100).toFixed(1)}%).`, action: 'Recalcular USD.', suggested: `USD ${fmtN(calc)}` });
    }
    if (W && r && W.reliefBRLn && num(r.valorCur) && Math.abs(W.reliefBRLn - r.valorCur) / r.valorCur > P.fxTol && inPop(r) && r.repCur === 'Sim') add('AUD-015', c, { ...common, suffix: 'b', field: 'Financial Relief BRL', excel: `BRL ${fmtN(r.valorCur)}`, word: `BRL ${fmtN(W.reliefBRLn)}`, reason: 'Valor do pedido no Word difere do valor atualizado no Excel.', action: 'Atualizar o Word com o valor da base.', suggested: `BRL ${fmtN(r.valorCur)}` });
    if (r && num(r.valorCur) && num(r.usdCur) && Math.abs(r.valorCur / P.fx - r.usdCur) / (r.valorCur / P.fx) > P.fxTol) add('AUD-015', c, { ...common, suffix: 'x', field: 'USD (Excel)', excel: `${fmtN(r.valorCur)} → USD ${fmtN(r.usdCur)}`, reason: `Câmbio implícito ${(r.valorCur / r.usdCur).toFixed(4)} ≠ ${P.fx}.`, action: 'Recalcular coluna USD.' });
    // AUD-016
    if (r) {
      const u0 = b ? num(b.usdCur) : num(r.usdPrev), u1 = num(r.usdCur);
      const active = r.situacao !== 'Encerrado';
      if (u0 !== null && u1 !== null && active) {
        if (u0 < P.threshold && u1 >= P.threshold) add('AUD-016', c, { ...common, field: 'Materialidade', prev: `USD ${fmtN(u0)}`, excel: `USD ${fmtN(u1)}`, reason: `Crossed Threshold – IN (USD ${fmtN(P.threshold)}).`, action: 'Incluir na população reportável.' , tag: 'IN' });
        if (u0 >= P.threshold && u1 < P.threshold) add('AUD-016', c, { ...common, field: 'Materialidade', prev: `USD ${fmtN(u0)}`, excel: `USD ${fmtN(u1)}`, reason: `Crossed Threshold – OUT (USD ${fmtN(P.threshold)}).`, action: 'Confirmar saída do relatório.', tag: 'OUT' });
      }
      if (u1 !== null && active && (u1 >= P.threshold) !== (r.acimaCur === 'Sim')) add('AUD-016', c, { ...common, suffix: 'f', field: 'Flag acima do threshold', excel: `USD ${fmtN(u1)} · flag "${r.acimaCur}" · ${r.prob}`, reason: `Valor ${u1 >= P.threshold ? 'acima' : 'abaixo'} de USD ${fmtN(P.threshold)} e flag "${r.acimaCur}".`, action: u1 >= P.threshold ? 'Confirmar se deve entrar no Litigation.' : 'Confirmar critério de inclusão.' });
    }
    // AUD-017
    if (r && /novo/i.test(r.statusCur || '') && num(r.usdCur) >= P.threshold) add('AUD-017', c, { ...common, field: 'População', excel: `${r.statusCur} · USD ${fmtN(r.usdCur)} · ${r.litCur}`, word: w ? 'Presente no Word' : (inScope(r) ? 'AUSENTE no Word' : `Relatório ${r.empresa} não carregado`), reason: w ? 'Caso novo acima do threshold: confirmar narrativa e campos.' : (inScope(r) ? 'Caso novo acima do threshold não está no Word.' : 'Caso novo acima do threshold; confirmar no relatório ' + r.empresa + '.'), action: w ? 'Validar inclusão.' : 'Incluir no Word.' });
    // AUD-018
    if (r && inScope(r) && (b ? b.repCur === 'Sim' : r.repPrev === 'Sim') && !w && !cl) {
      const just = /encerr|retirar/i.test(r.achCur || '') || /encerr/i.test(r.litCur || '');
      const stillRep = r.repCur === 'Sim';
      if (!just) add('AUD-018', c, { ...common, field: 'População', prev: `Reportado (${r.relPrev || r.litPrev})`, excel: `${r.repCur} · ${r.litCur} · ação: ${r.achCur}`, word: 'Ausente', reason: stillRep ? 'A base manda reportar (e reportou no quarter anterior), mas o caso não está no Word geral nem no Closed.' : 'Saiu da população reportável sem encerramento ou ação justificada.', action: stillRep ? 'Reincluir no Word ou justificar.' : 'Justificar a saída.' });
    }
    // AUD-019
    if (r && inPop(r)) {
      const v0 = b ? num(b.valorCur) : num(r.valorPrev), v1 = num(r.valorCur), v = pct(v0, v1);
      if (v !== null && Math.abs(v) > P.materiality) add('AUD-019', c, { ...common, field: 'Financial Relief BRL', prev: `BRL ${fmtN(v0)}`, excel: `BRL ${fmtN(v1)}`, reason: `Variação de ${(v * 100).toFixed(0)}% entre quarters.`, action: 'Conferir cálculo/atualização.' });
    }
    // AUD-020
    if (W && Q) {
      const ds = [...(W.status || '').matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map(m => `${m[3]}-${m[1]}-${m[2]}`);
      const fut = ds.filter(d => d > Q.end), old = cnjYear ? ds.filter(d => +d.slice(0,4) < cnjYear) : [];
      const badMD = [...(W.status || '').matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].filter(m => +m[1] > 12 || +m[2] > 31).map(m => m[0]);
      if (fut.length || old.length || badMD.length) add('AUD-020', c, { ...common, field: 'Status Update (datas)', word: [...fut.map(d => d + ' (após ' + Q.end + ')'), ...old.map(d => d + ` (antes do CNJ ${cnjYear})`), ...badMD.map(d => d + ' (formato dd/mm; relatório usa mm/dd)')].join('; '), reason: 'Data impossível no texto do Status.', action: 'Corrigir a data na narrativa.' });
      if (/^(possible|probable|remote)$/i.test((W.estCompletion || '').trim())) add('AUD-020', c, { ...common, suffix: 'e', field: 'Estimated Date of Case Completion', word: W.estCompletion, reason: 'Campo de data preenchido com classificação de risco.', action: 'Preencher com data ou "Uncertain".' });
    }
    if (r && r.encerramento && r.distrib && r.encerramento < r.distrib) add('AUD-020', c, { ...common, suffix: 'x', field: 'Datas (Excel)', excel: `distrib ${r.distrib} · enc ${r.encerramento}`, reason: 'Encerramento anterior à distribuição.', action: 'Corrigir datas.' });
    // AUD-021
    if (W && S && S.lastRel) {
      const lu = lastUpdateEnd(W.lastUpdate);
      // corte: o mais recente entre o fim do Last Update e a última data já narrada no Status
      const narr = [...(W.status || '').matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map((m) => (+m[1] <= 12 ? `${m[3]}-${m[1]}-${m[2]}` : `${m[3]}-${m[2]}-${m[1]}`)).filter((d) => !Q || d <= Q.end).sort().pop() || '';
      const cut = [lu || '', narr].sort().pop();
      if (lu && S.lastRel.d > cut) {
        const evs = S.rel.filter((x) => x.d > cut);
        add('AUD-021', c, { ...common, field: 'Status Update', word: W.lastUpdate, datajud: evs.slice(-4).map((x) => `${x.d} ${RELEVANT[x.c]}`).join(' · '), latest: `${S.lastRel.d} · ${S.lastRel.n} (${S.lastRel.grau})`, reason: `DataJud tem ${evs.length} andamento(s) relevante(s) após ${cut} (Last Update ${lu}; última data narrada ${narr || '—'}).`, action: 'Inserir no Status Update como marca de revisão (texto sugerido; edite em Manual correction).', suggested: statusSentence(evs) });
      }
    }
    // AUD-022
    if (W) {
      const t = W.status || '';
      const endHit = /final and binding|res judicata became|became final|archiv|settlement (was|has been) (reached|approved|ratified)|agreement (was|has been) (approved|ratified|homologated)|dismissed the enforcement|case (was|is) closed/i.exec(t);
      const negated = endHit && /\b(no|not|without)\s+$/i.test(t.slice(Math.max(0, endHit.index - 8), endHit.index));
      if (endHit && !negated && wStage && !['COMPLETED', 'SETTLEMENT'].includes(wStage)) add('AUD-022', c, { ...common, field: 'Case Stage × Status', word: `Stage "${W.stage}" · texto: "…${t.slice(Math.max(0, endHit.index - 50), endHit.index + 60).trim()}…"`, reason: 'Narrativa indica encerramento/acordo e o Stage está ativo.', action: 'Alinhar Stage ou narrativa.' });
      if (wStage === 'COMPLETED' && /currently awaiting|awaiting (further|the)|pending (judgment|decision)/i.test(t.slice(-300))) add('AUD-022', c, { ...common, suffix: 'a', field: 'Case Stage × Status', word: `Stage Completed · final do texto: "${t.slice(-120)}"`, reason: 'Completed com narrativa de pendência.', action: 'Alinhar Stage ou narrativa.' });
      if (W.kind === 'closed' && wStage !== 'COMPLETED') add('AUD-022', c, { ...common, suffix: 'k', field: 'Case Stage', word: `Closed Cases · Stage "${W.stage}"`, reason: 'Caso no relatório de Closed Cases com Stage diferente de Completed.', action: 'Ajustar Stage para Completed.', suggested: 'Completed' });
    }
    // AUD-023
    if (w && (wStage === 'COMPLETED' || closedInternal)) add('AUD-023', c, { ...common, field: 'Relatório', excel: r ? `${r.situacao} · ${r.litCur} · ${r.achCur}` : null, word: `General · ${w.stage}`, reason: 'Caso encerrado ainda no General Report.', action: 'Migrar GENERAL → CLOSED.', suggested: 'CLOSED' });
    // AUD-024
    const wasClosed = ctx.baselineClosed ? ctx.baselineClosed.has(c) : (r && /encerrado/i.test(r.litPrev || ''));
    if (wasClosed && (w || (r && r.repCur === 'Sim' && !/encerr/i.test(r.litCur || '')))) add('AUD-024', c, { ...common, field: 'Relatório', prev: `Closed (${r?.litPrev || 'quarter anterior'})`, excel: r ? `${r.repCur} · ${r.litCur}` : null, word: w ? 'Presente no General' : null, reason: 'Caso encerrado no quarter anterior voltou à população.', action: 'Confirmar reabertura.' });
    // AUD-025
    if (W) {
      const req = [['lawsuit', 'Lawsuit number'], ['stage', 'Case Stage'], ['reliefBRL', 'Relief BRL'], ['reliefUSD', 'Relief USD'], ['risk', 'Risk of loss'], ['filing', 'First Court Filing'], ['lastUpdate', 'Last Update'], ['status', 'Status Update'], ['venue', 'Venue']];
      const miss = req.filter(([k]) => !String(W[k] || '').replace(/BRL|USD|\s|\.|:/gi, '').trim()).map(x => x[1]);
      if (/^\s*BR\s*$/i.test(W.reserve || '')) miss.push('Loss Reserve ("BR")');
      if (miss.length) add('AUD-025', c, { ...common, field: miss.join(', '), word: `${W.kind === 'closed' ? 'Closed' : 'General'} · ${W.caseName}`, reason: 'Campos obrigatórios vazios/ilegíveis.', action: 'Preencher.' });
    }
    // AUD-026
    if (ctx.docxRev && w && r) {
      const changed = (num(r.valorPrev) && num(r.valorCur) && Math.abs(pct(num(r.valorPrev), num(r.valorCur))) > 0.001) || (b && b.posicao !== r.posicao);
      const rev = ctx.docxRev[c];
      if (changed && rev !== undefined && rev === 0) add('AUD-026', c, { ...common, field: 'Track Changes', prev: `BRL ${fmtN(num(r.valorPrev))}`, excel: `BRL ${fmtN(num(r.valorCur))}`, word: '0 marcas de revisão no bloco', reason: 'Mudança entre quarters sem marca de revisão.', action: 'Aplicar Track Changes no Word.' });
    }
  }
  // de-dup keys
  const seen = new Set();
  return issues.filter(i => seen.has(i.key) ? false : (seen.add(i.key), true));
}
function fmtN(v) { if (v === null || v === undefined || isNaN(v)) return '—'; return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

if (typeof module !== 'undefined') module.exports = { ENGINE_VERSION, statusSentence, RULES, RULE, runAudit, cnjValid, djSummary, djStage, quarterInfo, fmtCnj, stageFromExcel, stageFromWord, STAGE_LABEL, RELEVANT, lastUpdateEnd, fmtN };
