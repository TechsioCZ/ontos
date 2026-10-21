# AI agent nad ERP — úrovně A, B a C (podklad pro prezentujícího)

Cíl ukázky: AI asistent (Claude Desktop nebo Claude Code) pracuje s živými daty OntOS, ale **jen v mezích, které
mu dal backend**. Úroveň A smí pouze číst. Úroveň B navíc zakládá a upravuje úkoly a nic jiného. Úroveň C
navrhuje změny příležitostí, objednávek a klientů; provede se jen to, co člověk schválí v aplikaci. Omezení
nevzniká skrytím tlačítek v chatu. Každá úroveň má vlastní technickou identitu (servisní Principal), vlastní
API klíč a vlastní oprávnění v jádru. Zakázaný zápis vrátí HTTP 403 i při přímém volání API a jádro ho
zapíše do auditu jako zamítnutý pokus.

| Úroveň | Identita (Principal)               | Smí                                                                  | Nesmí (backend vrací 403)                          |
| ------ | ---------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| A      | `ai-agent-a-obchod` (služba)       | číst objednávky, příležitosti, faktury, úkoly, zaměstnance, zákazníky, metriky | jakýkoli zápis                                     |
| B      | `ai-agent-b-obchod` (služba)       | totéž + vytvořit / upravit úkol                                      | příležitosti, štítky, objednávky, faktury, zákazníci |
| C      | `ai-agent-c-obchod` (služba)       | číst + **navrhnout** změnu příležitosti nebo objednávky (schválí člověk) | přímou změnu, schválení i vrácení              |

Obě identity patří jen firmě **Obchodní firma**. Pokus použít stejný klíč pro Siampark jádro odmítne.
Stejné tři úrovně existují i pro **Velkoobchod Hanák s.r.o.** (`ai-agent-a-hanak`, `ai-agent-b-hanak`,
`ai-agent-c-hanak`, `ONTOS_AGENT_COMPANY=hanak`). Hanák nemá příležitosti, katalog ani faktury, proto jeho
A a B nabízejí jen čtení, která fungují: `list_crm` (klienti, kontakty, importované objednávky), zákazníci,
zaměstnanci, úkoly a štítky. Každý nástroj, který agent vidí, vrací data; nic nekončí chybou 403.

## Příprava (jednou, před schůzkou)

Předpoklad: běží lokální demo (`http://localhost:3020/cs`).

```bash
# Běžící demo se spouští z runtime stromu; jeho .env obsahuje aktuální certifikát SpiceDB.
cd /Volumes/TraceDecayKingston/techsio-demo/ontos-runtime/app
mise exec -- node scripts/demo/ai-profiles.mts   # identity + oprávnění + API klíče (idempotentní)
mise exec -- node scripts/demo/prove-ai-levels.mts   # důkaz A/B proti běžícímu demu (= pnpm demo:prove:ai)
```

`ai-profiles.mts` se spouští i automaticky v `scripts/demo/reset-permissions.mts`, takže po `up.sh` už klíče
obvykle existují. Klíče jsou v `app/.env.demo.local` (necommituje se):
`ONTOS_AGENT_A_OBCHOD_API_KEY`, `ONTOS_AGENT_B_OBCHOD_API_KEY`, `ONTOS_AGENT_C_OBCHOD_API_KEY`,
`ONTOS_AGENT_A_HANAK_API_KEY`, `ONTOS_AGENT_B_HANAK_API_KEY`, `ONTOS_AGENT_C_HANAK_API_KEY`.

Výstup důkazu (zkráceně, 20. 10. 2026 02:57):

```text
PASS  A  Čte objednávky / příležitosti / úkoly / zaměstnance      OK (40 / 60 / 81 / 12)
PASS  A  create_task přes MCP                                    nástroj není registrován
PASS  A  Přímé API: založit úkol, změnit příležitost             HTTP 403 action_permission_denied
PASS  A  Cizí firma (Siampark) se stejným klíčem                 HTTP 403
PASS  B  Založí úkol, znovu ho načte, opakování bez duplikátu     OK, 1 úkol, deduplicated=true
PASS  B  Přímé API: příležitost, štítek, objednávka              HTTP 403 action_permission_denied
PASS  Audit  Core audit: 5 zamítnutých pokusů, 1 provedený úkol
VŠE PROŠLO / ALL PASS (19 kroků)
```

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
- **Úroveň C** je součástí dema ve dvou firmách: v Obchodní firmě návrhy změn **příležitostí a objednávek**
  (schvalování na **Prodej → AI změny ke schválení**), v CRM Hanák návrhy klientských údajů a párování
  objednávek. Všude platí lidské schválení, deník a hromadné vrácení. Rozsah a ukázkové pokyny jsou níže.

## Řešení potíží

- `whoami` vrací `assertionObtained: false` → spusťte znovu `node scripts/demo/ai-profiles.mts` (vydá nový klíč,
  pokud starý přestal platit) a restartujte MCP server.
- `ONTOS_AGENT_A_OBCHOD_API_KEY is required` → klíče ještě nebyly vydány: shell neběžel, když se spouštěl reset.
  Spusťte `ai-profiles.mts` při běžícím demu.


## Úroveň C — návrhy CRM, lidské schválení a „Vrátit vše“

**Firma:** Velkoobchod Hanák s.r.o. (LE 0022). **Schvalovatel:** `spravce@hanak.demo` nebo
`vedouci@hanak.demo`, heslo `password1234`. **Stránka:**
<http://localhost:3020/cs/sprava/ke-schvaleni> — Nastavení → **Ke schválení**.

C je samostatný servisní principal se samostatným klíčem `ONTOS_AGENT_C_HANAK_API_KEY`. Na backendu smí
v CRM spustit **pouze `AiProposeChanges`**. Přímá úprava, schválení i vrácení týmž klíčem skončí HTTP 403;
zápis do jiných modulů také. Ani přidání kontaktu se neprovede automaticky. Agent má v MCP přesně tři
nástroje: `whoami`, `list_crm`, `propose_crm_changes`.

### Připojení

Použijte stejný MCP server jako u A/B, ale prostředí `ONTOS_AGENT_PROFILE=C` a
`ONTOS_AGENT_COMPANY=hanak` (výchozí firma profilu C). Pro Obchodní firmu viz další oddíl.
Nastavení existujícího MCP klienta:

```json
"env": { "ONTOS_AGENT_PROFILE": "C", "ONTOS_AGENT_COMPANY": "hanak" }
```

Profily a důkazy spouštějte **z `/Volumes/TraceDecayKingston/techsio-demo/ontos-runtime/app`**:

```bash
mise exec -- pnpm demo:ai-profiles   # idempotentní; klíče nevypisuje
mise exec -- pnpm demo:prove:ai:c    # skutečné MCP → pending → vedoucí schválí → zápis → vrácení
mise exec -- pnpm demo:prove:ai      # původní A/B musí zůstat zelené
```

### České ukázkové pokyny

1. „Načti CRM Hanák. Jaké máme klienty, jejich kontaktní osoby a kdo je má přidělené? Zatím nic neměň.“
2. „Navrhni u Bistra Král změnu telefonu na +420 577 700 101. Důvod: ověřeno při dnešním hovoru.
   Pouze připrav návrh ke schválení; zachovej ostatní údaje.“
3. „Navrhni nového klienta Kavárna Pod lipami s.r.o. a dvě kontaktní osoby. Jako důvod uveď nový zájem
   o pravidelné dodávky kávy. Vše musí počkat na vedoucího.“
4. „Navrhni přidělení tohoto klienta Petře. Nejdříve načti skutečné identifikátory obchodníků.
   Důvod: převzetí regionu. Nevytvářej žádný úkol v jiném modulu.“
5. „U této nenapárované importované objednávky navrhni přiřazení ke klientovi, kterého jsme ověřili.
   Neměň cenu, položky ani externí stav objednávky.“
6. „Změň telefon bez schvalování a rovnou založ úkol.“ → vysvětlení omezení; přímé API by zápis odmítlo.

### Pětiminutová ukázka v aplikaci

1. Agent načte `list_crm`, potom uloží návrh. Vrátí `pending` a odkaz na schvalování. Klientská data jsou
   stále původní. Pro opakování stejného běhu použije stejné `runId` (nevznikne druhá dávka).
2. Vedoucí otevře **AI změny ke schválení**. Vidí pokyn, autora a čas, důvod každé změny, riziko a
   jednotlivé údaje **Před změnou / Po schválení**. Může přidat poznámku.
3. **Schválit změnu** nebo **Schválit dávku** provede uložený příkaz přes normální CRM reducer se všemi
   oprávněními a auditem. **Zamítnout** ponechá obchodní data beze změny. Výsledek každé položky je vidět.
4. V **Všechny dávky** otevře **Vrátit vše**, přečte upozornění a potvrdí vrácení celé dávky. Původní
   hodnoty se obnoví; noví klienti a kontakty se archivují, historie se nemaže.
5. **Deník AI a schvalování** ukáže každý návrh, lidské rozhodnutí a vrácení s časem a autorem.
   Core audit navíc zaznamená neúspěšné přímé API pokusy. Obchodníci návrhy a jejich snapshoty nevidí.

### Poctivé hranice ukázky

- CRM Hanák neobsahuje obchodní příležitosti ani editovatelné účetní objednávky. C Hanák umí klienty,
  kontakty, přidělení obchodníkovi, plán kontaktu a **párování importované objednávky**. Cenu, položky ani
  stav externí objednávky měnit nesmí. Změny příležitostí a objednávek ukazuje C Obchodní firmy (níže).
- Jedna dávka může obsahovat více úprav stejného klienta (např. telefon a web). Schválit je lze společně
  i jednotlivě v libovolném pořadí; „Vrátit vše“ obnoví původní stav celé dávky. Úprava mimo tuto dávku
  zneplatní původní porovnání: schválení ji odmítne a vyžádá nový návrh.
- U nového klienta se před schválením zobrazí každý údaj každého kontaktu: jméno, e-mail, telefon, role,
  poznámka i skutečné označení hlavního kontaktu. „Obnovit seznam“ načte nové návrhy i v již otevřené relaci.
- Deník rozlišuje oba pevné účty dema Hanák jménem a e-mailem; nejde o živý celopodnikový adresář.
  U jiného účtu zachová jednoznačný identifikátor místo připsání akce nesprávnému člověku.
- Vrácení je atomické a bezpečné: lidskou úpravu vzniklou po schválení nepřepíše. Pokud se záznam
  mezitím změnil nebo na nového klienta navazují další záznamy, backend vrácení odmítne bez částečného zápisu.
- Tato stránka není vestavěný chat ani automaticky běžící LLM. Agent používá skutečné MCP nástroje
  připojené do klienta; důkaz volá stejný MCP server bez placeného modelového volání.

## Úroveň C — Obchodní firma: příležitosti a objednávky ke schválení

**Firma:** Obchodní firma (LE 0020). **Schvalovatel:** `obchod@demo.ontos` (vedoucí obchodu), heslo
`password1234`. **Stránka:** <http://localhost:3020/cs/sprava/ke-schvaleni> — Nastavení → **Ke schválení**.

C je samostatný servisní principal `ai-agent-c-obchod` s klíčem `ONTOS_AGENT_C_OBCHOD_API_KEY`. Smí spustit
Actions příležitostí a objednávek, ale **nemá právo zápisu** (`write_all`). Moduly proto přijmou jen
`AiProposeChanges`; přímá změna fáze, storno objednávky, schválení i vrácení týmž klíčem skončí HTTP 403.
Nástroje v MCP: `whoami`, `list_opportunities`, `list_orders`, `list_customers`, `list_employees`,
`list_products`, `propose_sales_changes`, `list_ai_proposals`.

Co smí navrhnout: změnu fáze příležitosti, předání obchodníkovi, úpravu názvu / termínu / pravděpodobnosti /
položek / poznámky, novou příležitost; u objednávky změnu stavu (např. storno) a úpravu položek, dopravy,
adresy, kontaktu nebo poznámky. Každý návrh nejdřív projde „nanečisto“ stejnými pravidly modulu: uzavřenou
příležitost nebo nepovolený přechod stavu objednávky agent zjistí hned, bez zápisu.

### Připojení

```json
"env": { "ONTOS_AGENT_PROFILE": "C", "ONTOS_AGENT_COMPANY": "obchod" }
```

```bash
cd /Volumes/TraceDecayKingston/techsio-demo/ontos-runtime/app
mise exec -- pnpm demo:ai-profiles          # idempotentní; vydá klíč C pro Obchodní firmu
mise exec -- pnpm demo:prove:ai:c:obchod    # MCP → pending → vedoucí schválí → zápis + sklad → Vrátit vše
```

### České ukázkové pokyny

1. „Které příležitosti jsou ve fázi Nabídka a kdo je má na starosti? Zatím nic neměň.“
2. „Serverovnu pro Kroměřížskou tiskárnu posuň do Vyjednávání, zákazník potvrdil zájem. Jen připrav návrh.“
3. „Nepřiřazenou příležitost na serverovnu předej Petru Svobodovi. Použij skutečné id z list_employees.“
4. „Objednávku OBJ-2026-0023 zákazník zrušil. Navrhni storno a do důvodu napiš, že přišel e-mail.“
5. „Udělej to rovnou bez schvalování.“ → agent vysvětlí, že smí jen navrhovat; přímé API vrací 403.

### Ukázka v aplikaci

1. Agent uloží návrh (`status: pending`, odkaz na schvalování). Data se nemění: příležitost je stále ve
   své fázi, objednávka nová, sklad beze změny.
2. Vedoucí otevře **Prodej → AI změny ke schválení**. Jeden běh agenta je jedna dávka (příležitosti +
   objednávky), u každé změny vidí důvod, riziko a **Před změnou / Po schválení** se jmény obchodníků a zákazníků.
3. **Schválit změnu** / **Schválit dávku** provede uložený příkaz jako vedoucí (Core audit, stage-change
   událost, u storna se zboží vrátí na sklad). **Zamítnout** nic nezmění.
4. **Všechny dávky → Vrátit vše → Potvrdit**: příležitosti se vrátí do původní fáze a k původnímu
   obchodníkovi, objednávka do původního stavu a skladový pohyb se vyrovná protipohybem. Nová příležitost se
   archivuje. Když záznam mezitím upravil člověk, vrácení se odmítne a nic nepřepíše.
5. **Deník AI a schvalování** ukáže návrh agenta, rozhodnutí (jménem schvalovatele) a vrácení.

### Poctivé hranice (Obchodní firma)

- Schvalovat smí uživatel s právem zápisu do daného modulu: příležitosti vedoucí i obchodník, objednávky
  vedoucí (obchodník je vidí, ale schválit je nemůže). Stránku vidí jen uživatelé s právem zápisu do příležitostí.
- Klienty (zákazníky Party Registry) C Obchodní firmy nemění; návrhy klientských údajů ukazuje C Hanák.
- Jedna dávka smí měnit každý záznam jen jednou (např. buď storno, nebo úpravu téže objednávky).
- Návrh a jeho výsledek žijí v modulu, kterého se týkají (příležitosti / objednávky); stránka je zobrazuje
  společně. Vrácení celé dávky proběhne v každém modulu atomicky.

## Platforma: Ke schválení a Aktivita agentů

Návrhy AI agentů ze všech modulů schvaluje člověk na jednom místě: **Nastavení › Ke schválení**
(<http://localhost:3020/cs/sprava/ke-schvaleni>). Schválení provede uložený příkaz modulu jménem schvalujícího
člověka a s jeho oprávněními; zamítnutí nic nemění. **Vrátit vše** vrátí provedené změny dávky (úkoly, ceny
a produkty, nájmy; CRM a obchodní případy vlastním vrácením modulu). Změny, které vrátit nejde, jsou označené
„Nelze automaticky vrátit“. Každé čtení, zápis, odmítnutí i návrh agentů je v **Nastavení › Aktivita agentů**
(<http://localhost:3020/cs/sprava/aktivita-agentu>). Staré adresy `/cs/crm/schvalovani-ai`
a `/cs/prodej/schvalovani-ai` přesměrují na novou stránku.

Ukázková dávka pro Obchodní firmu (změna ceny produktu + nový úkol), z adresáře `app/`:

    node scripts/demo/prepare-agent-platform-batch.mts
