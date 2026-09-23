// Sincronização em lote com a API Pública do DataJud para a população do quarter.
// Usa o callDataJud do server.js (mesma chave e mesmo cliente HTTP).
// Para cada CNJ consulta o índice do tribunal de origem e, na Justiça do
// Trabalho, também o TST: o mesmo número pode ter uma instância por grau.

const CATS = [
  ["transito", /tr[aâ]nsito em julgado/i],
  ["baixa", /baixa definitiva|arquivamento|arquivad/i],
  ["acordo", /homologa[cç][aã]o de transa|acordo|concilia[cç][aã]o/i],
  ["pagamento", /pagamento|levantamento|libera[cç][aã]o de (valor|dep)/i],
  ["calculos", /homologa[cç][aã]o.*c[aá]lcul|liquida[cç][aã]o/i],
  ["execucao", /execu[cç][aã]o/i],
  ["acordao", /provimento|ac[oó]rd[aã]o|conhecimento em parte|n[aã]o conhecimento|n[aã]o-conhecimento/i],
  ["sentenca", /proced[eê]ncia|improced[eê]ncia|extin[cç][aã]o|julgamento|senten[cç]a|resolu[cç][aã]o do m[eé]rito/i],
  ["recurso", /recurso|agravo|embargos/i],
];
const classify = (n) => { for (const [k, re] of CATS) if (re.test(n || "")) return k; return null; };

function summarize(src) {
  const mv = (src.movimentos || []).filter((m) => m.dataHora).sort((a, b) => (a.dataHora < b.dataHora ? -1 : 1));
  const rel = mv.map((m) => ({ d: m.dataHora.slice(0, 10), n: m.nome, c: classify(m.nome) })).filter((m) => m.c);
  const flags = {};
  rel.forEach((m) => { flags[m.c] = m.d; });
  const last = mv[mv.length - 1];
  return {
    trib: src.tribunal, grau: src.grau, classe: src.classe && src.classe.nome, orgao: src.orgaoJulgador && src.orgaoJulgador.nome,
    ajuiz: (src.dataAjuizamento || "").slice(0, 8), upd: (src.dataHoraUltimaAtualizacao || "").slice(0, 10), nMov: mv.length,
    last: last ? { d: last.dataHora.slice(0, 10), n: last.nome } : null,
    rel, flags,
    recent: mv.slice(-12).map((m) => ({ d: m.dataHora.slice(0, 10), n: m.nome })),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSync({ callDataJud, detectarTribunal }) {
  /**
   * @param cnjs lista de números (só dígitos)
   * @param onProgress ({done,total,phase})
   * @returns {results:{cnj:[inst]}, notFound:[], errors:[], unroutable:[]}
   */
  return async function sync(cnjs, onProgress = () => {}) {
    const unique = [...new Set(cnjs.filter((c) => c && c.length === 20))];
    const unroutable = [];
    const groups = {};
    for (const c of unique) {
      const alias = detectarTribunal(c);
      if (!alias) { unroutable.push(c); continue; }
      (groups[alias] = groups[alias] || []).push(c);
    }
    const labor = unique.filter((c) => c[13] === "5" && c.slice(14, 16) !== "00");
    if (labor.length) groups.api_publica_tst = [...(groups.api_publica_tst || []), ...labor];

    const jobs = [];
    for (const [alias, list] of Object.entries(groups)) for (let i = 0; i < list.length; i += 20) jobs.push([alias, list.slice(i, i + 20)]);
    const results = {}, errors = [];
    let done = 0;
    onProgress({ done, total: jobs.length });
    for (const [alias, chunk] of jobs) {
      try {
        const r = await callDataJud(alias, { terms: { numeroProcesso: chunk } }, { size: 100 });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        for (const h of (r.json.hits && r.json.hits.hits) || []) {
          const s = h._source;
          (results[s.numeroProcesso] = results[s.numeroProcesso] || []).push(summarize(s));
        }
      } catch (e) {
        errors.push({ alias, cnjs: chunk, error: e.message });
      }
      done++;
      onProgress({ done, total: jobs.length });
      await sleep(200);
    }
    const failed = new Set(errors.flatMap((e) => e.cnjs));
    const notFound = unique.filter((c) => !results[c] && !failed.has(c) && !unroutable.includes(c));
    return { results, notFound, errors, unroutable, queried: unique.length, fetchedAt: new Date().toISOString() };
  };
}

module.exports = { makeSync, summarize, classify };
