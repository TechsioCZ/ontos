# TASK 04 – výpis všech variant

Uživatel 22. 10. 2026 schválil navazující implementaci TASK 04 podle rozboru
v [plánu variant](akros-variants.plan.md). Předchozí detail varianty je v commitu
`35688203`. Tento krok nemění filtry z TASK 05 ani ceny z TASK 06.

## Potvrzený rozsah

- V názvu každého řádku ponechat konkrétní variantu a odkaz na její modal.
  Odstranit samostatně opakovaný název produktového kontejneru.
- Zobrazit všechny odpovídající varianty v existující kitové `DataTable` bez
  stránkování po pěti. Zachovat řazení, SKU, dostupnost, ceny, nákupní minima a balení.
- Zachovat přesný výběr přes `variantIds`, hledání přes `variant` i dosavadní filtry.
- Ověřit celý největší reálný seznam (386 položek), dosažitelnost konce, nákup poslední
  dostupné varianty, modal a návrat fokusu, desktop/tablet/mobil a odezvu ovládání.
  Virtualizaci přidávat pouze po doložení problému a odsouhlasení řešení.

## Výchozí stav a zvolená cesta

`ProductPurchaseForm` omezuje data pomocí `slice` a samostatné `Pagination` po pěti.
Na desktopu navíc v buňce názvu vypisuje `product.name` před odkazem varianty.
Instalovaná `@techsio/ui-kit` 0.56.1 má u `DataTable` stránkování i virtualizaci ve
výchozím stavu vypnuté. První ověřovaná implementace proto předá přímo celý filtrovaný
seznam; nepřidává nové ovládání, vzhledové utility ani tokeny.

Nový komponentový test před změnou selhal na očekávání všech osmi řádků. Kontrola
aktuální GitHub issue přes `gh` není dostupná (HTTP 401); vycházíme z dříve načteného
zadání #1302, místního plánu a aktuálního souhlasu uživatele. GitHub se nemění.

## Ověření

Dokončeno 22. 10. 2026. Implementace odstraňuje pouze opakovaný název, řez dat po pěti
a související stav/ovládání stránkování. Vzhled zůstává na stávající `DataTable`,
props a tokenech; žádné CSS ani tokenové hodnoty se neměnily.

| Oblast                      | Před změnou                | Po změně                                   |
| --------------------------- | -------------------------- | ------------------------------------------ |
| Vruty DIN 7997/A2           | 5 ze 47 variant na stránce | Všech 47 odpovídajících variant            |
| Šrouby DIN 912/A2           | 5 z 386 variant na stránce | Všech 386 odpovídajících variant           |
| Název v desktopovém řádku   | Kontejner a varianta       | Pouze konkrétní varianta                   |
| Přístup k poslední variantě | Přes další stránky         | Přímé posunutí seznamu, modal i klávesnice |

- `npm run check`: formátování, lint, TypeScript, 162 testů v 30 souborech
  a produkční build prošly. Nový komponentový test ověřuje osm variant, jejich
  názvy/SKU a nákup poslední s upraveným množstvím.
- `npm run test:variant-list`: obě reálné skupiny prošly při 1920/1440/1280/1024/
  768/767/390/320 px. Ověřena úplná sada ID, žádné opakování kontejneru, žádný
  horizontální přetok a skutečné posunutí k poslednímu odkazu v každé šířce.
  Test pokrývá nákup poslední dostupné varianty, přesný modal poslední položky
  přes Enter, Escape a návrat fokusu, prázdné filtry a obnovu, přesný sdílený výběr
  i hledání SKU včetně reloadu. Bez runtime chyb nebo chyb hydratace.
- Regresní `variant-table-layout.mjs`: 88 kontrol čtyř produktů na 22 šířkách
  320–1920 px a dalších 12 kontrol dlouhých SKU. Prošly hranice tabulka/seznam/karty,
  čitelnost, rozložení filtrů, ovládání nákupu i kompaktní balení.
- `npm run test:catalog`: 1920/1024/390 px, skutečná minima a balení, úplný výpis,
  obnova filtrů, slider, tokeny i nezměněné stránkování kategorií/vyhledávání.
- `npm run test:variant-detail`: všech osm layoutů, náhled, historie/fokus/reload,
  přímé oblíbené a hlídání, sdílení, konkrétní dotaz a chybějící/neplatná data.

### Měření odezvy

Měřeno v instalovaném desktopovém Chromu proti místnímu produkčnímu `next start`
na portu 3001. Časy zahrnují automatizované ovládání a jeho čekání; nejde o benchmark
fyzického telefonu ani vzdáleného deploye. Přímé načtení mobilní šířky používá nový
dokument po předchozím průchodu, tedy zahřátou cache. Výchozí screenshoty pocházejí
z dev serveru na portu 3000; jeho časy nejsou použity jako srovnatelný benchmark.

| Kontrola                                           | 47 variant | 386 variant |
| -------------------------------------------------- | ---------- | ----------- |
| Načtení seznamu a připravenost akcí na desktopu    | 1267 ms    | 2938 ms     |
| Úprava množství poslední dostupné varianty         | 69 ms      | 220 ms      |
| Nákup a potvrzení přesné položky v lokálním košíku | 111 ms     | 469 ms      |
| Vyprázdnění seznamu filtrem                        | 72 ms      | 233 ms      |
| Obnovení všech variant filtrem                     | 162 ms     | 795 ms      |
| Přímé načtení při 390 px                           | 638 ms     | 2276 ms     |
| Úprava množství při 390 px                         | 43 ms      | 148 ms      |

V rámci ověřeného dema není doložený důvod pro virtualizaci nebo postupné načítání;
seznam zůstává celý v DOM. Screenshoty začátku a konce seznamu a report jsou v
ignorovaném `test-results/variant-list/`; desktop, tablet a mobil byly vizuálně
zkontrolované. Další v původním pořadí je TASK 05: rozbor relevantních filtrů.
