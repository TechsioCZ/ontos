# TASK 11: audit našeptávače a přesné směrování

Uživatel 22. 10. 2026 požádal pokračovat po TASK 10 a ověřit, zda našeptávač
už máme. TASK 10 je v commitu `9d0ab0e4`.

## Existující funkce a zadání

- [Issue #1309](https://github.com/TechsioCZ/ontos/issues/1309) požaduje vlastní
  našeptávač, zobrazení návrhů během psaní a správné odkazy na produkty a varianty.
  Otevřené issue má pouze label `bug`; GitHub ani projekt se nemění.
- `HeaderSearch` tyto návrhy už skládá z kit `SearchForm`/`SearchSuggestions`:
  kategorie s cestou, produktové obrázky, případné SKU, skutečná cena varianty
  nebo „Cena dle varianty“. Hledá od dvou znaků, podporuje diakritiku,
  šipky/Enter/Escape, prázdný stav a přechod na všechny výsledky.
- [Komentář k Meilisearch](https://github.com/TechsioCZ/ontos/issues/1309#issuecomment-6266134947)
  navrhuje pozdější integraci. Tento krok dokončuje původní chování lokálního dema;
  nevytváří index, provider, endpoint ani provozní integraci. Ty potřebují samostatné D7.

## Potvrzená mezera

Browser před opravou prokázal, že přesný návrh s kódem `10197200040300` otevře
v tabulce `item-9025` i `item-37420`, jehož kód je `101972000403001`.
Totéž platí pro `10908200100180` a delší kód s koncovkou `SW7`.
Návrh má jednu cenu a název varianty, ale odkaz používá starý textový filtr `variant`.

Kontrola 19 025 variant navíc našla dvě dvojice různých variant se stejným SKU
ve skupinách dvojniplů a plochých tyčí. `searchCatalog` přes `.find()` vybere
první z nich a našeptávač tak bez opory v dotazu ukazuje jednu konkrétní cenu.

## Úprava v původním rozsahu

1. Jednoznačný variantní návrh a karta výsledků používají společný
   `buildVariantSelectionHref` s přesným `variantIds`, nikoli filtrování podle části SKU.
   Výsledkem zůstává vybraná varianta v tabulce; její modal se otevírá existujícím odkazem.
2. Více přesných shod sdíleného SKU se zachová jako skupina. Návrh nepředstírá
   výběr jedné varianty nebo její cenu. Výběr podle textového dotazu zůstává vícevariantový.
3. Shodné pravidlo platí pro našeptávač i stránku výsledků, aby přesun přes „všechny
   výsledky“ nevracel původní chybu. Běžné skupinové hledání a kategorie se nemění.
4. Vzhled a kit komponenty už požadavku odpovídají; změna nepotřebuje nové CSS,
   tokeny ani jiný vyhledávací backend.

## Ověření

- Nové unit/component regrese nejdříve potvrdily chybu: nesprávné variantní URL
  a výběr první varianty ze sdíleného SKU. Po opravě prošlo všech 34 cílených testů.
- `npm run check` prošlo: formatter, lint, TypeScript, všech 182 testů ve 33 souborech
  a produkční build. Použito `VITEST_MAX_WORKERS=1` kvůli paměti stroje.
- `npm run test:search-routing` prošlo na 1920/1024/390/320 px: pět dotazů,
  celkem 20 kombinací. Zahrnuté oba případy prefixů, obě dvojice sdílených SKU
  a běžné jednoznačné SKU. Ověřena cena, pointer/klávesnice, popup v šířce obrazovky,
  přesné ID řádků po přechodu, reload, modal konkrétní varianty a návrat do seznamu.
- Stejné případy prošly přes „Zobrazit všechny produkty“ a karty výsledků hledání.
  Nesprávný sourozenec se u jednoznačného výsledku už nezobrazí; sdílené SKU
  zachová obě varianty a cenu nevybrané skupiny.
- `npm run test:shared-ui` prošlo na 12 šířkách od 320 do 1920 px včetně hranic
  breakpointů. Zachované jsou kategorie, hledání bez diakritiky, Enter/Escape,
  přechod na všechny výsledky, mobilní menu, footer a spotřeba kit tokenů.
- Bez runtime a hydratačních chyb. Ručně prohlédnuté screenshoty přesného SKU
  na 320 px a sdíleného SKU na 390 px jsou v pořádku. Artefakty a report jsou
  v ignorovaném `test-results/search-routing/`.

Lokální původní rozsah TASK 11 je připravený k review. Meilisearch není
implementovaný; jeho index, API a nasazení jsou otevřená návaznost D7.
Nová oprava zatím není commitnutá ani nasazená. GitHub nebyl změněný.
