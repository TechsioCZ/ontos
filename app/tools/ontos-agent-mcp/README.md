# @ontos/agent-mcp

One MCP gateway for the whole OntOS app. Tools are generated from the **active composition**: every module's governed
reads and Actions (from `app/verticals/<app>/shared/apis` contracts, JSON Schema from Effect Schemas). The tool list is
filtered by the principal's real grants. Every call goes through the shell gateway and the normal Actions, so the
backend enforces permissions and writes the Core audit.

Generic tools (always present):

- `ontos_list_capabilities`: what this principal may read or do, per company and module, plus the write policy.
- `ontos_describe`: Czech title and description, plus the input JSON Schema of an id.
- `ontos_read`: any permitted read (params `id`, `input`, `legalEntityId`, `limit`, `offset`).
- `ontos_execute`: only listed when the principal can write (params `id`, `input`, `legalEntityId`, `reason`, `idempotencyKey`).
- `ontos_switch_company`: only when the principal belongs to several companies.

Typed tools exist for the current company only: `<app_id>__read_<slug>` and `<app_id>__<command>`, for example
`siampark_work__create_task`. Ids look like `siampark.work/command/CreateTask` and `siampark.work/read/records`.

Write policy is `direct` or `approval`. With `approval` (zápis jen přes schválení), `ontos_execute` and the typed
write tools only submit a proposal. The proposal goes to platform approvals when present, otherwise to the module's
`AiProposeChanges`, and is approved on `/cs/crm/schvalovani-ai` or `/cs/prodej/schvalovani-ai`.

## Tokens

Agent tokens and personal (human) tokens are Shell API keys (Better Auth). Send them as
`Authorization: Bearer <token>`. Never commit tokens.

## Remote HTTP server

```bash
cd app && mise exec -- pnpm --dir tools/ontos-agent-mcp start:http
```

- MCP endpoint (Streamable HTTP): `http://127.0.0.1:3090/mcp`
- Health: `http://127.0.0.1:3090/healthz`

| Variable                        | Default                        | Purpose                                                                                       |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `ONTOS_MCP_HTTP_PORT`           | `3090`                         | Port of the HTTP server                                                                       |
| `ONTOS_MCP_HTTP_HOST`           | `127.0.0.1`                    | Bind address                                                                                  |
| `ONTOS_MCP_ALLOWED_HOSTS`       | none                           | Comma list of extra accepted `Host` headers, for example a tunnel hostname                    |
| `ONTOS_MCP_ALLOW_URL_TOKEN`     | off                            | `1` enables `/mcp/k/<token>` for clients that cannot send headers. The token in the URL is sensitive |
| `ONTOS_MCP_TYPED_TOOLS`         | `all`                          | `all`, `reads` (typed reads only) or `none` (generic tools only)                              |
| `ONTOS_SHELL_URL`               | `http://localhost:3020`        | Shell origin (see the legacy table below)                                                     |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL` | `http://127.0.0.1:3041/active` | Composition publisher (see the legacy table below)                                  |

## Claude Code

```bash
claude mcp add --transport http ontos http://127.0.0.1:3090/mcp --header "Authorization: Bearer <token>"
```

Stdio alternative: the existing `command` entry (see the legacy section below). It now exposes the generic tools too.

## Claude Desktop

Stdio entry for `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ontos": {
      "command": "/Users/satan/.local/share/mise/installs/node/26.7.0/bin/node",
      "args": ["--no-warnings", "/Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app/tools/ontos-agent-mcp/src/server.ts"],
      "env": { "ONTOS_AGENT_API_KEY": "<token>" }
    }
  }
}
```

Or the HTTP server through `mcp-remote`:

```json
{
  "mcpServers": {
    "ontos-http": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3090/mcp", "--header", "Authorization:${ONTOS_AUTH}"],
      "env": { "ONTOS_AUTH": "Bearer <token>" }
    }
  }
}
```

## ChatGPT

ChatGPT needs a **public HTTPS URL**. Enable Developer mode (Settings → Apps & Connectors → Advanced → Developer mode),
then choose Create connector.

Tunnel option (documentation only):

```bash
cloudflared tunnel --url http://127.0.0.1:3090      # or: ngrok http 3090
ONTOS_MCP_ALLOW_URL_TOKEN=1 ONTOS_MCP_ALLOWED_HOSTS=<host>.trycloudflare.com \
  mise exec -- pnpm --dir tools/ontos-agent-mcp start:http
```

Connector URL: `https://<host>.trycloudflare.com/mcp/k/<token>`. Authentication: "No authentication" (the token is in the URL).

**Do not start a public tunnel for the demo without explicit approval. Revoke the token after the session.**

## Proofs

Run from `app/` against the running demo:

- `mise exec -- pnpm demo:prove:mcp`: human and agent tokens over HTTP with the official MCP SDK client. Covers capabilities, reads from 6 verticals, one allowed write, one denied write, and the Core audit.
- `mise exec -- pnpm demo:prove:ai`, `demo:prove:ai:c`, `demo:prove:ai:c:obchod`: approval-policy proofs.

---

## Česky: jak OntOS ovládat přes MCP

### 1. Co to je

Jedna MCP brána pro celou aplikaci OntOS. Nástroje se generují z **aktivní kompozice**: každý modul nabízí chráněná čtení
a Actions (z kontraktů `app/verticals/<app>/shared/apis`, JSON Schema vzniká z Effect Schemas). Seznam nástrojů se filtruje
podle skutečných oprávnění účtu. Každé volání jde přes shell bránu a běžné Actions, takže oprávnění hlídá backend a zápis
se ukládá do auditu Core.

Obecné nástroje (vždy dostupné):

- `ontos_list_capabilities`: co tento účet smí číst nebo dělat, po firmách a modulech, včetně zásady zápisu.
- `ontos_describe`: český název a popis, plus vstupní JSON Schema zadaného id.
- `ontos_read`: libovolné povolené čtení (parametry `id`, `input`, `legalEntityId`, `limit`, `offset`).
- `ontos_execute`: je k dispozici jen tehdy, když účet smí zapisovat (parametry `id`, `input`, `legalEntityId`, `reason`, `idempotencyKey`).
- `ontos_switch_company`: jen když účet patří do více firem.

Typované nástroje platí jen pro aktuální firmu: `<app_id>__read_<slug>` a `<app_id>__<command>`, například
`siampark_work__create_task`. Id mají tvar `siampark.work/command/CreateTask` a `siampark.work/read/records`.

Zásada zápisu je `direct` (přímý zápis) nebo `approval` (zápis jen přes schválení). Při `approval` nástroj `ontos_execute`
i typované zápisové nástroje jen podají návrh. Návrh jde do platformních schválení, pokud existují, jinak do `AiProposeChanges`
modulu, a schvaluje se na `/cs/crm/schvalovani-ai` nebo `/cs/prodej/schvalovani-ai`.

### 2. Tokeny

Agentské tokeny a osobní (lidské) tokeny jsou klíče API shellu (Better Auth). Posílejte je jako
`Authorization: Bearer <token>`. Tokeny nikdy nepište do repozitáře.

### 3. Vzdálený HTTP server

```bash
cd app && mise exec -- pnpm --dir tools/ontos-agent-mcp start:http
```

- Koncový bod MCP (Streamable HTTP): `http://127.0.0.1:3090/mcp`
- Kontrola stavu: `http://127.0.0.1:3090/healthz`

| Proměnná                                    | Výchozí                        | Účel                                                                                                  |
| ------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ONTOS_MCP_HTTP_PORT`                       | `3090`                         | Port HTTP serveru                                                                                     |
| `ONTOS_MCP_HTTP_HOST`                       | `127.0.0.1`                    | Adresa, na které server naslouchá                                                                     |
| `ONTOS_MCP_ALLOWED_HOSTS`                   | žádná                          | Seznam dalších povolených hlaviček `Host` oddělený čárkami, např. název tunelu                        |
| `ONTOS_MCP_ALLOW_URL_TOKEN`                 | vypnuto                        | `1` zapne `/mcp/k/<token>` pro klienty, které nemohou posílat hlavičky. Token v URL je citlivý        |
| `ONTOS_MCP_TYPED_TOOLS`                     | `all`                          | `all`, `reads` (jen typovaná čtení) nebo `none` (jen obecné nástroje)                                 |
| `ONTOS_SHELL_URL`                           | `http://localhost:3020`        | Adresa shellu (viz původní tabulka níže)                                                              |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL`  | `http://127.0.0.1:3041/active` | Publikátor kompozice (viz původní tabulka níže)                                                       |

### 4. Claude Code

```bash
claude mcp add --transport http ontos http://127.0.0.1:3090/mcp --header "Authorization: Bearer <token>"
```

Alternativa přes stdio: stávající příkaz `command` (viz původní část níže). Nově nabízí i obecné nástroje.

### 5. Claude Desktop

Záznam stdio pro `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ontos": {
      "command": "/Users/satan/.local/share/mise/installs/node/26.7.0/bin/node",
      "args": ["--no-warnings", "/Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app/tools/ontos-agent-mcp/src/server.ts"],
      "env": { "ONTOS_AGENT_API_KEY": "<token>" }
    }
  }
}
```

Nebo HTTP server přes `mcp-remote`:

```json
{
  "mcpServers": {
    "ontos-http": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3090/mcp", "--header", "Authorization:${ONTOS_AUTH}"],
      "env": { "ONTOS_AUTH": "Bearer <token>" }
    }
  }
}
```

### 6. ChatGPT

ChatGPT potřebuje **veřejnou adresu HTTPS**. Zapněte vývojářský režim (Nastavení → Aplikace a konektory → Upřesnit →
Vývojářský režim) a poté zvolte Vytvořit konektor.

Možnost s tunelem (jen dokumentace):

```bash
cloudflared tunnel --url http://127.0.0.1:3090      # nebo: ngrok http 3090
ONTOS_MCP_ALLOW_URL_TOKEN=1 ONTOS_MCP_ALLOWED_HOSTS=<host>.trycloudflare.com \
  mise exec -- pnpm --dir tools/ontos-agent-mcp start:http
```

Adresa konektoru: `https://<host>.trycloudflare.com/mcp/k/<token>`. Ověřování: „Bez ověřování“ (token je v URL).

**Pro demo nespouštějte veřejný tunel bez výslovného schválení. Po skončení relace token zrušte.**

### 7. Důkazy funkčnosti

Spouštějte z `app/` proti běžícímu demu:

- `mise exec -- pnpm demo:prove:mcp`: lidský a agentský token přes HTTP s oficiálním klientem MCP SDK. Ověří možnosti účtu, čtení ze 6 verticals, jeden povolený zápis, jeden zamítnutý zápis a audit Core.
- `mise exec -- pnpm demo:prove:ai`, `demo:prove:ai:c`, `demo:prove:ai:c:obchod`: důkazy pro zásadu schválení.

---

## Původní nástroje (stdio, profily A/B/C)

stdio MCP server that gives a coding agent authenticated access to OntOS verticals through the shell.
Workspace tool installed and validated with the application from `app/`.

### Konfigurace

| Variable                                   | Required | Default                        | Purpose                                                                  |
| ------------------------------------------ | -------- | ------------------------------ | ------------------------------------------------------------------------ |
| `ONTOS_AGENT_API_KEY`                      | yes      | none                           | Shell API key, sent only as `x-api-key` to the shell gateway endpoint    |
| `ONTOS_SHELL_URL`                          | no       | `http://localhost:3020`        | Shell origin                                                             |
| `ONTOS_COMPOSITION_REVISION`               | no       | from the publisher             | Live release revision (64 hex). The shell rejects other values           |
| `ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL` | no       | `http://127.0.0.1:3041/active` | Composition publisher; supplies the revision when it is missing or stale |
| `ONTOS_LEGAL_ENTITY_ID`                    | no       | none                           | UUID of the legal entity to scope assertions to                          |
| `ONTOS_AGENT_PROFILE`                      | no       | none (legacy `agent-bot`)      | `A` read-only, `B` reads + tasks, `C` proposals a person approves       |
| `ONTOS_AGENT_COMPANY`                      | no       | `obchod` (C: `hanak`)          | `obchod` or `hanak`; picks `ONTOS_AGENT_<A\|B\|C>_<COMPANY>_API_KEY`      |

With `ONTOS_AGENT_PROFILE` the key comes from `ONTOS_AGENT_<PROFILE>_<COMPANY>_API_KEY` (never the broader legacy
key) and the legal entity from the company. Only tools whose reads work with that company's grants are registered
(`src/profiles.ts`). Level C: Hanák proposes CRM changes (`propose_crm_changes`, approved on `/crm/schvalovani-ai`);
Obchodní firma proposes opportunity and order changes (`propose_sales_changes`, `list_ai_proposals`, approved on
`/prodej/schvalovani-ai`). Principals, grants and keys: `scripts/demo/ai-profiles.mts`; proofs against the running
demo: `pnpm demo:prove:ai`, `demo:prove:ai:c`, `demo:prove:ai:c:obchod`; presenter guide:
`app/docs/demo/AI_AGENT_DEMO.cs.md`.

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

### Run

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

### Demo s Claude (stdio)

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

### Security

- The API key lives only in the process environment or in the gitignored `app/.env.demo.local`.
  Do not paste it into commands, committed files, or chat.
- The server never returns the API key or assertion tokens in tool output, and it never writes to stdout
  except for MCP frames.
