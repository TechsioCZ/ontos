# Finální review integrační větve — 30. 10. 2026

Pozdější aktualizace na `bf9a05e5e` a její nové výsledky jsou v [následném upstream syncu](UPSTREAM-SYNC-2026-10-30.md).

Navazuje na [audit převodu](FE-TRANSFER-AUDIT-2026-10-29.md) a [provedené FE opravy](FE-TRANSFER-FIXES-2026-10-30.md). Vizuální reference je původní `feat/akros` na `f1b74b02aa9ca978300a88189721c7813ef02e06`.

## Aktualizace upstreamu

Do `demo/sales-crm-updated` jsou začleněné změny `demo/sales-crm` do `49698e91688c85f35c6a1656eb18968182d69de9`, navazující na náš commit `4a3093392`. Update zachovává nativní backendové napojení a doplňuje mimo jiné nové opravy newsletteru a CI.

Jediný konflikt byl v browser adaptéru. Zůstává přenositelný výchozí `playwright-core`, Windows cesty a původní úklid prostředků; převzatá oprava navíc podporuje skutečný CommonJS export `@playwright/test`, jehož `default` je funkce s připojeným launcherem. Validace původní SDK objekt nekopíruje. Testy pokrývají pojmenovaný export, objektový default i funkční default.

## Vizuální kontrola

- Kategorie, účet, košík a shrnutí: **60 layoutů na 15 šířkách**, žádné zachycené vodorovné přetékání ani chyby JavaScriptu.
- **30/30 porovnání ovladačů množství** je rozměrově shodných s referencí; snímky byly zkontrolované také vizuálně.
- **48 interakčních kontrol** prošlo: telefon včetně celé hodnoty na 320 px, poloha newsletteru, rozměry a skutečné odeslání filtrů, hlášky pod akcemi, blokace pokračování při výpadku či změně ceny a obnovení pokračování po retry/přijetí ceny.
- [Aktuální porovnávací galerie](test-results/visual-parity/final-review-layouts-20261030/index.html) má funkční přepínání 390 / 768 / 1440 px, bez chyb a chybějících obrázků.
- Testovací odpovědi API existují jen v izolovaném harnessu. Kontrola neprováděla živé zápisy objednávek ani neověřovala doručení e-mailů. Izolovaný server byl po kontrole zastavený.

## Opravy validačního prostředí

Windows importy generovaných testovacích konfigurací a Node preload hooků používají `file:` URL. Cesty vložené do TypeScript fixture používají lomítka. CRLF referenčního teardown příkladu se před textovými mutacemi normalizuje na LF; negativní příklady nyní výslovně ověřují, že se opravdu liší od validní reference. Pozitivní a negativní aserce zůstávají zachované.

Dependency-free CI skripty používají nativní `Error.isError`; očekávaná closure chyba se rozpoznává podle svého existujícího názvu. Testy planneru si před voláním příkazů rozliší absolutní cestu k nainstalovanému Gitu místo unixové cesty `/usr/bin/git`. Konfigurace pravidel, jejich závažnosti ani Git hooky se kvůli těmto opravám nemění.

U 84 přijatých souborů se změnily pouze konce řádků CRLF → LF; formátovací kontrola těchto souborů následně prošla. Obsahový diff mimo vlastní opravy nevznikl.

## Validace

- CI planner, stage-edge a browser adaptér: **36/36 testů prošlo**.
- Cílený lint opravených souborů prošel.
- Kontrola storefrontu: **545/545 testů, formát, lint, TypeScript i produkční build prošly**. Dosavadní lint a Next konfigurační varování zůstávají viditelná.
- Skutečné Chromium ověřilo sloučený adaptér ve výchozím režimu i s absolutní Windows cestou; oba prohlížeče se po kontrole zavřely.
- Plná workspace kontrola: **322/322 lint-rule testů a 144/144 Action runtime testů prošlo**. Původních deset selhání je odstraněno. Příkaz dále skončil neúspěšně v `database-access:check`, který hlásí globální databázové capabilities v Action handlerech `commerce-customer-context`, `commerce-market-catalog` a `storefront-registry`. Kontrolní skript, celé tyto tři verticaly i `packages/core-runtime` jsou obsahově shodné s převzatým upstreamem `49698e91688c85f35c6a1656eb18968182d69de9`; tento převod je nemění. Pozdější fáze `pnpm check` se nespustily. Draft není připravený k merge bez vyřešení tohoto backendového gate.

Test úklidu prostředků měl nestabilní desetisekundový limit zahrnující také studený start Node a načtení SDK. Nyní mají úspěch, selhání a přerušení samostatné testy. Desetisekundový limit samotného ukončení začíná po importech přímo v podprocesu; start podprocesu má samostatný limit 120 sekund odpovídající rozpočtu testovacího prostředí. Kontroly pořadí asynchronního úklidu a návratových kódů 0/1/130 zůstávají zachované. Všech osm testů souboru i cílený lint prošly; závěrečný běh celé sady je evidován výše.

První úplná storefront sada znovu zachytila dříve evidované čekání na tlačítko v prvním recovery scénáři. Recovery fixture nyní přes `act` dokončí první odpověď ověření košíku a související React efekty před hledáním tlačítka. Timeouty, produkční kód a aserce recovery se nemění. Samostatně prošlo všech 33 recovery scénářů a následně všech 545 testů i build v úplné storefront gate.

Logy jsou lokálně v `test-results/visual-parity/final-review-*-20261030.log`; galerie, snímky a pomocné harnessy jsou ignorované Gitem.

## Zbývající funkční závislosti

Hmotnost konkrétní varianty za prodejní jednotku a součet košíku, zákaznická správa uložených adres, přímá změna hesla, skutečné hlídání dostupnosti a globální filtr období objednávek zůstávají otevřené. Poslední upstream update pro ně nepřidal potřebné zákaznické kontrakty. Obnova hesla přes e-mail má backendový kontrakt, ale je samostatný dosud nevystavený FE tok.

Známé varování React `key` ve skupinovém našeptávači UI-kitu je reprodukovatelné i v původní referenci a zůstává samostatným bodem.
