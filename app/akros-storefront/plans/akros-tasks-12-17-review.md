# TASK 12–17: FE výsledek pro společné review

Uživatel 22. 10. 2026 schválil všech šest zbývajících úkolů v rámci FE storefrontu,
s kontrolou každého kroku a bez commitů. Pro TASK 12 následně výslovně schválil
funkční lokální ukázku nad sjednocenými demo daty účtu a existujícím košíkem.
Google Doc „Akros demo – bugy“, karta `t.nk2t7k86gd14`, byl znovu načtený;
TASK 12–17 se shodují s GitHub #1310–1315. Přihlédnuto ke komentářům #1312
(nepřidávat FE mock persistence) a #1313 (samotná změna hesla patří BE).
[Zdrojový dokument](https://docs.google.com/document/d/1zMqf_xghQnQ9u-NcQmTkhVX8qOIjoUZDZ5nSPEjJde0/edit?tab=t.nk2t7k86gd14).
TASK 18–20 nejsou součástí těchto šesti úkolů. Docs ani GitHub se nemění.
Uživatelské review: TASK 13, 14, 15 a 17 jsou odsouhlasené. TASK 16 má skutečné
katalogové váhy podle posledního upřesnění. Dne 23. 10. 2026 uživatel pověřil
agenta závěrečnou kontrolou včetně TASK 12/16 a breakpointů a schválil commity
po úspěšném ověření. React chyba Comboboxu je opravená; omezení vyhledávání
poskytovatele jsou evidovaná jako návaznost služby mimo dokončenou FE integraci.

## TASK 12 — Objednat znovu · #1310

- Společný zdroj `src/mock-storefront/fixtures/account.ts` obsahuje demo profil,
  adresy a pět kompletních objednávek. Profil i výchozí checkout čtou stejný základ.
- Každá objednávka má své konkrétní varianty, numerické množství, původní cenu
  a historickou adresu. Souhrn se počítá z jejích řádků a dopravy.
- Kit tlačítko v historii i detailu nyní vkládá položky do aktivního stávajícího
  košíku. Používá současné katalogové ceny/sklad, sloučí shodné varianty,
  zachová ostatní položky a ostatní pojmenované košíky.
- Nedostupné nebo odstraněné varianty a omezená množství oznámí po vložení.
  Nevkládá více než požadované množství a při poklesu skladu nesnižuje starý obsah.
  Výsledek zobrazuje stávající kit notifikace mimo tabulku s odkazem do košíku.
- Po vizuálním review je `Objednat znovu` solid primary akcí před odkazem
  `Otevřít` / vedlejším detailem. Notifikace používá vedlejší outlined odkaz
  do košíku, jedno společné ID a obsahuje číslo objednávky. Úspěch mizí po 6 s,
  skladová omezení a chyba čekají na zavření. Řádek ani sloupce nemění velikost.
  Odstraněné CSS pro vkládaný výsledek; používají se existující toast tokeny.
- Příklady: `00847` běžné vložení tří variant, `00812` jedna varianta bez skladu,
  `00790` omezení původních 100 ks na dnešních 30 ks. Ceny v historii jsou úmyslně
  jiné než dnešní, aby bylo možné ověřit použití současné ceny.
- Žádný nový backend, autentizace, hesla v demo datech ani automatický archiv
  nových checkout objednávek. Připravený volitelný callback pro skutečnou službu zůstává.

Review: `/historie-objednavek`, `/detail-objednavky`.

## TASK 13 — Oblíbené varianty · #1311

- Ověřeno zobrazení konkrétní varianty/SKU/ceny, přesné `variantIds`, vybraná
  varianta po reloadu, nezávislé odebrání a prázdný stav na všech 14 šířkách.
- Vizuální kontrola odhalila ořez názvu a SKU v úzkých mobilních kartách.
  Oblíbené nyní používají stávající kit karty v rozložení 1/2/3 sloupců a celé
  texty se zalamují. Homepage ani katalogový grid se nemění. Po opravě byl
  opakovaný celý průchod a znovu prohlédnuté screenshoty.

Review: uložit dvě varianty produktu a otevřít `/oblibene`.

## TASK 14/15 — Profil, adresy a změna hesla · #1312/#1313

- Zachovaná editace, validace a původní lokální demo uložení profilu/adres.
  Nevzniká nový simulovaný adresář nebo účtová persistence.
- Opravena skutečná FE chyba: rozepsané heslo neblokuje uložení ostatních údajů.
- Automatický fokus po validaci běží až po vykreslení chyb a respektuje
  navazující přechod uživatele do jiného pole. Regrese třikrát rychle střídá
  neplatné heslo a PSČ; odložený fokus nesmí přesměrovat psaní zpět do hesla.
- `PasswordChange` má vlastní akci; tlačítko i Enter neodesílají profil. Kontroluje
  vyplnění a přesnou shodu, vrací fokus na chybu, obsluhuje průběh a retry;
  hesla vymaže až po skutečném úspěchu poskytnuté služby. Serverová délková
  politika se nevymýšlí. Hesla nejsou ve storage, URL ani logu.
- Bez autentizační služby vysvětlí nedostupnost a nikdy nepotvrdí změnu.
- Prošly component testy a detailní browser test profilu: save/reload, chyby,
  otevření chybné sekce, souhlasy, dodací adresa, selhání úložiště a samostatná
  validace hesla. Detailní vizuální test devět šířek, další layout test 14 šířek.
- Skutečná účtová persistence a změna hesla nadále čekají na BE.

Review: `/muj-ucet`, `/muj-ucet#zmena-hesla`.

## TASK 16 — Hmotnost košíku · #1314

- První krok zobrazuje součet a reaguje na množství, odebrání, reload i výběr
  košíku. Po uživatelově upřesnění se hmotnost dohledává i ze skutečného katalogu
  podle přesné varianty/SKU/MJ: kg/ks a kg/m. Explicitně normalizované
  `CartItemSnapshot.unitWeightKg` má přednost. Funguje i pro staré uložené košíky.
- `sourceNetWeight` se neodhaduje ani nedědí z kontejneru. Neúplná data zobrazí
  hlavní číselný údaj „Hmotnost známých položek“ a upozornění s počtem neznámých
  řádků. „Nelze určit“ zůstává jen tehdy, když neznáme žádnou hmotnost.
- Unit testy pokryly více balení v základním množství, desetinné jednotky,
  neplatné údaje, prázdný košík a storage. Browser ověřil 14 šířek, přepočet
  4,36 → 3,68 kg, reload, odebrání na 3 kg a přepnutí na neznámou hmotnost.
  Číselné fixtures jsou pouze v testech. Doprava a její ceny se nemění.
- Po napojení zdroje prošel celý `npm run check`: 206 testů ve 38 souborech,
  formatter, lint, TypeScript a produkční build. Rozšířený browser test ověřil
  skutečných 20 ks + 3 m = 0,248 kg ve všech 14 šířkách, neúplný součet po přidání
  varianty bez váhy, změnu množství, reload a skutečný nákup celého balení 200 ks
  tlačítkem produktu = 0,68 kg. Staré košíky nepotřebují migraci ani vymazání.
  Prošly také všechny scénáře opakování objednávky na 14 šířkách a checkout na 12.
  Screenshoty známé i neúplné hmotnosti byly prohlédnuté na desktopu i mobilu.
- Podle posledního upřesnění uživatele se používají kladné kusové i metrové váhy
  ze zdroje bez FE výjimek podle hodnoty nebo kategorie; nic se nedopočítává
  z rozměrů ani nepřepisuje ve feedu. Pravidla vlastní [hmotnostní plán](akros-weight.plan.md).
- Následná kontrola: celý `npm run check` prošel s 207 testy ve 38 souborech.
  Browser znovu prošel všech 14 šířek včetně číselného hlavního údaje u neúplných
  dat, reloadu, nákupu balení a změn košíku. Sestava z uživatelova screenshotu
  (40 + 80 + 20 ks vrutů a 100 m řetězu) dává podle zdroje úplných 0,576 kg.
  Screenshoty neúplného součtu na desktopu i mobilu byly vizuálně zkontrolované.
  Původní akros.cz přímo v anonymním košíku potvrdil 100 m stejného řetězu
  `10076604020000` → 0,1 kg; detail uvádí 0,001 kg při MJ m. Bez commitu.

Review: 20 ks vrutu `10799700040030` má 0,068 kg; celé balení 200 ks má 0,68 kg.
S 3 m lanka `10305304040011` je součet 0,248 kg. Neznámá položka součet označí
jako neúplný a zachová zobrazení dílčí známé hmotnosti.

## TASK 17 — Smart Address · #1315

- Kit `Combobox` v ulici fakturační i dodací adresy, veřejné skutečné API
  `/api/v1/suggest` dodaného deploye, CZ/cs, bez účtových cookies. Kontrakt byl
  ověřen z veřejného nasazeného SDK; privátní kód jiných deploymentů se nekopíruje.
- Validace/deduplikace odpovědi, odmítnutí jiných zemí, složení českého čísla
  `846/1`, přednost `line1`, neúplný návrh nemaže dříve zadaná chybějící pole.
  Nepřepisuje jméno, telefon ani druhou adresu.
- Debounce 300 ms, abort starého dotazu/unmountu, timeout 5 s, loading/retry,
  prázdný stav, neblokující chyba a zachované ruční zadání. Žádný produktový
  seznam falešných adres, nová databáze nebo accept analytika.
- Poslední úspěšný dotaz se při opětovném otevření zbytečně nenačítá znovu:
  původní vyprázdnění položek po 300 ms mohlo přerušit rozběhnutý výběr
  klávesnicí. Nový dotaz nadále přerušuje starý a chyba umožňuje retry.
- Následné review opravuje React key warning verzovaným patchem Comboboxu
  a používá API limit 20. Služba vrací Bakalovo nábřeží v Brně při plném názvu,
  ale na `Bakalovo` nic a pro `Boženy Němcové Tábor` jiná města. Oprava
  relevance/pokrytí patří do Smart Address, nepřidává se místní adresní engine.
  Konkrétní reprodukce a podmínka odstranění patche jsou v
  [integračních poznámkách](akros-smart-address-integration.md).
- Tokeny mapují combobox na inputy; popup dědí tokeny bez portálu, celé adresy
  se zalamují, touch target má alespoň 44 px a vrstva je nad sticky hlavičkou.
  Positioner nemá v kitu slot prop, proto má cílené kompoziční CSS.
- Retry je vlastní kit `Button type="button"` ve veřejném footer slotu comboboxu;
  nesmí spustit submit checkoutu. Browser test ověřuje i tuto větev.
- Prošlo 14 šířek, klávesnice/pointer, bounds popupu, obě adresy, neúplný návrh,
  empty/outage/manual input, stará odpověď a reload. Po vizuálním nálezu malého
  textu a vrstvení proběhla oprava a opakování. Testové odpovědi jsou jen v testu.
- První živé ověření vracelo HTTP 503 / Cloudflare 1102. Pozdější dotaz už vrátil
  HTTP 200 se skutečnými RÚIAN adresami, ale bez CORS. Pevný Next rewrite
  `/api/address-suggestions` proto přenáší dotazy na existující službu přes
  stejný origin. Nevytváří databázi, business backend ani volitelný proxy cíl.
  Živý test přes produkční sestavení bez interceptů prošel na 1920 a 390 px:
  skutečný návrh RÚIAN, výběr, doplnění ulice 30/10, města a PSČ. Výsledek je
  v `test-results/task-17-live/report.json` a screenshotech. Lokální integrace
  je ověřená; nové nasazení AKROS se v tomto úkolu neprovádí.

Review: `/kosik/dodaci-udaje` → Změnit fakturační údaje → Ulice, č.p.; totéž
po zapnutí jiné dodací adresy. Při nefunkční službě pokračuje ruční zadání.

Po opravách z review prošel celý `npm run check` (208 testů ve 39 souborech),
adresní regrese na 14 šířkách s 20 návrhy a výškou nejvýše 20 rem, i skutečné
doplnění Bakalova nábřeží 8/8 v Brně na desktopu a mobilu bez interceptů.
Vývojovou React hlášku pokrývá nový komponentový regresní test. Omezení hledání
Boženy Němcové v Táboře zůstává otevřené ve službě; nejde o opravené pokrytí dat.

## Ověření a stav

Průběžné kontroly používají šířky 1920/1440/1280/1101/1100/1024/1023/768/761/760/
640/639/390/320 px. Screenshoty v ignorovaných `test-results/task-12`, `task-13`,
`task-14-15`, `task-16`, `task-17` byly prohlédnuté na desktopu i mobilu.
Výsledky původního průchodu TASK 12–17 před doplněním funkčního dema TASK 12:

- Prošel celý `npm run check`: formatter, lint, TypeScript, **196 testů v 37
  souborech** a produkční build. Při přepnutí mezi běžícím dev serverem a buildem
  byly standardním `next typegen` obnovené generované route typy; žádná diagnostika
  se nepotlačovala. Poslední nastavení comboboxu a český placeholder poté prošly
  lintem, TypeScriptem v novém produkčním buildu a adresní browserovou regresí.
- Sady z `test:browser` prošly po částech: homepage (34 šířek), variantní tabulka
  (22 šířek a dlouhá SKU), košík/shrnutí (23 šířek), checkout, katalog, oblíbené,
  akce, detail/popis/tisk, všech 47/386 variant, filtrace, ceny, shared UI a hledání.
- Nad finálním sestavením prošel účet včetně třikrát rychle opakované regrese
  heslo/PSČ, save/reload a chyby úložiště; dalších 48 layoutů účtových stránek,
  přihlášení/registrace, 120 layoutů obsahu, tokeny a skutečná typografie Inter.
- Široký UI audit prošel **589 layouty na 31 routách**. Nadále zaznamenává
  existující limit kitu 0.56.1 u native checked stavu disabled platebního radia;
  viditelný stav/draft se vyčistí a validace blokuje postup. Nejde o novou regresi.
- TASK 12/13/16 znovu prošly ve všech 14 šířkách. Adresní regrese nejprve
  odhalila, že defaultní autocomplete při ArrowDown přepíše dotaz a zneplatní
  vzdálený výběr. `inputBehavior="none"` řeší příčinu přes podporované props;
  nový test nejdřív reprodukoval chybu a po opravě prošel se všemi 14 šířkami,
  retry bez submitu, částečnými daty, výpadkem, ručním zadáním a starou odpovědí.
- Po poslední opravě opět prošel **živý Smart Address test bez interceptů** na
  desktopu i mobilu, včetně doplnění skutečné adresy RÚIAN přes rewrite.
- Screenshoty každé změněné části byly prohlédnuté a vizuální nálezy opravené.
  Finální formatter/lint a `git diff --check` jsou čisté.

Žádné nové commity, push, deploy nebo změny GitHubu. Závislé backendové části
zůstávají otevřené; společné review se týká popsaného FE výsledku.

### Následné ověření funkčního dema TASK 12

- Celý `npm run check` prošel: formátování, lint, TypeScript, **204 testů ve 38
  souborech** a produkční build. Nové testy pokrývají aktuální ceny, chybějící
  variantu, sloučení, sklad, změnu minima, desetinná množství, neměnnost historie
  a dvojklik. Dvojklik a desetinná nepřesnost byly nejdřív reprodukované červeným
  testem a poté opravené.
- `npm run test:reorder-ui`: historie a detail na 14 šířkách plus skutečné vložení
  do existujícího pojmenovaného košíku ve všech 14 šířkách. Ověřené původní
  položky, sloučení s novou cenou, izolace druhého košíku, reload, dvě různé
  objednávky, nulový sklad, skladový limit, odkaz do košíku a touch target 44 px.
- `npm run test:account`: profil na 9 šířkách včetně save/reload/validace a
  hesla, dalších 48 layoutů účtu, filtrů historie a odpovídajících detailů.
- Checkout prošel 12 šířkami včetně persistence a přepínání pojmenovaných košíků;
  váha znovu prošla všemi 14 šířkami včetně změny množství a odebrání.
- Prohlédnuté screenshoty historie a částečného výsledku na desktopu i mobilu
  jsou v `test-results/reorder`. Nalezené natahování navigačního tlačítka delší
  zprávou je opravené kompozičním CSS. Po poslední vizuální úpravě prošly znovu
  lint, TypeScript v produkčním buildu, všechny šířky TASK 12 a 48 layoutů účtu.
- Testy používají izolovaná browserová úložiště; uživatelův košík se nepřepisuje.
  Vše zůstává bez commitu a bez nasazení.

Ruční review: na `/historie-objednavek` zopakovat `00847` (3 varianty), `00812`
(jedna varianta není skladem) a `00790` (100 původních ks, nyní dostupných 30).
Výsledné přírůstky zohledňují také množství, které už je v aktivním košíku.

Po vizuálním review akcí znovu prošel celý `npm run check` (204 testů),
historie/detail na 14 šířkách, všechny funkční scénáře opakování na 14 šířkách
a 48 layoutů účtu. Browser test nově porovnává výšku řádku a šířky sloupců
před přidáním a po něm; potvrzuje jedinou notifikaci mimo tabulku. Po poslední
změně outlined varianty odkazu prošly lint, TypeScript v novém produkčním buildu
a opakovaný funkční průchod na všech 14 šířkách. Screenshoty byly prohlédnuté
na desktopu i mobilu. Bez commitu.

### Následné vizuální review selectů

Schválená předloha: Figma `7:1992` (pole Země). Společný `CheckoutSelect`
nově používá scope `.akros-select` a soubor
`src/tokens/components/molecules/_akros-select.css`:

- `--color-form-control-bg` a `--color-select-trigger-bg-hover`: bílé pozadí;
- `--padding-select-trigger-sm`: nahoře/dole 20 px, vlevo 24 px a vpravo 8 px;
- `--text-icon-control-sm`: 28 px;
- lokální `--font-weight-normal`: kitový medium pro hodnotu i placeholder.

Výška 60 px, rámeček 2 px, radius 8 px a Inter 20/30 px již odpovídaly návrhu.
Nevznikají pro ně další přepisy. Trigger nemá prop pro zdroj ikony, proto
se jeho `token-icon-select-indicator` mapuje na existující Figma SVG. Kit dál
řídí indikátor a jeho otočení při otevření; odstraněné jsou ručně vkládané
šipky a skrývání původního indikátoru v účtu a historii. Telefonní předvolby
zůstávají ve vlastním scope mimo tuto změnu.

Změna platí pro fakturační/dodací zemi, zemi v účtu, filtry historie a výdejní
místo. Browserová kontrola je dostupná přes `npm run test:selects`; screenshoty
a měření ukládá do ignorovaných `test-results/select-appearance/`.

Kontrola odhalila přetékání delšího vybraného výdejního místa na mobilu.
Panel dopravy/platby proto používá explicitní `grid-cols-1` (`minmax(0, 1fr)`)
místo implicitního sloupce rostoucího podle obsahu. Jde o kompoziční omezení
šířky; vzhled pole nadále řídí tokeny. Součástí browserové regrese je i dlouhá
vybraná pobočka na nejmenší šířce.

Otevřený seznam má přes podporovaný `Select.Content.className` maximální šířku
svého triggeru (`--reference-width` od Zag). Delší texty položek se zalamují
přes `Select.ItemText.className`, takže jsou na mobilu čitelné celé. Samotné
pole má dál jednu řádku. Pod 24 rem se cena dopravy/platby přesouvá pod název,
aby při omezené šířce nepřekrývala jeho text. Browser test kontroluje i skutečné
obdélníky vykresleného textu vůči cenám; nejde jen o kontrolu scrollWidth.

Nad produkčním sestavením prošel profil na 9 šířkách a 48 layoutů účtu, checkout
na 12 šířkách, 61 kontrol typografie / 28 layoutů checkoutu a adresní našeptávač
na 14 šířkách. Celý `npm run check` prošel s 208 testy ve 39 souborech.

Po finálních opravách znovu prošel celý `npm run check` (208/39 a produkční
build), checkout na 12 šířkách i 61 typografických / 28 layoutových kontrol.
`npm run test:selects` prošel 102 kontrolami všech šesti polí na 17 šířkách,
včetně 383/384/385 px, otevření a výběru klávesnicí/myší, otáčení indikátoru,
nezměněných telefonních předvoleb, funkčních filtrů historie a validace/uložení
výdejního místa. Kontroluje také přetékání nabídky i stránky a překryvy názvů
dopravy/plateb s cenou. Vizuálně byly prohlédnuté zavřené selecty na desktopu
a mobilu, celý upravený panel a otevřené zalomené názvy poboček na 320 px.
Vše zůstává bez commitu, push a nasazení.

## Závěrečná kontrola před commity — 23. 10. 2026

Na pokyn uživatele proběhlo nové review celé rozpracované FE části a následné
ověření všech sad, nejen poslední změny selectů:

- `npm run check`: formatter, lint, TypeScript, 208 testů ve 39 souborech
  a produkční build prošly.
- Celý `npm run test:browser` prošel nad produkčním sestavením: homepage na
  34 šířkách, variantní tabulka na 22 a košík/shrnutí na 23 šířkách; dále
  katalog, produktové akce, modal, popisy, úplné variantní výpisy, filtrace,
  ceny, navigace, hledání, účet, formuláře, obsah, tokeny a skutečné fonty.
- Široký audit ověřil 589 rozložení na 31 routách. TASK 12, 13, 16 a 17
  prošly cílenými scénáři na všech 14 šířkách včetně hranic breakpointů.
  Selecty prošly 102 kontrolami šesti polí na 17 šířkách včetně 383/384/385 px.
- Navíc byl proveden společný průchod historie → Objednat znovu → košík →
  změna množství → reload → další opakování na 1920/1024/390/320 px. Váha
  odpovídá konkrétním zdrojovým variantám: 0,238 → 0,306 → 0,544 kg, bez
  duplicitních řádků, přetékání nebo runtime chyb. Výsledek a nové screenshoty
  jsou v ignorovaných `test-results/final-review/`.
- Opět prošel živý Smart Address test bez interceptů na desktopu i mobilu:
  veřejná služba přes rewrite vrací 20 návrhů a doplní Bakalovo nábřeží 8/8.
- Vizuálně byly prohlédnuté nové screenshoty desktopové historie a notifikace,
  částečného opakování na mobilu a košíku/hmotnosti na desktopu i mobilu.
- Kontrola kódu ověřila společný zdroj demo dat, aktuální ceny/sklad,
  zachování jiných položek a pojmenovaných košíků, váhu přesné varianty/SKU/MJ,
  ochranu hesel a chybové/stale stavy adresního klienta. Nový blokující nález
  nebyl zjištěn. Odstraněný byl jen duplicitní dovětek `.gitignore` přidaný CLI,
  který opakoval stávající pravidla a přebil výjimku pro vzorový env soubor.

Známé omezení UI-kitu 0.56.1 u native checked stavu disabled platebního rádia
zůstává reprodukované a evidované: viditelný výběr a checkout draft se vyčistí,
validace blokuje chybný postup. Dále zůstávají uvedené backendové návaznosti
a omezení pokrytí adresní služby. Nejde o nové regrese tohoto FE dokončení.

FE výsledek je připravený ke commitům podle uživatelova pokynu. Commity jsou
rozdělené podle selectů/responzivity, účtu a objednávek, hmotnosti, adresního
klienta a dokumentace. GitHub issues, vzdálené větve a nasazení se tím nemění.
