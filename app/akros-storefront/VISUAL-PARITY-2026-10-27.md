# Vizuální porovnání po převodu na nativní demo

## Co tato kontrola porovnává

Zadáním je zachovat opravené UI z `feat/akros` a propojení BE/FE z
`demo/sales-crm`. Kontrola vychází z původních připomínek v
[Google dokumentu](https://docs.google.com/document/d/1zMqf_xghQnQ9u-NcQmTkhVX8qOIjoUZDZ5nSPEjJde0/edit?tab=t.nk2t7k86gd14),
včetně všech 17 vložených obrázků. Obrázky zachycují hlášené problémy;
očekávaným výsledkem je jejich následná oprava v `feat/akros`, nikoli starý
rozbitý stav z obrázků.

Reference: `feat/akros` / `f1b74b02a`. Výchozí integrační checkpoint:
`7936981a4`. Reference byla rozbalena do ignorovaného testovacího adresáře,
bez přepnutí větve nebo vytvoření worktree. Používá původní UI-kit 0.56.1
včetně tehdejšího patche Comboboxu; integrační větev používá 0.57.0.
Obě stránky běžely ve stejném Chrome a se stejným fontem. Referenční harness
sdílí instalovaný Next 16.3.8 a runtime závislosti; původní balíček uváděl
Next 16.3.6. Úpravy referenčního harnessu se týkají cest, Tailwind discovery
a jednoho izolovaného náhledu adresních polí, nikoli vizuálních hodnot.

## Původní vizuální připomínky

| Bod | Původní problém / obrázek                                      | Porovnání a výsledek                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Jiná horní navigace / 01                                       | Zachováno šest textových stránek, podtržení a rozložení z reference. Nativní informační pás nad hlavičkou zůstává. Mobil používá stejný Drawer a katalogovou navigaci.                                                                                   |
| H2  | Velikost „Doporučujeme“ / 02                                   | V obou větvích 20 px / 30,08 px, stejný černý pruh.                                                                                                                                                                                                      |
| H3  | Jiné sociální ikony v patičce / 03                             | Opraveno: vrácena celá původní patička včetně tří tokenových ikon, původních odkazů a log plateb, dopravců a bezpečného nákupu. Statická prezentace se při připojení backendu nemá odstraňovat.                                                          |
| H4  | Zalamování „Informace pro zákazníky“ a nepodtržené odkazy / 04 | Zachované původní tokeny, jednořádkový nadpis a podtržené odkazy.                                                                                                                                                                                        |
| H5  | Chybějící blok pod kategoriemi / 05                            | „Mohlo by vás zajímat…“ a „První kroky v e-shopu“ jsou zachované v `CatalogHelpNavigation`, v desktopové i mobilní navigaci.                                                                                                                             |
| H6  | Rámeček místo stínu karty / 06                                 | V obou větvích nulový rámeček a stín `0 2px 6px rgb(0 0 0 / 20%)`.                                                                                                                                                                                       |
| P1  | Chybějící rámeček filtrů / 07                                  | Zachovaný rámeček celého panelu i číselných vstupů. Reset zůstává uvnitř panelu na všech kontrolovaných šířkách.                                                                                                                                         |
| P2  | Padding a mezera mezi ikonou a textem akcí / 08                | Zachované původní tokeny akcí a mezera 8 px; tlačítka se zalamují uvnitř dostupné šířky. Rozdílná dostupnost některých akcí je uvedena níže.                                                                                                             |
| P3  | Překrývání rámečků a kódů v tabulce / 09                       | Přímá kontrola čtyř různých produktových tabulek proti referenci, včetně dlouhých SKU: žádný text ani ovladač nepřekročil buňku.                                                                                                                         |
| P4  | Mizení obsahu detailu na menší šířce / 10–11                   | Titulek, informace a varianty zůstávají uvnitř viewportu. Tabulka přechází do původního kompaktního rozložení.                                                                                                                                           |
| C1  | Umístění skladu, množství a ceny / 12                          | Porovnáno skutečné rozložení a styly buněk, nikoli pouze názvy komponent. Aktuální `Table` zachovává rozložení původního `DataTable`; ovladač má výšku 58 px, číslo 25 px na desktopu / 16 px v úzkém kontejneru a stejné samostatné rámečky a tlačítka. |
| C2  | Vzhled tlačítek zpět a pokračovat / 13                         | Původní varianty, velikosti a šířky jsou zachované. Nativní podmínka přihlášení a blokování pokračování při neověřeném košíku zůstávají.                                                                                                                 |
| C3  | Chybějící „Vaše košíky“ / 14                                   | `CartSelector` je součástí skutečného `CheckoutLayout`, včetně vytvoření, přepnutí a odstranění lokálního košíku. Na menší šířce se panel přesouvá pod obsah.                                                                                            |
| C4  | Odlišné rámečky polí adresy / 15                               | Porovnání původního a současného `AddressFields` ve stejné checkout oblasti; stejné rozměry, rámečky a zaoblení.                                                                                                                                         |
| A1  | Odlišný vzhled účtu                                            | Opravené nadpisy sekcí: obnoveno napojení na původní tokeny pro tučnost, mezeru u šipky a mobilní dotykovou výšku. Obnoveno menší mobilní odsazení filtrů a karet objednávek, tučné částky a společná řada akcí. Rozsah nativních polí se nesimuluje.    |
| A2  | Navigace účtu a mobilní sidebar                                | Zachovaný `AccountShell`, podtržená aktivní záložka a zalamování navigace. Odkazy stále směřují na nativní stránky účtu.                                                                                                                                 |
| A3  | Nevyužité místo v malém detailu / 16                           | Přiložený obrázek zobrazuje produktové plechy, přestože text je pod nadpisem „Účet“. Prověřeno na plechových produktech a jejich kompaktních variantových tabulkách.                                                                                     |
| A4  | Oříznuté „Filtrovat“ / 17                                      | Obrázek opět patří produktovým filtrům. Podle později schváleného TASK 05 již není potvrzovací „Filtrovat“: hodnoty filtrují automaticky a dostupné „Obnovit filtry“ nepřetéká.                                                                          |

## Oddělení vizuálu od funkčního rozsahu

Další nalezené odchylky byly opraveny přímo podle reference:

- Původní krátký text „Cena dle varianty“ se znovu používá na kartách i v
  hledání. Delší integrační text zbytečně přidával řádek a posouval tlačítka.
  Nativní rozlišení nedostupné ceny a pravidla nákupu se nemění.
- Dvě oblíbené varianty stejného produktu měly po převodu stejný React klíč.
  Karta nyní rozlišuje produkt i variantu. Nový test před opravou zachytil
  duplicitní klíč; po opravě ověřuje dvě karty a odebrání jedné bez změny druhé.

- Vrácení log do patičky nepřidává online platbu ani nemění dostupné metody
  checkoutu. Demo informační pás a nativní validace zůstávají.
- Skladovost, minimální odběr, balení, ceny, počty objednávek a jejich obsah
  jsou nativní data. Jejich odlišné hodnoty proti mockům nejsou důvodem pro
  návrat mocků. Odlišné délky textu se kontrolují z hlediska zalamování.
- Produktový popis je mezi souhrnem a variantami, pokud backend vrátí popis
  nebo parametry. Prázdný popis se nenahrazuje smyšleným obsahem.
- Chybějící nativní funkce se touto vizuální kontrolou nestávají hotovými:
  hlídání produktu, úplná správa uložených adres, změna hesla a normalizovaný
  součet hmotnosti mají omezení zaznamenaná v
  [předchozí revizi](UI-REVIEW-2026-10-27.md).
- Účet a opakování objednávky byly v této kontrole vizuálně ověřované na
  odděleném testovacím náhledu se vstupními fixtures. Nejde o nové potvrzení
  autentizace ani odeslání objednávky do backendu. Žádná zákaznická objednávka
  nebyla při této kontrole měněna.

## Důkazy a ověření

Pracovní důkazy jsou v ignorovaném `test-results/visual-parity/`:

- `document-images/`: původních 17 screenshotů z Google dokumentu.
- `captures/metrics.json`, `details.json`, `account-cart.json`: počáteční
  párová měření a snímky homepage, detailu, košíku a účtu.
- `captures/product-audit.json`: 80 porovnání, čtyři produkty × deset šířek ×
  dvě větve; nula chyb rozložení a nula browser chyb. Šířky 320, 390, 760,
  761, 768, 1024, 1100, 1101, 1440 a 1920 px.
- `captures/paired-controls.json`: závěrečné porovnání košíku, adresních
  polí, účtu a obnovené patičky; 102 měření bez chyb rozložení a browser chyb.
  Adresní pole v obou větvích mají výšku 60 px, rámeček 2 px a radius 8 px.
  Focus outline ovladače množství je v obou větvích shodně 2 px; nejde o
  nový rámeček přidaný změnou `DataTable` na `Table`.
- `test-results/ui-integration/browser/report.json`: nových 104 rozložení na
  13 šířkách a průchody dialogy, adresou, profilem a opakováním objednávky.
  Izolovaný náhled; nula chyb a žádné skutečné zápisy objednávek.
- `captures/native-final.json`: **27 úspěšných kontrol nového produkčního
  buildu proti skutečnému backendu**, bez HTTP fixtures. Homepage a kompletní
  patička na deseti šířkách, dvě oblíbené varianty na šesti šířkách, odebrání
  přesné varianty při zachování druhé a živě ověřený košík na sedmi šířkách.
  Mobilní menu a pomocný blok byly ověřené na 320, 768 a 1023 px, včetně
  zavření klávesou Escape a návratu fokusu na otevírací tlačítko.
  Bez zápisu objednávek nebo zákaznických profilů; změny oblíbených a obsahu
  košíku byly pouze v odděleném testovacím prohlížeči.

Validace aktuálních změn:

- Produkční build storefrontu včetně TypeScriptu: prošel.
- Standardní `homepage-layout.mjs` proti produkčnímu buildu: prošel na
  všech 34 šířkách, včetně dotykového a klávesnicového ovládání carouselu.
- Storefront lint a formát změněných zdrojů/testů: prošly; původní lint warningy
  zůstávají viditelné.
- Kompletní sada storefrontu: **498 z 499 testů prošlo**. Zůstává stejný
  neúspěšný test českého desetinného filtru v `product-purchase-form.test.tsx`.
  Očekávání se neměnilo a test nebyl vypnutý. Nový regresní test dvou variant
  prošel.
- Celá workspace gate: znovu neprošla ve `test:lint-rules` (267 úspěšných,
  2 neúspěšné testy). Důvody jsou Windows `ERR_UNSUPPORTED_ESM_URL_SCHEME`
  a původní tři `no-manual-tag-comparison` diagnostiky ve `finance-billing`
  a `property-portfolio`. Log: `full-workspace-check.log`.
- `i18n:boundaries`: původních 513 chyb a 29 warningů; nic nebylo vypnuté
  ani obejité. Log: `i18n-boundaries.log`.

Při ověření nového produkčního serveru se odhalil výpadek lokálního Commerce
procesu: jeho dřívější 512MB Node heap byl vyčerpaný. Současně neběžela služba
development composition na portu 3041. To způsobilo 503 z gateway a fallback
katalogu po vyprázdnění frontend cache. Původní log je uchovaný jako
`commerce-heap-before-restart.log`. Obnova runtime nemění zákaznická data,
objednávky ani oprávnění. Commerce bylo obnoveno s 1GB Node heapem. Chybějící
generované vývojové artefakty připravil existující
`scripts/prepare-dev-module-contract.mts`; standardní `scripts.dev` tento
krok obsahuje a lokální pomocný spouštěč jej nově nevynechává. Nebyly ručně
vytvořeny manifesty ani změněny zdrojové kontrakty. Composition obnovila stejnou
revizi pro pět původních vlastníků. Závěrečný živý test po obnovení prošel a
storefront je opět dostupný na `http://localhost:3070`.

Nejde o tvrzení, že všechny nativní funkce nebo celá workspace gate prošly.
