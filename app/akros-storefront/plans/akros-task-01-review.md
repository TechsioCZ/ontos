# TASK 01: zadání, implementace a ověření

Stav k 20. 10. 2026: implementace a lokální ověření odsouhlaseného TASK 01 dokončené.
Issue [#1298](https://github.com/TechsioCZ/ontos/issues/1298) nebylo změněné ani uzavřené.
Postup se řídí [hlavním plánem](../IMPLEMENTATION-PLAN.md).

## Význam zadání

1. Vzhled výpisu variant přiblížit konkrétní Figmě.
2. Zmenšit tlačítko označené v zadání jako „Celé zboží“.
3. Zachovat celý a čitelný kód varianty na menších monitorech.

Uživatel potvrdil kompaktní provedení černého tlačítka ze screenshotu. Předlohou
pro tuto úpravu je
[Varianta produktu s více druhy, 8:1377](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG/Akros?node-id=8-1377).
„Celé zboží“ v TASK 01 znamená **„Koupit celé balení“** vpravo v řádku varianty.
Text se zalamuje na „KOUPIT CELÉ“ a „BALENÍ“, údaj o obsahu balení zůstává menší.
Referenční desktopový rozměr je 128 × 38 px, uzel `8:1717`.
Toto upřesnění se týká TASK 01; nepotvrzuje automaticky informační rozložení
a chování dalších úkolů z celého Figma rámce.

## Výchozí stav před implementací

Přímé porovnání stejného produktu
[na deployi](https://akros-pi.vercel.app/produkt/vruty-se-zapustnou-hlavou-s-krizovou-drazkou-din-7997-a2)
a na lokální route stejného názvu:

| Oblast                              | Nasazená verze při kontrole                                                                    | Lokální verze při kontrole                                             | Důsledek                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Výpis při 1024px viewportu          | Široká tabulka s vodorovným posuvem; část nákupních ovladačů je mimo viditelnou oblast tabulky | Přeskupený výpis se jménem/SKU, dostupností/cenou a nákupními ovladači | Lokální responzivní opravu zachovat; neopakovat implementaci ze staršího stavu       |
| Kód kontrolované varianty           | `10799700030016`                                                                               | Stejný celý kód, při kontrolovaných šířkách čitelný                    | Pro tento příklad není doložena ztráta kódu; ještě pokrýt dlouhé a alfanumerické SKU |
| Černé tlačítko při 1920px viewportu | Přibližně 237 × 32 px                                                                          | Přibližně 237 × 32 px                                                  | Zmenšení šířky oproti předloze stále zbývá                                           |
| Stejné tlačítko ve Figmě            | —                                                                                              | Kandidát předlohy: 128 × 38 px, uzel `8:1717`                          | Po potvrzení upravit lokální velikost přes kit props/tokeny                          |
| Kód ve zdrojích                     | —                                                                                              | Desktopový SKU element používá `break-all`                             | Současná kontrola hranic buněk sama nezaručuje vhodné dělení dlouhého kódu           |

Přímé browserové porovnání proběhlo při šířkách 1920, 1440, 1280, 1024, 768,
390 a 320 px. Mobilní šířky byly ověřené přes skutečný emulovaný viewport;
samotný resize okna v tomto prostředí nepustí šířku pod 500 px.
Nález na jednom produktu není automatické potvrzení všech typů produktů.

## Rozsah TASK 01 po upřesnění

- Zachovat současné přepínání podle šířky obsahu: tabulka od 1000 px,
  mezilehlý výpis od 640 px, pod touto hranicí karty.
- Doladit proporce černého tlačítka podle potvrzené kompaktní předlohy, přes
  podporované props a tokeny UI kitu. Na desktopu nesmí zbytečně vyplňovat celou
  dostupnou šířku nákupního sloupce. Zachovat menší údaj o obsahu balení.
  Na mobilu zachovat použitelnou dotykovou plochu alespoň 44 px na výšku;
  desktopových 38 px nevynucovat ve všech responzivních režimech.
- Prověřit rozdělení šířky mezi jméno, SKU a dvě nákupní skupiny; u kódu zrušit
  nevhodné dělení uvnitř hodnoty, pokud se potvrdí na delších skutečných SKU.
- Ověřit vzhled na stejné dostupné šířce komponenty, ne odhadovaným přepočtem
  celkové šířky celé Figma stránky. Neobnovovat experiment s šířkou storefrontu.
- Funkci nákupu, minima, násobky balení, sklad a ceny zachovat. Odstraňování filtrů,
  opakovaných názvů a stránkování patří do TASK 04/05, nikoli automaticky do TASK 01.

## Ověření při implementaci

- Cíleně porovnat potvrzené kompaktní tlačítko s Figmou při stejné šířce obsahu.
- Prověřit dlouhé číselné i alfanumerické SKU na desktopu, notebooku a mobilu;
  celý kód musí zůstat čitelný a kopírovatelný.
- Zachovat stávající browserovou sadu `tests/browser/variant-table-layout.mjs`:
  čtyři produkty a 22 šířek, včetně hranic breakpointů. Doplnit jen skutečně
  chybějící ověření požadovaného chování, například nevhodného zalomení SKU.
- Výchozí lokální stav prošel 88 kontrolami této sady na 22 šířkách (320–1920 px).
  Jde o regresní základ; test hranic buněk neověřuje přesnou shodu s Figmou ani
  nezaručuje vhodné zalamování všech dlouhých SKU.
- Před dokončením implementace provést kontroly z hlavního plánu.

## Výsledek implementace

- Černý kit `Button` používá `size="sm"`, `variant="secondary"` a `block={false}`.
  Rozměry a typografie jsou nastavené v `_akros-data-table.css`: desktop 128 × 38 px,
  text 13 px, menší obsah balení 8 px, semibold z kitu. Na užších layoutech má
  tlačítko výšku 48 px; při 320px viewportu se šířka zúží na 102 px, aby se vešlo
  vedle množství. Text se vejde celý i s odsazením.
- V mezilehlém výpisu se šířka nákupní skupiny počítá ze stávajícího množstevního
  ovládání 152 px, mezery 8 px a tlačítka 128 px: celkem 288 px místo 320 px.
  Uvolněných 32 px umožňuje zobrazit dlouhé SKU bez dělení.
- Ze SKU se odstranilo `break-all`; kód v tabulce i mezilehlém výpisu zůstává
  na jednom řádku. Nákupní funkce, filtrování a stránkování se nezměnily.
- Šířka tlačítka a rozložení jeho dvouřádkového obsahu jsou lokální kompozice:
  kit nemá prop pro vlastní pevnou šířku ani typografii vnořeného popisku.
  Barvy a stavy dál řídí kit; rozměry a typografie mají centrální tokeny.

### Dodatečné doladění mezer, 21. 10. 2026

Po uživatelské kontrole byla opravená příliš velká mezera mezi množstvím balení
a černým tlačítkem. Samotné zmenšení tlačítka ponechalo sloupec nákupu široký 47 %
tabulky a roztahující se vnitřní mřížku; naměřená mezera byla přibližně 115 px.

Podle Figma řádku `8:1548` mají ovladače nyní sousedící pevné sloupce podle tokenů:
96 px množství, 113 px žluté tlačítko, 128 px černé tlačítko, mezery přibližně 6 px.
Šířka nákupního sloupce vychází ze součtu obou skupin a odsazení, přibližně 482 px.
Název varianty dostává zbývající místo místo původních 12 %. Responzivní seznam
a mobilní karty zachovávají dosavadní rozložení. Browserová regrese navíc hlídá,
že se na desktopu množství a související tlačítko znovu neoddělí velkou mezerou.

Po této opravě znovu prošlo `npm run check` včetně 150 testů a produkčního buildu,
88 layoutových + 12 cílených SKU kontrol a katalogová sada při 1920/1024/390 px.
Aktualizované screenshoty desktopu, tabletu a mobilu byly vizuálně prohlédnuté.
Browserové sady při této dodatečné opravě běžely proti aktuálnímu dev serveru.
Pro kontrolu typů bylo potřeba nejprve spustit oficiální `next typegen`, protože
dev a produkční generované definice se načítaly současně; pravidla TypeScriptu
ani konfigurace projektu se neměnily.

## Dokončené ověření

- `npm run check`: formátování, lint, TypeScript, všech 150 testů a produkční build.
  Kvůli nedostatku paměti při paralelním běhu bylo potřeba pouze pro tento běh
  nastavit `VITEST_MAX_WORKERS=1` a `CIRCLE_NODE_TOTAL=2` (jeden build worker).
  Všechny kontroly zůstaly zapnuté; konfigurace projektu se neměnila.
- `node tests/browser/variant-table-layout.mjs`: 88 kontrol na čtyřech produktech
  a 22 šířkách 320–1920 px, navíc 12 kontrol dvou skutečných 18znakových SKU.
  Kontrola zahrnuje rozměry tlačítka, úplnost kódu, zalamování a hranice buněk.
- `node tests/browser/catalog.mjs`: nákup minimálního množství a celého balení,
  tokeny, filtry, slider a stránkování při 1920, 1024 a 390 px.
- Vizuálně prohlédnuté screenshoty nákupního řádku při 1920, 1024, 390 a 320 px
  a dlouhého SKU při 704 a 1336 px. Snímky a rozměry jsou v ignorované složce
  `test-results/implementation-planning/task01-*.png` a `task01-visual-report.json`.
- Browserová ověření proběhla proti produkčnímu buildu na `http://localhost:3000`.
