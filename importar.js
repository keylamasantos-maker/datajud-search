// Lê uma planilha (linhas já extraídas de .xlsx ou .csv) e localiza a coluna
// do número do processo (e, se houver, a do tribunal) pelo nome do cabeçalho.

function normalizar(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

const CABECALHOS_PROCESSO = [
  "numero do processo",
  "número do processo",
  "numeroprocesso",
  "num processo",
  "nº processo",
  "processo",
  "cnj",
];
const CABECALHOS_TRIBUNAL = ["tribunal", "alias do tribunal", "tribunal (alias)"];

function detectarColunas(headerRow) {
  let colProcesso = -1;
  let colTribunal = -1;
  headerRow.forEach((cell, i) => {
    const norm = normalizar(cell);
    if (colProcesso === -1 && CABECALHOS_PROCESSO.some((h) => norm.includes(h))) colProcesso = i;
    if (colTribunal === -1 && CABECALHOS_TRIBUNAL.some((h) => norm.includes(h))) colTribunal = i;
  });
  return { colProcesso, colTribunal };
}

function linhasParaItens(rows) {
  if (rows.length === 0) return [];
  const { colProcesso, colTribunal } = detectarColunas(rows[0]);
  const temCabecalho = colProcesso !== -1;
  const dataRows = temCabecalho ? rows.slice(1) : rows;
  const idxProcesso = temCabecalho ? colProcesso : 0;
  const idxTribunal = temCabecalho ? colTribunal : 1;

  return dataRows
    .map((row) => ({
      numeroProcesso: (row[idxProcesso] || "").toString().trim(),
      tribunal: idxTribunal !== -1 ? (row[idxTribunal] || "").toString().trim() : "",
    }))
    .filter((item) => item.numeroProcesso);
}

function parseCsv(text) {
  const primeiraLinha = text.split(/\r?\n/)[0] || "";
  const qtdPontoEVirgula = (primeiraLinha.match(/;/g) || []).length;
  const qtdVirgula = (primeiraLinha.match(/,/g) || []).length;
  const sep = qtdPontoEVirgula >= qtdVirgula ? ";" : ",";
  return text
    .split(/\r?\n/)
    .filter((linha) => linha.trim() !== "")
    .map((linha) => linha.split(sep).map((v) => v.trim().replace(/^"|"$/g, "")));
}

module.exports = { linhasParaItens, parseCsv };
