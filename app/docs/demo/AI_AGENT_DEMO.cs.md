# AI agent nad ERP — úrovně A a B (podklad pro prezentujícího)

Cíl ukázky: AI asistent (Claude Desktop nebo Claude Code) pracuje s živými daty OntOS, ale **jen v mezích, které
mu dal backend**. Úroveň A smí pouze číst. Úroveň B navíc zakládá a upravuje úkoly a nic jiného. Omezení
nevzniká skrytím tlačítek v chatu. Každá úroveň má vlastní technickou identitu (servisní Principal), vlastní
API klíč a vlastní oprávnění v jádru. Zakázaný zápis vrátí HTTP 403 i při přímém volání API a jádro ho
zapíše do auditu jako zamítnutý pokus.

| Úroveň | Identita (Principal)               | Smí                                                                  | Nesmí (backend vrací 403)                          |
| ------ | ---------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| A      | `ai-agent-a-obchod` (služba)       | číst objednávky, příležitosti, úkoly, zaměstnance, zákazníky, metriky | jakýkoli zápis                                     |
| B      | `ai-agent-b-obchod` (služba)       | totéž + vytvořit / upravit úkol                                      | příležitosti, štítky, objednávky, faktury, zákazníci |

Obě identity patří jen firmě **Obchodní firma**. Pokus použít stejný klíč pro Siampark jádro odmítne.
Až bude hotové CRM Velkoobchodu Hanák (`demo.crm`), vzniknou stejné dvě identity i pro tuto firmu
(`ONTOS_AGENT_COMPANY=hanak`).

## Příprava (jednou, před schůzkou)

Předpoklad: běží lokální demo (`http://localhost:3020/cs`).

```bash
cd /Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app
mise exec -- node scripts/demo/ai-profiles.mts   # identity + oprávnění + API klíče (idempotentní)
mise exec -- pnpm demo:prove:ai                  # důkaz A/B proti běžícímu demu, tabulka PASS/FAIL
```

`ai-profiles.mts` se spouští i automaticky v `scripts/demo/reset-permissions.mts`, takže po `up.sh` už klíče
obvykle existují. Klíče jsou v `app/.env.demo.local` (necommituje se):
`ONTOS_AGENT_A_OBCHOD_API_KEY`, `ONTOS_AGENT_B_OBCHOD_API_KEY`.

## Připojení Claude Code

```bash
NODE=/Users/satan/.local/share/mise/installs/node/26.7.0/bin/node
SERVER=/Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app/tools/ontos-agent-mcp/src/server.ts
claude mcp add ontos-ai-a -e ONTOS_AGENT_PROFILE=A -e ONTOS_AGENT_COMPANY=obchod -- "$NODE" --no-warnings "$SERVER"
claude mcp add ontos-ai-b -e ONTOS_AGENT_PROFILE=B -e ONTOS_AGENT_COMPANY=obchod -- "$NODE" --no-warnings "$SERVER"
claude mcp list            # oba servery: ✔ Connected
```

Pro čistou ukázku mějte v jedné relaci připojený vždy jen jeden profil (`claude mcp remove ontos-ai-b` apod.).

## Připojení Claude Desktop

Soubor `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ontos-ai-a": {
      "command": "/Users/satan/.local/share/mise/installs/node/26.7.0/bin/node",
      "args": [
        "--no-warnings",
        "/Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app/tools/ontos-agent-mcp/src/server.ts"
      ],
      "env": { "ONTOS_AGENT_PROFILE": "A", "ONTOS_AGENT_COMPANY": "obchod" }
    },
    "ontos-ai-b": {
      "command": "/Users/satan/.local/share/mise/installs/node/26.7.0/bin/node",
      "args": [
        "--no-warnings",
        "/Volumes/TraceDecayKingston/techsio-demo/ontos-demo/app/tools/ontos-agent-mcp/src/server.ts"
      ],
      "env": { "ONTOS_AGENT_PROFILE": "B", "ONTOS_AGENT_COMPANY": "obchod" }
    }
  }
}
```

Po uložení Claude Desktop restartujte. V nastavení konektorů pak zapínejte vždy jen jeden z nich.

## Co ukázat (scénář cca 6 minut)

### 1. Úroveň A — „asistent, který jen čte“

Zapnutý jen `ontos-ai-a`.

1. „Kdo jsi a co smíš?“ → nástroj `whoami`: profil A, firma Obchodní firma, seznam čtecích nástrojů.
2. „Jaké máme otevřené příležitosti ve fázi Vyjednávání a kolik dohromady stojí? Seřaď je podle hodnoty.“
3. „Které objednávky za poslední měsíc jsou nad 100 000 Kč a pro koho?“
4. „Jaké úkoly má po termínu obchodník s největší rozpracovanou příležitostí?“
5. „Založ mu úkol, ať zítra zákazníkovi zavolá.“ → **AI odmítne**: nástroj pro zápis nemá.

Pointa: data z ERP se dají volně rozebírat v chatu, ale tento asistent nic nezmění.

### 2. Důkaz, že nejde jen o skrytý nástroj

V terminálu: `mise exec -- pnpm demo:prove:ai`. Ukažte řádky
`[A] Přímé API: založit úkol — HTTP 403 action_permission_denied` a `Core audit: zamítnuté pokusy`.
Stejný klíč použitý mimo MCP backend odmítne a jádro to zapíše do auditu.

### 3. Úroveň B — „asistent, který zakládá úkoly“

Zapnutý jen `ontos-ai-b`.

1. „Vytvoř úkol pro obchodníka, který má na starosti největší příležitost ve vyjednávání: ať do pátku zavolá
   zákazníkovi kvůli nabídce. Priorita vysoká, připoj zákazníka i příležitost.“
2. V UI (`http://localhost:3020/cs`, `obchod@demo.ontos` / `password1234`) otevřete **Úkoly → Všechny**:
   nový úkol tam je (popis uvádí, že ho založil AI agent).
3. „Posuň termín toho úkolu na pondělí.“ → `update_task` projde.
4. „Teď tu příležitost přesuň do fáze Nabídka a dej zákazníkovi štítek VIP.“ → **AI odmítne**: na
   příležitosti ani štítky oprávnění nemá. Zkusí-li to přímo přes API, backend vrátí 403 (řádky `[B]` v důkazu).

### 4. AI aktivita v aplikaci

V UI otevřete **Zaměstnanci** (`http://localhost:3020/cs/prodej/zamestnanci`, `obchod@demo.ontos`) a sjeďte
na sekci **AI aktivita**. Je to živý výpis Core auditu pro AI agenty v této firmě: čas, agent (štítek Úroveň A
nebo B), akce (např. „Úkoly · zápis“), výsledek (Provedeno nebo Zamítnuto) a důvod („chybí oprávnění
k zápisu“). Seznam se sám obnovuje každých 10 s, takže úkol založený v chatu se tu objeví bez obnovení stránky.

### 5. Bezpečnost opakování

Když model omylem pošle stejný požadavek dvakrát (výpadek sítě, opakované volání nástroje), úkol vznikne jen
jednou. `create_task` posílá stabilní idempotency key: `requestId` z chatu, jinak otisk polí úkolu a dnešního
data. Druhé volání vrátí `deduplicated: true` a existující úkol. Důkaz: řádek
`[B] Opakované volání se stejným requestId`.

## Na co se mohou zeptat

- **Kde je hranice?** V jádru OntOS. Oprávnění nesou granty Principalu (SpiceDB): přístup k modulům, čtecí
  oprávnění a právo spouštět Actions. Úroveň A nemá právo spustit žádnou Action. Úroveň B může spustit jen Actions modulu úkolů.
- **Dá se to zpětně dohledat?** Ano. Každý povolený i zamítnutý pokus je v Core auditu s identitou agenta,
  akcí, firmou, výsledkem a časem.
- **Úroveň C** (změny objednávek a klientů se schvalováním a hromadným vrácením) zatím není součástí dema.
  Úrovně A a B ukazují, že jde o rozšíření stejného modelu oprávnění, ne o nový systém.

## Řešení potíží

- `whoami` vrací `assertionObtained: false` → spusťte znovu `node scripts/demo/ai-profiles.mts` (vydá nový klíč,
  pokud starý přestal platit) a restartujte MCP server.
- `ONTOS_AGENT_A_OBCHOD_API_KEY is required` → klíče ještě nebyly vydány: shell neběžel, když se spouštěl reset.
  Spusťte `ai-profiles.mts` při běžícím demu.
