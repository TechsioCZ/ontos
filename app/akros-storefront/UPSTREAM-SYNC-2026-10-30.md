# Aktualizace sales CRM po finálním FE review

Integrační větev `demo/sales-crm-updated` navazuje na `90589978070f95234aabb52eb742ab9e30725e5e` a začleňuje dalších 49 upstream commitů do `bf9a05e5eee3d2678c9c9571d2d906b34a250116` (30. 10. 2026, 12:41 CET). Předchozí výsledky jsou v [finálním FE review](FINAL-REVIEW-2026-10-30.md); níže je nové ověření po této aktualizaci.

## Převzaté změny a řešení konfliktů

Upstream přidává objednání bez registrace a jeho potvrzení, opravy prvního databázového připojení a velikosti connection poolů, oprávnění a výkon administrace. Zároveň přechází na společný Zerops app host a odstraňuje staré Cloudflare a samostatné deployment pipeline. Nové patche, manifesty a automaticky sloučený lockfile zůstávají z upstreamu.

- Čtyři konflikty modify/delete ve starých CI skriptech a jejich testu se řeší odstraněním podle upstreamu. Naše dřívější Windows opravy těchto již nepoužívaných souborů se nevracejí.
- Shrnutí objednávky zachovává novou možnost objednat bez účtu, naše rozměry a tokeny tlačítek, popisy pro asistivní technologie a informační/chybové hlášky pod odesláním. Text pro hosta používá existující překladový katalog.
- Test potvrzení zachovává skutečný `CartProvider` přihlášeného zákazníka i nové scénáře potvrzení hosta.
- Automaticky sloučený checkout dál zobrazuje ověření košíku pod akcemi a zároveň zachovává novou volbu host/přihlášení/registrace.

Frozen instalace prošla po doplnění připnutého Node do Windows PATH instalačního procesu. Instalační skripty a Git hooky zůstaly zapnuté. U 200 převzatých textových souborů se normalizovaly jen konce řádků CRLF → LF, bez obsahového přepisování.

## Ověření checkoutu

- **55/55 cílených testů** prošlo: checkout layout, skutečné odeslání hosta ze shrnutí, recovery scénáře, potvrzení zákazníka/hosta a order route.
- **105 layoutů na 15 šířkách od 320 do 1920 px** prošlo bez vodorovného přetékání a zachycených chyb prohlížeče: košík/adresy/shrnutí přihlášeného zákazníka a volba/adresy/shrnutí/potvrzení hosta.
- Prošel výběr hosta, zachování volby, jedno odeslání, uložení odpovídajícího receipt v sessionStorage a zobrazení jeho stavu a e-mailového panelu. Cizí receipt se nezobrazil. Informační text hosta zůstal pod odesílacím tlačítkem na všech 15 šířkách.
- Snímky mobilního shrnutí, tabletové volby hosta, mobilního potvrzení a desktopových akcí se zkontrolovaly také vizuálně.
- První kompilace nové potvrzovací routy vyvolala v izolovaném Next dev serveru úplný hot reload odesílající stránky. Po přednačtení rout prošel celý průchod; produkční kód se kvůli tomuto testovacímu chování neměnil.

Browser kontrola používá skutečné aktuální komponenty a izolované API odpovědi v ignorovaném QA harnessu. Nevytváří živé objednávky a neprokazuje jejich persistenci ani doručení e-mailů. QA server byl po kontrole zastaven.

## Úplné kontroly

- Úplná storefront kontrola prošla: **518/518 testů v 70 souborech**, formát, lint, TypeScript a produkční Next build. Dosavadní varování zůstávají viditelná. Počet testů odpovídá nové upstream sadě, včetně odstranění testů zrušeného server-timing kódu.
- Plná workspace kontrola: **322/322 lint-rule testů a 144/144 Action runtime testů prošlo**. Následně příkaz skončil neúspěšně v `database-access:check`: zůstává stejných **44 nálezů ve 24 souborech** v `commerce-customer-context`, `commerce-market-catalog` a `storefront-registry`. Kontrolní skript, celé tyto verticaly i `packages/core-runtime` jsou obsahově shodné s novým upstreamem `bf9a05e5e`. Pozdější fáze souhrnného příkazu se nespustily. Tento backendový gate dál brání merge draft PR.

Lokální snímky a logy jsou v ignorovaném `test-results/visual-parity/sync-bf9a05-*`. Existující draft PR zůstává cílený do `demo/sales-crm`; tato aktualizace sama nenasazuje ani neslučuje PR do základní větve.
