// Classifica um andamento (movimento) em categorias "principais" com base
// no nome do movimento, que segue a Tabela Processual Unificada do CNJ.
// A API não marca o que é relevante — isso é um filtro por palavra-chave.

const CATEGORIAS = [
  { chave: "audiencia", label: "Audiência", cor: "#3b82f6", termos: [/audi[eê]ncia/i] },
  { chave: "sentenca", label: "Sentença", cor: "#22c55e", termos: [/senten[cç]a/i] },
  { chave: "acordao", label: "Acórdão", cor: "#a855f7", termos: [/ac[oó]rd[aã]o/i] },
  {
    chave: "defesa",
    label: "Defesa",
    cor: "#f97316",
    termos: [/contesta[cç][aã]o/i, /\bdefesa\b/i, /resposta\s+[aà]\s+acusa[cç][aã]o/i],
  },
  {
    chave: "recurso",
    label: "Recurso",
    cor: "#ef4444",
    termos: [/\brecurso\b/i, /apela[cç][aã]o/i, /\bagravo\b/i, /embargos/i],
  },
  {
    chave: "decisao",
    label: "Decisão",
    cor: "#14b8a6",
    termos: [/decis[aã]o/i, /\bdespacho\b/i],
  },
  {
    chave: "transito",
    label: "Trânsito em Julgado",
    cor: "#64748b",
    termos: [/tr[aâ]nsito\s+em\s+julgado/i],
  },
];

function classificar(nomeMovimento) {
  if (!nomeMovimento) return null;
  for (const cat of CATEGORIAS) {
    if (cat.termos.some((re) => re.test(nomeMovimento))) {
      return { chave: cat.chave, label: cat.label, cor: cat.cor };
    }
  }
  return null;
}

module.exports = { CATEGORIAS, classificar };
