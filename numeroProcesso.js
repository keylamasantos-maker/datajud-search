// Detecta o tribunal (alias da API) a partir do próprio número CNJ do
// processo, formato NNNNNNN-DD.AAAA.J.TR.OOOO (Resolução CNJ 65/2008).
//
// J = segmento do Judiciário, TR = código do tribunal dentro do segmento.
// Fonte do dígito J: https://www.cnj.jus.br/programas-e-acoes/numeracao-unica/perguntas-frequentes/
// A tabela de códigos de UF (TR) usada pela Justiça Estadual (J=8) é
// reaproveitada pela Justiça Eleitoral (J=6) e pela Justiça Militar Estadual
// (J=9) — confirmado cruzando processos reais (ex.: 8.26 e 6.26 = SP;
// 8.19 e 6.19 = RJ; 8.13 e 9.13 = MG; 8.21 e 9.21 = RS).
const UF_POR_CODIGO = {
  "01": "ac", "02": "al", "03": "ap", "04": "am", "05": "ba", "06": "ce",
  "07": "df", "08": "es", "09": "go", "10": "ma", "11": "mt", "12": "ms",
  "13": "mg", "14": "pa", "15": "pb", "16": "pr", "17": "pe", "18": "pi",
  "19": "rj", "20": "rn", "21": "rs", "22": "ro", "23": "rr", "24": "sc",
  "25": "se", "26": "sp", "27": "to",
};

const MILITAR_ESTADUAL_POR_UF = { mg: "tjmmg", rs: "tjmrs", sp: "tjmsp" };

function detectarTribunal(numeroProcesso) {
  const digitos = (numeroProcesso || "").replace(/\D/g, "");
  if (digitos.length !== 20) return null;

  const j = digitos[13];
  const tr = digitos.slice(14, 16);

  if (j === "3") return "api_publica_stj";
  if (j === "7") return "api_publica_stm";

  if (j === "4") {
    const n = Number(tr);
    return n >= 1 && n <= 6 ? `api_publica_trf${n}` : null; // TR 90 = CJF, sem endpoint público
  }

  if (j === "5") {
    if (tr === "00") return "api_publica_tst";
    const n = Number(tr);
    return n >= 1 && n <= 24 ? `api_publica_trt${n}` : null; // TR 90 = CSJT, sem endpoint público
  }

  if (j === "6") {
    if (tr === "00") return "api_publica_tse";
    const uf = UF_POR_CODIGO[tr];
    return uf ? `api_publica_tre-${uf}` : null;
  }

  if (j === "8") {
    const uf = UF_POR_CODIGO[tr];
    if (!uf) return null;
    return uf === "df" ? "api_publica_tjdft" : `api_publica_tj${uf}`;
  }

  if (j === "9") {
    const uf = UF_POR_CODIGO[tr];
    return uf && MILITAR_ESTADUAL_POR_UF[uf] ? `api_publica_${MILITAR_ESTADUAL_POR_UF[uf]}` : null;
  }

  return null; // J=1 (STF) e J=2 (CNJ) não têm endpoint na API pública do DataJud
}

module.exports = { detectarTribunal };
