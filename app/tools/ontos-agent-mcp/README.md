# @ontos/agent-mcp

stdio MCP server that gives a coding agent authenticated access to OntOS verticals through the shell.
Workspace tool installed and validated with the application from `app/`.

## Configuration

| Variable                                   | Required | Default                        | Purpose                                                                  |
| ------------------------------------------ | -------- | ------------------------------ | ------------------------------------------------------------------------ |
| `ONTOS_AGENT_API_KEY`                      | yes      | none                           | Shell API key, sent only as `x-api-key` to the shell gateway endpoint    |
| `ONTOS_SHELL_URL`                          | no       | `http://localhost:3020`        | Shell origin                                                             |
| `ONTOS_COMPOSITION_REVISION`               | no       | from the publisher             | Live release revision (64 hex). The shell rejects other values           |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL` | no       | `http://127.0.0.1:3041/active` | Composition publisher; supplies the revision when it is missing or stale |
| `ONTOS_LEGAL_ENTITY_ID`                    | no       | none                           | UUID of the legal entity to scope assertions to                          |

Process environment wins. Missing values are read from `app/.env.demo.local` (`KEY=VALUE` lines).
That file is gitignored by `**/.env.*` in `app/.gitignore`. `scripts/demo/reset-permissions.mts` writes the key,
shell URL, legal entity and the revision of that moment there.

The composition revision changes whenever the demo stack is rebuilt. Read the current one with
`curl -s http://127.0.0.1:3041/active | jq -r .composition.revision` (the development composition publisher
started by `scripts/demo/up.sh`). The server needs no manual update: without a revision, or when the shell answers
409 (reload required) for a stale one, it reads `composition.revision` from that endpoint and retries once.

Every vertical call exchanges the API key for a fresh gateway assertion. Core validates the assertion and
evaluates each Read or Action lifecycle; actions also carry a fresh `idempotency-key`. Better Auth limits each API key to
10 verifications per 24 h by default, so `reset-permissions.mts` disables that limit on the `agent-bot` keys.

## Run

```bash
cd app
mise exec -- pnpm install
mise exec -- pnpm --filter @ontos/agent-mcp typecheck
mise exec -- pnpm --filter @ontos/agent-mcp start      # stdio server; no output on stdout until a client connects
```

Core tools: `whoami` (shell URL and whether a `siampark-work` assertion can be obtained) and
`raw_read` (vertical, readName, query: a records read through the shell).

Sales tools (src/tools): reads `list_customers`, `list_employees`, `list_opportunities`, `list_orders`,
`list_products`, `list_invoices`, `list_tasks`, `list_tags`, `list_metrics`, `get_metrics`; writes `create_task`,
`update_task`, `create_opportunity`, `update_opportunity`, `create_tag`, `assign_tags`, `unassign_tags`. Writes read the current
`expectedRevision` first and retry once on a revision conflict. Amounts are CZK numbers. A 403 answers
"Agent nemá oprávnění: …" with the HTTP status and problem code.

`get_metrics` imports the pure engine at `app/verticals/sales-insights/shared/metrics.ts` by relative path, so this
package works only inside the OntOS checkout. Unit tests: `mise exec -- pnpm --filter @ontos/agent-mcp test` from `app/` (Effect-aware Rstest harness, mocked fetch, no shell).

## Demo s Claude

Předpoklad: běží lokální demo (`app/scripts/demo/README.md`) a `app/.env.demo.local` obsahuje klíč bota
(zapisuje ho `scripts/demo/reset-permissions.mts`). Jednorázově nainstalujte závislosti
(`mise exec -- pnpm install` ve složce `app/`) a zaregistrujte server v Claude Code:

```bash
claude mcp add ontos-sales -- /Users/satan/.local/share/mise/installs/node/26.7.0/bin/node --no-warnings /Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app/tools/ontos-agent-mcp/src/server.ts
```

Klíč, URL shellu a právní subjekt se načtou z `app/.env.demo.local`, revizi kompozice si server zjistí
z `http://127.0.0.1:3041/active`. Ověření: `claude mcp list` ukáže `ontos-sales … ✔ Connected`; v chatu
nástroj `whoami` vrátí `assertionObtained: true`. Odebrání: `claude mcp remove ontos-sales`.

Čtyři ukázkové prompty (v tomto pořadí):

1. „Jaké jsme měli fakturované tržby po měsících za posledních 12 měsíců? Který měsíc byl nejsilnější a kolik je
   teď otevřeno v pipeline ve fázi Vyjednávání?“
2. „Vytvoř úkol pro obchodníka, který má na starosti největší příležitost ve vyjednávání: ať do pátku zavolá
   zákazníkovi kvůli nabídce. Priorita vysoká.“
3. „Příležitost Wi-Fi pokrytí skladu pro Mosteckou energetiku vrať do fáze Nabídka, zákazník chce upravenou
   nabídku.“
4. „Otaguj podle pravidla: zákazníci s potvrzenými fakturami nad 200 000 Kč dostanou štítek VIP a objednávky nad
   100 000 Kč štítek pro velké objednávky. Když vhodný štítek pro objednávky neexistuje, založ ho. Pak mi napiš,
   koho a co jsi označil.“

Ověřte výsledek v UI (http://localhost:3020/cs, `obchod@demo.ontos` / `password1234`): Úkoly → Všechny,
Příležitosti (filtr Fáze), Nastavení → Štítky (počty a přiřazení). Agent nemá nástroj pro zápis do faktur, změnu
cen ani mazání štítků; přímé volání vrací 403 (`app/scripts/demo/prove-sales-demo.mts`).

Skriptovaná verze téže relace bez modelu (JSON-RPC přes stdio, přepis do `app/docs/demo/agent-session.md`):

```bash
cd app
mise exec -- pnpm exec node tools/ontos-agent-mcp/scripts/demo-session.mts # zapisuje do demo dat: úkol, změna fáze, štítky
```

## Security

- The API key lives only in the process environment or in the gitignored `app/.env.demo.local`.
  Do not paste it into commands, committed files, or chat.
- The server never returns the API key or assertion tokens in tool output, and it never writes to stdout
  except for MCP frames.
