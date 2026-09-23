# Litigation Audit Desk (MVP v0.1)

Módulo de Litigation Reporting & Audit dentro do `datajud-search`. Usa o mesmo servidor e o mesmo cliente do DataJud.

## Como abrir

Rode `iniciar-litigation.bat` (ou `node server.js`) e acesse http://localhost:4173/litigation

Para salvar o histórico no OneDrive, defina a pasta antes de iniciar:

```
set LITIGATION_DIR=C:\Users\<você>\OneDrive\Litigation Reporting
node server.js
```

Sem essa variável, o histórico fica em `datajud-search\litigation-data`.

## Fluxo (6 telas)

1. **Quarters**: abre o ciclo (ex.: Q4-2026). A versão validada do quarter anterior fechado vira baseline automaticamente.
2. **Upload & DataJud**: importe a planilha no modelo do escritório. O sistema:
   - acha a linha de cabeçalho (a linha 1 de totais é ignorada);
   - acha a coluna do processo pelo nome (`numero_processo`, "número do processo", CNJ, Lawsuit number) ou, se o nome mudar, pela coluna em que a maioria dos valores tem formato CNJ;
   - mapeia as demais colunas pelo nome e separa as do quarter atual e do anterior pelos rótulos Qx/AAAA;
   - lê threshold ("ACIMA DE 125K?") e câmbio ("DOLAR 5,70") do próprio cabeçalho;
   - dispara o DataJud para a população reportável (TRT de origem + TST).
   Depois importe o Word General (e Seeds, se houver) e o Word de Closed Cases.
3. **Litigation**: população reportável com threshold (Above/Below/Crossed IN/OUT) e Latest Relevant Proceeding.
4. **Inconsistências**: resultado das regras AUD-001 a AUD-026 (tela "Ver as 26 regras" traz SE → ENTÃO → evidência → ação).
5. **Case Review**: anterior × Excel × Word × DataJud lado a lado, andamentos relevantes e decisão (Accept / Keep / Manual / Justified). Toda decisão vai para o audit trail.
6. **Quarter Close**: liberado sem bloqueadoras abertas. Gera base validada, Word com Track Changes, relatório de auditoria e audit trail.

## Estrutura do histórico

```
<LITIGATION_DIR>/2026/Q3/
  cycle.json                  estado do ciclo (decisões, parâmetros)
  01_Input/                   arquivos originais recebidos (nunca sobrescritos)
  02_Audit/                   retorno do DataJud + audit_trail.jsonl (append-only)
  03_Validated/               base validada (.json = baseline do próximo quarter, .xlsx)
  04_Final Reports/           Word com Track Changes, relatório de auditoria, audit trail
```

## Arquivos

- `template.js` reconhecimento do modelo da planilha
- `engine.js` motor de auditoria (26 regras)
- `datajud.js` consulta em lote ao DataJud
- `docx.js` leitura do Word e geração com Track Changes
- `store.js` histórico em pastas
- `routes.js` API `/api/lit/*`
- `public/index.html` telas
