# Consulta DataJud (CNJ)

Aplicação local para pesquisar processos judiciais usando a
[API Pública do DataJud](https://datajud-wiki.cnj.jus.br/api-publica/) do CNJ.

## Como rodar

```bash
node server.js
```

Depois abra http://localhost:4173 no navegador.

## O que faz

- Lista os 91 tribunais disponíveis na API (STF/STJ, TRFs, TJs, TRTs, TREs e Justiça Militar).
- Busca por **número do processo** (padrão CNJ, com ou sem pontuação).
- Busca avançada por **código da classe processual**, **código do órgão julgador** e/ou **código do assunto**.
- Mostra os resultados de forma legível (classe, órgão, datas, assuntos, último movimento) e o JSON completo de cada processo.

## Detalhes técnicos

- Backend em Node.js puro (sem dependências externas) — `server.js` faz a requisição
  `POST https://api-publica.datajud.cnj.jus.br/<tribunal>/_search` usando a chave pública
  documentada na wiki do CNJ.
- Frontend em HTML/CSS/JS simples, servido pelo próprio backend (`public/index.html`).
- `tribunais.js` contém a lista oficial de aliases de tribunais.

## Observação

A chave de API é pública e pode ser trocada pelo CNJ a qualquer momento — se as buscas
pararem de funcionar, confira a chave atual em
https://datajud-wiki.cnj.jus.br/api-publica/acesso e atualize a constante `API_KEY`
em `server.js`.
