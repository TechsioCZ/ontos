# TASK 08: rozmístění informací v detailu

Uživatel 22. 10. 2026 schválil celý popis pod obrázky a souhrnem, nad výběrem
variant, a stručný blok dopravy pod akcemi. Navazuje na commit `adee112b`.

## Ověřený stav a rozsah

- [Issue #1306](https://github.com/TechsioCZ/ontos/issues/1306) požaduje posoudit
  popis pod obrázky a doplnit dopravu, případně pod původní akci „Poslat kamarádovi“.
  Otevřené issue bylo přečtené; má pouze label `bug`. Discovery nemění GitHub ani labely.
- Figma `SAs905DGG2kT4lnrQ0PnyG`, node `8:1377`, byla načtena včetně screenshotu.
  Má krátký popis pod názvem vpravo a akce pod informacemi, nikoli blok dopravy.
  Schválené nové rozmístění je úpravou tohoto návrhu, ne jeho přesnou kopií.
- Browserové porovnání lokálu a deploye potvrdilo chybějící dopravu přímo v detailu.
  Lokál byl zkontrolován na 1920/1024/390 px u vrutů DIN 7997/A2 a šroubů DIN 933/A4–70.
- Současný filtr odstraní celý odstavec, pokud zmiňuje množstevní slevy.
  Tím ztrácí například upozornění na pevnost A4–70, tepelnou odolnost matic
  a volbu bitu. Oprava zachová vlastní informace a odstraní jen přesně známé
  úvodní oznámení o slevách. Jiný text o cenách se nesmí plošně zahazovat.
- Informační stránka a checkout mají různé ukázkové ceníky dopravy. Tento krok
  je nesjednocuje ani nekopíruje jejich ceny či termíny do detailu.

## Schválené chování

1. Kompletní dostupný popis je v jediném bloku pod celým horním přehledem,
   před filtrem a variantami. Krátký stejný odstavec se neopakuje vedle obrázku.
   Zachovat parametry; u skutečně chybějícího popisu uvést pravdivý prázdný stav.
2. Pod akcemi je oddělený blok „Doprava a platba“, obecná informace o výběru
   v košíku a odkaz na existující `/doprava-a-platba`. Bez nové ceny, příslibu
   doručení nebo dostupnosti konkrétního dopravce pro konkrétní výrobek.
3. Stránka, variantní modal a tisk používají stejné šetrné zpracování popisu.
   Vlastní popis varianty má přednost; společný zůstává označený jako společný.
4. Použít existující kit `ContentLink`/`LinkButton`, sémantické sekce a stávající
   tokeny rozestupů, barev a textů. Neměnit globální šířku ani nákupní pravidla.
   Kit 0.56.1 nemá obecný heading/surface/divider; tuto již evidovanou mezeru
   řeší místní obsahová kompozice v `globals.css` s existujícími tokeny,
   nikoli nové layoutové deklarace v tokenových souborech.
5. Ověřit skupinu variant, samostatné SKU, chybějící a smíšený popis, modal,
   tisk, odkaz dopravy a desktop/tablet/mobil včetně hranice breakpointu.

Hmotnost byla na žádost uživatele prověřena samostatně. Porovnání stejných SKU
s původním e-shopem doložilo kg pro zobrazení v TASK 07. Přepočet pro TASK 16
nadále vlastní [hmotnostní plán](akros-weight.plan.md#doplnění-22-10-2026).

## Ověření realizace

- `npm run check` prošlo: formatter, lint, TypeScript, všech 178 testů ve 33 souborech
  a produkční build. Běh používá `VITEST_MAX_WORKERS=1`; původní neomezený souběh
  narazil na nedostatek paměti. Kontroly ani timeouty se neoslabovaly.
- `npm run test:product-information`: čtyři skutečné produkty na osmi šířkách
  1920/1440/1280/1024/768/767/390/320 px, celkem 32 kombinací. Kontroluje pořadí
  bloků, přetečení, neduplicitní popis, skutečné materiálové upozornění, chybějící
  popis, samostatné SKU, dopravu a její odkaz. Ověřeny modal i tisk.
- Samostatná kontrola týchž čtyř produktů na hranici 760/761 px prošla:
  žádné přetečení, popis pod přehledem, odkaz uvnitř dopravního bloku.
- Hmotnost zkontrolována na dvou různě těžkých variantách DIN 912/A2 (`0,00691 kg`
  a `0,204 kg`) a metrové variantě bez údaje na 1920/390/320 px. Bez dědění váhy
  rodiče, bez dělení balením a bez vymyšleného nulového údaje.
- `npm run test:variant-detail` prošlo: osm layoutů včetně 320 × 480 px,
  klávesnicový náhled, modal/historie/reload/fokus, nákup konkrétní varianty,
  nezávislé oblíbené a hlídání, sdílení a náhradní postup, dotaz a chybějící data.
- Ručně prohlédnuté screenshoty desktopu i mobilu: obnovený popis DIN 933/A4–70,
  krátký FVE popis, doprava na 1920/320 px a variantní modal s hmotností.
  Artefakty jsou v ignorovaném `test-results/product-information/` a
  `test-results/variant-detail/`.

Lokálně dokončeno; GitHub, deploy ani push nebyly změněny.
