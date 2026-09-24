const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tribunais = require("./tribunais.js");
const { classificar } = require("./andamentos.js");
const { buildXlsx, parseXlsx } = require("./xlsx.js");
const { linhasParaItens, parseCsv } = require("./importar.js");
const { detectarTribunal } = require("./numeroProcesso.js");

const PORT = process.env.PORT || 4173;

// Proteção por senha (HTTP Basic Auth) — só ativa se APP_PASSWORD estiver
// definida no ambiente. Sem isso, qualquer pessoa com o link (ex.: depois
// de publicado num host público) conseguiria usar a aplicação.
const APP_USER = process.env.APP_USER || "syngenta";
const APP_PASSWORD = process.env.APP_PASSWORD || "";

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function autenticado(req) {
  if (!APP_PASSWORD) return true; // sem senha configurada, sem login (uso local)
  const header = req.headers["authorization"] || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const [user, pass] = Buffer.from(encoded, "base64").toString("utf8").split(":");
  return timingSafeEqual(user || "", APP_USER) && timingSafeEqual(pass || "", APP_PASSWORD);
}

if (!APP_PASSWORD) {
  console.log(
    "AVISO: nenhuma senha configurada (defina a variável de ambiente APP_PASSWORD) — a aplicação está SEM proteção de login."
  );
}

// Chave pública documentada em https://datajud-wiki.cnj.jus.br/api-publica/acesso
// (o CNJ pode alterá-la a qualquer momento)
const API_KEY =
  "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";

function callDataJud(tribunal, query, extra = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, ...extra });
    const req = https.request(
      {
        hostname: "api-publica.datajud.cnj.jus.br",
        path: `/${tribunal}/_search`,
        method: "POST",
        headers: {
          Authorization: `APIKey ${API_KEY}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, json: { raw: data } });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildQuery(params) {
  const numero = (params.numeroProcesso || "").replace(/\D/g, "");
  if (numero) {
    return { match: { numeroProcesso: numero } };
  }

  const must = [];
  if (params.classeCodigo) {
    must.push({ match: { "classe.codigo": Number(params.classeCodigo) } });
  }
  if (params.orgaoCodigo) {
    must.push({
      match: { "orgaoJulgador.codigo": Number(params.orgaoCodigo) },
    });
  }
  if (params.assuntoCodigo) {
    must.push({ match: { "assuntos.codigo": Number(params.assuntoCodigo) } });
  }
  if (must.length === 0) {
    throw new Error(
      "Informe o número do processo ou ao menos um filtro (classe/órgão/assunto)."
    );
  }
  return { bool: { must } };
}

// Adiciona `categoria` (audiência/sentença/defesa/acórdão/etc.) a cada
// andamento de cada resultado, quando reconhecível pelo nome do movimento.
function anotarCategorias(json) {
  const hits = (json && json.hits && json.hits.hits) || [];
  for (const hit of hits) {
    const movimentos = (hit._source && hit._source.movimentos) || [];
    for (const mov of movimentos) {
      mov.categoria = classificar(mov.nome);
    }
  }
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_LOTE = 50;

const TODOS_ALIASES = new Set(
  Object.values(tribunais).flatMap((grupo) => Object.keys(grupo))
);

// Aceita tanto o alias da API ("api_publica_trf1") quanto o código curto do
// tribunal ("TRF1", como aparece na coluna "Tribunal" do Excel exportado),
// para que exportar e reimportar a mesma planilha funcione sem ajustes.
function resolverAliasTribunal(valor) {
  if (!valor) return valor;
  const v = valor.trim();
  if (TODOS_ALIASES.has(v)) return v;
  const candidato = "api_publica_" + v.toLowerCase();
  if (TODOS_ALIASES.has(candidato)) return candidato;
  return v;
}

// Decide qual alias usar para um item do lote, nesta ordem de prioridade:
// 1) tribunal informado explicitamente na linha/planilha;
// 2) tribunal detectado a partir do próprio número do processo (dígitos J.TR
//    da numeração única do CNJ — funciona mesmo com processos de tribunais
//    diferentes na mesma lista, sem precisar informar nada);
// 3) tribunal padrão selecionado no formulário.
function resolverTribunalDoItem(item, tribunalPadrao) {
  const explicito = resolverAliasTribunal(item.tribunal);
  if (explicito && TODOS_ALIASES.has(explicito)) return explicito;

  const detectado = detectarTribunal(item.numeroProcesso);
  if (detectado) return detectado;

  const padrao = resolverAliasTribunal(tribunalPadrao);
  if (padrao && TODOS_ALIASES.has(padrao)) return padrao;

  return null;
}

async function buscarUm(tribunal, numeroProcesso) {
  const numero = (numeroProcesso || "").replace(/\D/g, "");
  if (!tribunal) throw new Error("tribunal não informado");
  if (!numero) throw new Error("número do processo não informado");
  const result = await callDataJud(tribunal, { match: { numeroProcesso: numero } });
  anotarCategorias(result.json);
  const hit = result.json && result.json.hits && result.json.hits.hits[0];
  if (!hit) {
    return { numeroProcesso: numero, tribunal, encontrado: false };
  }
  const s = hit._source;
  const andamentos = [...(s.movimentos || [])].sort(
    (a, b) => new Date(a.dataHora) - new Date(b.dataHora)
  );
  return {
    numeroProcesso: s.numeroProcesso,
    tribunal: s.tribunal,
    encontrado: true,
    classe: s.classe,
    grau: s.grau,
    orgaoJulgador: s.orgaoJulgador,
    dataAjuizamento: s.dataAjuizamento,
    assuntos: (s.assuntos || []).flat(),
    andamentos,
  };
}

function fmtDataPlanilha(value) {
  if (!value) return "";
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (compact) return `${compact[3]}/${compact[2]}/${compact[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return value;
}

const CABECALHO_PLANILHA = [
  "Número do Processo",
  "Tribunal",
  "Classe",
  "Órgão Julgador",
  "Data de Ajuizamento",
  "Resumo Padronizado",
  "Assuntos",
  "Status (último andamento)",
  "Andamentos em Destaque",
  "Nome da Parte",
  "Função",
  "Valor Pedido",
  "Resumo do Caso",
];

// "Essa ação trata de: <assuntos>. Último andamento relevante: <categoria em
// destaque mais recente>." Se não houver andamento nas categorias em destaque
// (audiência/sentença/defesa/acórdão/recurso/decisão/trânsito em julgado),
// cai para o último andamento em geral, deixando isso explícito no texto.
function gerarResumoPadronizado(andamentosOrdenados, assuntosNomes) {
  const assuntosTexto = assuntosNomes.length > 0 ? assuntosNomes.join(", ") : "assunto não informado";
  const relevantes = andamentosOrdenados.filter((m) => m.categoria);
  const ultimoRelevante = relevantes[relevantes.length - 1];

  let parteAndamento;
  if (ultimoRelevante) {
    parteAndamento = `${ultimoRelevante.categoria.label} em ${fmtDataPlanilha(ultimoRelevante.dataHora)}`;
  } else {
    const ultimoGeral = andamentosOrdenados[andamentosOrdenados.length - 1];
    parteAndamento = ultimoGeral
      ? `(sem andamento em destaque; último andamento geral: ${ultimoGeral.nome} em ${fmtDataPlanilha(ultimoGeral.dataHora)})`
      : "sem andamentos registrados";
  }

  return `Essa ação trata de: ${assuntosTexto}. Último andamento relevante: ${parteAndamento}.`;
}

// Colunas Nome da Parte / Função / Valor Pedido / Resumo do Caso ficam em
// branco: a API pública do DataJud não fornece esses dados (são dados de
// negócio internos, não metadados processuais).
function processoParaLinha(p) {
  if (!p.encontrado) {
    return [
      p.numeroProcesso || "",
      p.tribunal || "",
      "",
      "",
      "",
      "",
      "",
      p.erro ? `Não encontrado (${p.erro})` : "Não encontrado",
      "",
      "",
      "",
      "",
      "",
    ];
  }

  const andamentos = [...(p.andamentos || [])].sort(
    (a, b) => new Date(a.dataHora) - new Date(b.dataHora)
  );
  const ultimo = andamentos[andamentos.length - 1];
  const status = ultimo ? `${ultimo.nome} em ${fmtDataPlanilha(ultimo.dataHora)}` : "";
  const destaque = andamentos
    .filter((m) => m.categoria)
    .map((m) => `${m.categoria.label}: ${fmtDataPlanilha(m.dataHora)}`)
    .join(" | ");
  const assuntosNomes = (p.assuntos || []).map((a) => a.nome).filter(Boolean);

  return [
    p.numeroProcesso || "",
    p.tribunal || "",
    p.classe ? `${p.classe.nome} (${p.classe.codigo})` : "",
    p.orgaoJulgador ? p.orgaoJulgador.nome : "",
    fmtDataPlanilha(p.dataAjuizamento),
    gerarResumoPadronizado(andamentos, assuntosNomes),
    assuntosNomes.join(", "),
    status,
    destaque,
    "",
    "",
    "",
    "",
  ];
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Módulo Litigation Reporting & Audit (ver litigation/README.md)
const litigation = require("./litigation/routes.js")({ callDataJud, detectarTribunal, buildXlsx, parseXlsx });

const server = http.createServer((req, res) => {
  // verificação de saúde do servidor de hospedagem (sem login, não expõe dados)
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (!autenticado(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Consulta DataJud", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Autenticação necessária.");
    return;
  }

  if (litigation.handle(req, res)) return;
     if (req.method === "GET" && req.url === "/validador-relatorio") {
     res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
     res.end(fs.readFileSync(path.join(__dirname, "public", "validador-relatorio.html")));
     return;
   }

  if (req.method === "GET" && req.url === "/") {
    const file = fs.readFileSync(path.join(__dirname, "public", "index.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(file);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/detectar-tribunal")) {
    const numero = new URL(req.url, "http://localhost").searchParams.get("numero") || "";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ tribunal: detectarTribunal(numero) }));
    return;
  }

  if (req.method === "GET" && req.url === "/tribunais") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(tribunais));
    return;
  }

  if (req.method === "POST" && req.url === "/api/search") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const tribunal =
          (params.tribunal && TODOS_ALIASES.has(params.tribunal) && params.tribunal) ||
          detectarTribunal(params.numeroProcesso);
        if (!tribunal) {
          throw new Error(
            "Selecione um tribunal ou informe um número de processo completo no padrão CNJ (o tribunal é detectado automaticamente)."
          );
        }
        const query = buildQuery(params);
        const result = await callDataJud(tribunal, query);
        anotarCategorias(result.json);
        res.writeHead(result.status === 200 ? 200 : 502, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result.json));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/lote") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const params = JSON.parse(body || "{}");
        const itens = Array.isArray(params.itens) ? params.itens : [];
        if (itens.length === 0) throw new Error("Informe ao menos um processo.");
        if (itens.length > MAX_LOTE) {
          throw new Error(`Máximo de ${MAX_LOTE} processos por consulta em lote.`);
        }

        const resultados = [];
        for (const item of itens) {
          const tribunal = resolverTribunalDoItem(item, params.tribunalPadrao);
          if (!tribunal) {
            resultados.push({
              numeroProcesso: item.numeroProcesso,
              tribunal: item.tribunal || "",
              encontrado: false,
              erro: "Não foi possível determinar o tribunal (número fora do padrão CNJ e nenhum tribunal padrão selecionado).",
            });
            continue;
          }
          try {
            resultados.push(await buscarUm(tribunal, item.numeroProcesso));
          } catch (err) {
            resultados.push({
              numeroProcesso: item.numeroProcesso,
              tribunal,
              encontrado: false,
              erro: err.message,
            });
          }
          await sleep(150); // espaça as chamadas para não sobrecarregar a API pública
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ resultados }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/exportar-xlsx") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const params = JSON.parse(body || "{}");
        const processos = Array.isArray(params.processos) ? params.processos : [];
        if (processos.length === 0) throw new Error("Nenhum processo para exportar.");

        const linhas = [CABECALHO_PLANILHA, ...processos.map(processoParaLinha)];
        const buf = buildXlsx("Casos", linhas);

        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="casos-datajud.xlsx"',
          "Content-Length": buf.length,
        });
        res.end(buf);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/importar")) {
    const filename = new URL(req.url, "http://localhost").searchParams.get("filename") || "";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const rows = /\.xlsx$/i.test(filename) ? parseXlsx(buf) : parseCsv(buf.toString("utf8"));
        const itens = linhasParaItens(rows);
        if (itens.length === 0) {
          throw new Error(
            "Não encontrei processos no arquivo. Verifique se há uma coluna com o número do processo (ex.: \"Número do Processo\")."
          );
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ itens }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Não encontrado");
});

// Quando importado (ex.: pelo conector local do Claude, mcp-datajud.js), só expõe as funções.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Consulta DataJud rodando em http://localhost:${PORT}`);
  });
}

module.exports = { callDataJud, detectarTribunal };
