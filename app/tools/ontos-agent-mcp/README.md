# OntOS MCP server

## Připojení (pro uživatele)

Stačí vložit URL serveru. Žádný token ani hlavičku `Authorization` nezadáváte. URL je produkční `https://mcp.<doména>/mcp`, lokální `http://localhost:3090/mcp`. Nejdřív se otevře přihlášení do OntOS v prohlížeči a pak obrazovka „Připojit {aplikace} k OntOS“, kde zvolíte firmu, režim „Za mě“ nebo „Za agenta …“, moduly a úroveň přístupu: „Jen čtení“, „Navrhovat změny ke schválení (doporučeno)“ nebo „Provádět změny přímo“. Potvrdíte tlačítkem „Povolit přístup“.

- ChatGPT: Nastavení › Aplikace a konektory › Přidat vlastní MCP server › URL › OAuth
- Claude: Nastavení › Konektory › Přidat vlastní konektor › URL
- Claude Code: `claude mcp add --transport http ontos http://localhost:3090/mcp`, pak v relaci `/mcp` › Authenticate
- VS Code, Cursor: přidejte server podle URL (typ HTTP, bez hlaviček)

Odpojení: Můj profil › Připojené aplikace › Odpojit. Přístup skončí hned při dalším požadavku.

## Nástroje

- `ontos_whoami`: profil připojení, vrací `profile_id`
- `ontos_capabilities`: co smíte číst a dělat podle modulu, včetně vstupního schématu
- `ontos_read`: čtení povolených dat
- `ontos_list_proposals`: přehled navržených změn (vždy dostupné)
- `ontos_execute`, `ontos_propose`: jen když připojení smí zapisovat
- typované nástroje `<modul>__read_*` a `<modul>__<akce>`: nejvýš 40 na připojení, jinak zůstanou jen obecné nástroje

Chyby oprávnění se vracejí jako chyby nástroje s českým textem. HTTP 401 přichází jen u neplatného nebo odvolaného připojení.

## Spuštění lokálně (pro vývojáře)

| Proměnná | Výchozí | Význam |
| --- | --- | --- |
| `ONTOS_OAUTH_ISSUER` | `http://localhost:3020/shell-super-app-api/oauth` | Vydavatel OAuth tokenů |
| `ONTOS_MCP_RESOURCE_URL` | `http://localhost:3090/mcp` | Veřejná URL tohoto serveru (resource) |
| `ONTOS_MCP_CONNECTOR_SECRET` | žádná (povinné) | Tajemství připojení, stejné jako v shellu |
| `ONTOS_SHELL_INTERNAL_URL` | `http://localhost:3020` | Interní adresa shellu |
| `ONTOS_SHELL_PUBLIC_URL` | origin issueru | Veřejný origin shellu |
| `ONTOS_OAUTH_JWKS_URL` | `{issuer}/jwks` | Adresa klíčů pro ověření JWT |
| `ONTOS_MCP_HTTP_HOST` | `127.0.0.1` | Adresa, na které server naslouchá |
| `ONTOS_MCP_HTTP_PORT` | `3090` | Port serveru |
| `ONTOS_MCP_ALLOWED_HOSTS` | žádné | Další povolené hlavičky `Host` (čárkou oddělené) |
| `ONTOS_MCP_ALLOWED_ORIGINS` | žádné | Povolené hlavičky `Origin` (čárkou oddělené) |

Spuštění, z adresáře `app/`:

```bash
mise exec -- pnpm --dir tools/ontos-agent-mcp start:http
```

Kontroly:

```bash
curl -s localhost:3090/healthz
curl -s localhost:3090/.well-known/oauth-protected-resource/mcp
curl -si -X POST localhost:3090/mcp   # očekává se 401 s hlavičkou WWW-Authenticate
```

End-to-end důkaz: `node scripts/demo/prove-mcp-oauth.mts` (výsledky v `v2/qa/mcp-oauth-e2e.json`).

## Interní stdio server (jen pro interní důkazy)

Stdio server `pnpm --dir tools/ontos-agent-mcp start` běží s `ONTOS_AGENT_PROFILE=A|B|C` a `ONTOS_AGENT_COMPANY=obchod|hanak`. Klíče se berou z `app/.env.demo.local`. Uživatelům se nenabízí.

## English

Users connect by pasting only the server URL (production `https://mcp.<domain>/mcp`, local `http://localhost:3090/mcp`). There is no token or Authorization header to copy. The client opens the OntOS login in the browser, then asks the user to choose the company, the acting mode, the modules and the access level (read only, propose changes for approval (recommended), or apply changes directly), and to allow access. Disconnecting is done in Můj profil › Připojené aplikace, and access ends within 30 seconds. The tools are `ontos_whoami`, `ontos_capabilities`, `ontos_read` and `ontos_list_proposals` always, with `ontos_execute` and `ontos_propose` only for connections that may write, plus typed module tools up to 40 per connection. To run locally, start `pnpm --dir tools/ontos-agent-mcp start:http` from `app/` and check `/healthz`, the protected-resource metadata and the 401 challenge. The end-to-end proof is `scripts/demo/prove-mcp-oauth.mts`. The stdio server with profiles A, B or C is internal only, used for proofs and never offered to users.
