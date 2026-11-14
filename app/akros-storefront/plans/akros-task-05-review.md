# TASK 05 – zjednodušení filtrace

Uživatel schválil pokračování na další tasky po TASK 04 (`03733167`).
Rozsah odpovídá #1303 a Google dokumentu
[Akros demo – bugy](https://docs.google.com/document/d/1zMqf_xghQnQ9u-NcQmTkhVX8qOIjoUZDZ5nSPEjJde0/edit?tab=t.nk2t7k86gd14).

## Rozbor a implementační směr

- Odstranit cenu a materiál včetně jejich stavu, parsování a vlivu na výsledky.
  Filtry se dosud nepersistovaly ani nečetly z URL; `variant` a `variantIds`
  zůstávají přesným hledáním/výběrem variant, nikoli cenovým/materiálovým filtrem.
- Současná dvojice rozměrů označuje automaticky jakýkoli zápis `a × b` jako průměr
  a délku. V katalogu je 910 vícevariantových skupin a většina variant má prázdné
  strukturované parametry. Toto pravidlo není správné pro plechy a trubky.
- Použít konzervativní mapování známých skupin: šrouby, vruty, nýty, čepy a závitové
  tyče mají dvojici průměr/délka; plechy trojici tloušťka/šířka/délka; kruhové trubky
  průměr/tloušťka stěny, čtvercové a obdélníkové šířku/výšku/tloušťku stěny.
  Nejednoznačný nebo neúplný zápis tuto cestu vypne. Rozpor se strukturovaným údajem
  vypne daný filtr. Např. AN 9050 má zdrojový parametr délky 60 mm pro popisek 3 × 30.
- Mimo známé skupiny použít jen úplné, číselné a srozumitelně pojmenované rozměry
  ze zdroje. Nedoplňovat chybějící jednotku, neoznačovat `dimension_a` bez kontextu.
  Konstantní rozsahy nezobrazovat. Bez bezpečně známých rozměrů nevykreslovat prázdný panel.
- Ověřit živé filtrování bez potvrzovacího tlačítka: zachovat prázdný/desetinný
  buffer NumericInput a fokus; slider synchronizuje pole. Přidat obnovu rozsahů
  a počet výsledků. Nezavádět zpoždění, pokud je měření nevyžaduje.
- Zachovat celý výpis, nákup, variantní modal, SKU a původní šířku layoutu.

## Ověření

Dokončeno 22. 10. 2026. Automatická filtrace bez potvrzovacího tlačítka zůstává
výsledkem tohoto kroku; ovládání nevyžadovalo debounce ani virtualizaci.

- `npm run check`: formátování, lint, TypeScript, 169 testů v 31 souborech a produkční
  build prošly. Šest nových jednotkových případů ověřuje význam rozměrů, desetinné
  hodnoty, konstantní/neúplná data a rozpor se zdrojovým parametrem. Komponentové
  testy ověřují živou filtraci, reset, zachování fokusu a bufferu, oba oddělovače,
  nepřítomnost ceny/materiálu a vypnutí prázdného panelu.
- `test:variant-filters`: šrouby, plechy, čtvercové a kruhové trubky při
  1920/1024/390/320 px; správné názvy filtrů, bez přetoku. Skutečné psaní `3,5`
  i `3.5`, mazání pole, Tab, klávesnice a tažení slideru myší prošly při 386
  variantách. Chybějící kombinace rozměrů vrací prázdný výsledek, reset obnoví všech
  386 řádků. Bez runtime nebo hydratačních chyb.
- Kitový český `NumericInput` v `onBeforeInput` odmítal desetinnou tečku ještě před
  callbackem. Použité veřejné props `value`, `onValueChange` a `Input.onBeforeInput`
  zachovávají řízený textový buffer a ekvivalentní číselnou validaci se dvěma
  oddělovači; tečka se normalizuje na čárku. Nejde o zásah do knihovny ani ruční
  přepis jejího DOM. Po slideru se obnoví dvě NumericInput instance kvůli jejich
  vnitřnímu editačnímu stavu, samotný slider a jeho fokus zůstávají zachované.
- `test:variant-list`: všech 47/386 variant při osmi šířkách 320–1920 px, konec
  seznamu, nákup, modal/fokus, sdílené odkazy a filtrace včetně mobilního načtení.
- `variant-table-layout.mjs`: 88 kontrol čtyř výrobků na 22 šířkách + 12 dlouhých SKU.
  Původní kontroly ceny/submitu byly nahrazeny kontrolou rozměrových vstupů a jejich
  obsahu; výrobek bez dostupných rozměrů panel nemá. Skryté technické inputy slideru
  se nevyhodnocují jako viditelné ovládání.
- `test:catalog` prošel při 1920/1024/390 px včetně tokenů, minim, celých balení,
  prázdných výsledků a původního stránkování kategorií/vyhledávání.
- `test:variant-detail` prošel ve všech osmi layoutech včetně historie, fokusu,
  přímých akcí, sdílení, dotazu a chybějících/neplatných dat.

Poslední místní měření v desktopovém Chromu proti produkčnímu serveru: úplné
automatizované zadání `3,5` včetně kontrol 798 ms, čtyři vstupy pro prázdný výsledek
527 ms, reset a vykreslení 386 variant 855 ms. Jde o celé automatizované scénáře,
nikoli INP nebo benchmark fyzického telefonu. Report a screenshoty jsou v ignorovaném
`test-results/variant-filters/` a `test-results/variant-list/`; byly vizuálně prohlédnuté.

Odstraněny specifické deklarace cenového filtru, submitu a materiálového checkboxu
včetně nepoužívané ikonové utility. Rozměrový vstup se rozšířil přes token z 32 na
64 px a skupina z 212 na 288 px kvůli skutečným čtyřciferným rozměrům plechů.
Reset používá kitový Button a standardní border token. Celková šířka layoutu se nemění.
