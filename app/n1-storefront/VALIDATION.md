# Kontrola převodu N1 storefrontu

## C26: skutečný výrobce a rozbalení velikostí — 2026-11-05

Veřejný owner již posílá `sourceProductId`. Audit všech12672 zdrojových řádků
potvrdil, že importovaný parametr Značka vznikl výhradně spojením s producer.title;
žádný původní parametr stejného názvu nekolidoval. N1 nyní dekóduje toto veřejné
pole a promítá výrobce jen z přesného auditovaného importního namespace a právě
jedné neprázdné Značky bez jednotky. Neznámý původ, duplicita ani Bez výrobce
nedostanou odhadnutý údaj. Původní ID se nepředává do prezentačního modelu.
Skutečný Fox Rwt z katalogu má Fox Racing; desktopový řádek nad SKU a mobilní
text odpovídají čerstvým Figma219:2769 a39:2459. CS/EN a escapování textu otestované.
Nezávislé vizuální review přijalo pouze tento region, nikoli celou PDP.

Karta zachovává skutečné první3velikosti/+N z Figma214:3250. Historický N1
variants-box dokládá rozbalení při hover/focus. Knihovní Popover nyní načte
jediný přesný produkt až při interakci: market-aware full slug1, přesná kontrola
ID/slugu, pouze aktivní skutečné názvy/ID. Žádné přednačítání detailů celé mřížky.
Cache32/1min sdílí souběžné požadavky. Chyba ponechá původní3/+N; odkazy vedou
na obyčejný detail a nevybírají variantu ani nepřidávají do košíku.

Skutečný browser1440/390: v klidu0nových variantních požadavků, první hover
1GET a6nativních velikostí. Tab vstoupil do odkazů rozbaleného panelu; jeden
Escape ho zavřel a vrátil focus. Původní opětovné otevření při návratu focusu
bylo nalezeno proklikáním, opraveno a má sekvenční regrese. Dotykové otevření/
zavření fungovalo; panel278px se vešel do390px bez overflow. Kliknutí na mobilní
nabídku zavřelo panel a ponechalo focus v nabídce. Pending unmount potlačuje
aktualizaci React stavu; netvrdíme zrušení sdíleného cache fetch.

Čtecí gateway po skutečně pozorovaném přechodném502 opakuje celý kombinovaný
read s novým contextem, stejně jako409/503; nejvýše3pokusy.401/403 a vadné
kontrakty zůstávají terminální. Žádný Action retry nepřibyl.

421/421testů, lint/TSRS, formát a produkční Next build PASS. Vizuální důkazy
n1-c26-fox-desktop/mobile a n1-c26-card-expanded-desktop/mobile jsou v.local.
Stage má skutečný katalog, ale jeho nákup nemá pozitivní PASS: native dryRun
vrátil403/action_permission_denied, bez zápisu objednávky/skladu. Transport je
shodný s aktuálním AKROS. Oprava oprávnění potřebuje odpovídajícího ownera.

## C22–C25: košík, obnova a konkrétní Figma regiony — 2026-11-05

- C22 rozlišuje pouze šest pevných fází selhání quote. Žádná upstream těla,
  klíče nebo chybové zprávy; origin/scope odmítnutí diagnostiku nedostávají.
  Transportní regrese odlišují gateway403 od decoded native403, nulový/jeden
  Action call, žádný Action retry a redakci markeru z nepřátelské odpovědi.
- C23 uchovává skutečné minimum vybrané varianty v nových košíkových draftech.
  Staré v1 drafy zůstávají kompatibilní bez odhadu owner minima. Fractional
  minimum zůstává podporované; quote stále rozhoduje o ceně/skladu. Živě min1
  v košíku i mini okně, decrement vypnutý, ruční0 blokuje pokračování;
  nadskladové množství odmítl skutečný backend. Žádný nový order tím nevznikl.
- C24 po nativním guest potvrzení obnovuje jen současnou fotografii/slug podle
  přesných ID produktů. Nejvýše50 ID, sériové card dávky24/24/2, celkový deadline2s.
  Chyba, cizí trh/měna, duplicitní/nevyžádané ID nebo timeout ponechá potvrzenou
  objednávku bez těchto volitelných metadat. Historické částky/jména/quantity
  se nepřepisují katalogovými údaji. Transportní a SSR regrese PASS.
- C25 vychází z čerstvých konkrétních uzlů: mobil39:2460/2462/2480 má legendu
  600 a24px odstup, vybranou skutečnou velikost s lokalizovaným „zvoleno“ a celý
  řádek výběru600; popis má mobilně32px okraje. Desktop219:2768 má nativní
  layout mezery20/24/12/16/7/8, bez ikony dostupnosti;7px je app layout alias
  dimension8−dimension1, nikoli změna primitivu nebo interního stylu komponenty.
- Úzký košík25:591 používá skrytý přístupný label, borderless/tertiary Odebrat
  a pod existujícím n1-compact breakpointem skrývá náhled v nativním wrapperu.
- Success372:3126/3357 je Theme/N1#86efac s PAINT alpha15%, nikoli jiná globální
  barva. Nativní banner používá bg-bg-success/15; text/rámeček zůstávají opaque.
  Figma variable defs samy alpha nepředaly; ověřený skutečný paint rozhodl.

Finální399/399 N1 testů, lint a produkční Next build PASS. Skutečné screenshoty
desktop1440/mobile390 a košík320 byly otevřené. Po odstranění draft košíku se
OBJ-2026-0004 znovu načetla pouze přes status; obrázek se načetl, odkaz zachoval
LXL variantId a historická quantity2 i celkem1887. Žádný další place nebyl volán.
DOM success: background alpha0.15, node opacity1, border#15803d, bez overflow.

Nejde o celé vizuální PASS PDP: Figma má komponentové line-height role ceny36
a metadata18 a desktop dostupnost18/28; instalovaný i poslední publikovaný
kit0.57.0 tento responzivní kontrakt neobsahuje. Mobilní struktura záložek
a další skutečné API mezery zůstávají otevřené. Nepřidáváme prázdné min-height,
globální typografické přepisy, výrobce/ETA/guide/related fixtures ani falešný
e-mail/platbu. Lokální /api/account vrací503 kvůli chybějícímu identity runtime;
proto celá konzole není prohlášena za čistou a pozitivní Portal tok za ověřený.

## Navazující košík: doložená kompozice

Figma25:591 (skutečně znovu načtený kontext i screenshot) nastavuje QuantityField
size md/hideLabel a Odebrat size md/tertiary/borderless. CartRow nyní používá
přesně tyto veřejné props, nikoli vlastní CSS nebo změnu základních tokenů.
Skrytý label ponechává přístupný název množství s konkrétním produktem.
Živě320px náhled skrytý, label pouze pro čtečku, Odebrat bez rámečku;
žádný horizontální overflow. Viz C22–C25 výše.

## C21: skutečná hierarchie na detailu produktu — 2026-11-04

Veřejné API již předává categoryId; N1 dekodér jej zahazoval. Nyní detail
používá přesné ID a existující cycle-safe categoryTrail nad skutečným stromem.
Duplicitní názvy, chybějící členství ani neznámé ID nevedou k odhadům podle názvu.
Breadcrumb je kompozice UI kitu s NextLink a skutečnými lokalizovanými slugy;
tokeny ani komponentové styly se nemění.

370/370 N1 testů PASS, lint, formátování a cílený TSRS typecheck PASS.
Nezávislé source review bez blokátorů. Živě1440/390px: Northwave cesta
Domů/Dámské/Cyklo/Oblečení/Návleky/produkt, kliknutí Návleky otevřelo správnou
kategorii, žádný horizontální overflow. Screenshoty n1-c21-breadcrumb-* v .local.
Referencí jsou Figma219:2739 a mobil39:2431. Mobilní fixture má kratší větev;
neprokazuje univerzální algoritmus zkracování, proto jej nevymýšlíme.
Jde o ověření této konkrétní oblasti, nikoli vizuální přijetí celé PDP.

## Živý lokální checkout — 2026-11-04

UI průchod od varianty přes quote a checkout jednou vytvořil OBJ-2026-0004.
Nativní read-only kontrola potvrdila objednávku NEW/STOREFRONT, Northwave LXL2ks,
zboží1758Kč, PPL129Kč, celkem1887Kč a DPH327,50Kč. Právě jeden ORDER pohyb−2
odpovídá řádku objednávky; zásoba25→23. Načtení podrobností i obnova po reloadu
vrátily stejnou objednávku. Žádná druhá objednávka nebyla odeslána.
Konzole tohoto průchodu bez error/warn. Soukromý důkaz bez osobních údajů
je .local/n1-order-verification/local/OBJ-2026-0004.json.

Stage nadále vrací403 při quote, takže jeho checkout není tímto testem potvrzen.
Test neprovádí platbu, e-mailovou expedici ani skutečnou přepravu.

## C19: cena bez nepodloženého prefixu — 2026-11-04

Aktuální Figma39:2031 používá PriceBlockknown. Historický N1 renderer prefix
nepřidává, ale používá první variantu a na detailu má chybný přenos její ceny.
Přebíráme pouze doloženou prezentaci bez „od“; skutečné owner částky, měna,
variantní výběr a gross/net ochrany se nemění. Počet variant neprokazuje cenové
rozpětí. Výběr první varianty ani chybné historické přepínání cen se nekopírují.

362/362N1 testů PASS; cílené cenové/selection testy navíc ověřují skutečnou
dražší variantu90000/net74380 oproti skupině45000 a návrat při zrušeném/neznámém
výběru. Lint změněných souborů PASS. Nezávislé source i skutečné screenshot
review potvrzuje jen odstranění prefixu a zachování konkrétních cenových stavů.

Živě na localhost3071 v Next dev režimu (bez produkčního BE buildu): desktop1440
a mobil390, Northwave skupina879 bez prefixu/quantity; LXL879/net726,45/stock25
se správným quantity. Homepage deset skutečných cen bez prefixu, mobilní cena
nad CTA; bez horizontálního overflow a bez console error/warn v kontrolované
home navigaci. Soukromé screenshoty `n1-c19-*` jsou v .local.

Tato oprava nerozhoduje novou politiku reprezentativní skupinové ceny; zachovává
dosavadní owner minimum. Celé karty/PDP nejsou přijaté, další regiony a živé
size-preview ověření zůstávají otevřené. Lokální runtime zatím preview nevrací.

## C18: omezený náhled variant na kartách — rozpracováno2026-11-04

Uživatelem schválená změna veřejného Merchandise kontraktu přidává nepovinné
`storefrontVariantPreview: {total, variants:[{id,name}]}` s nejvýše3položkami.
Preview vzniká ve stejném SQL snapshotu jako stránka, pouze pro aktivní prodejné
varianty stejného tenanta, legal entity a produktu. Nepřepíná listing na full,
nehydratuje celé variantní dokumenty, nemění card24/full2 ani uložená data.

Finální N1 sada360/360 a Merchandise unit sada361/361 PASS; workspace typecheck,
lint změněných souborů a format PASS. Nezávislé statické review kontraktu PASS.
Po výslovné výjimce uživatele pro interní načtení izolované testovací konfigurace
prošlo všech55 PostgreSQL katalogových integračních testů na lokální DB5434.
Nové regrese ověřují3náhledy/celkovýpočet, prázdné preview, card24/page2 a full2;
ostatní pokrývají mj. market/scope/publication filtry. Testy používají náhodné
dočasné tenant/legal scopes s úklidem, nikoli změny živých dat N1.

Povinné `pnpm check --concurrency 1` hlásí zastaralý generovaný manifest Party
Registry mimo tento diff; po této chybě byl běh přerušen, není celý PASS.
Obnovu nesouvisejícího manifestu schvalovací kontrola odmítla jako změnu mimo
schválený rozsah. Zdrojové ani generované soubory Party Registry se neměnily.
Úzký preview backport nad původní runtime verzí ultramodern.17 má navíc35/35
katalogových PostgreSQL testů PASS; je pouze lokální přípravou runtime artefaktů.

Runtime BE/FE této změny, desktop/mobile screenshot comparison a historické
hover/focus rozbalení všech velikostí nejsou touto kontrolou potvrzené.
Celé karty/PDP zůstávají nedokončené; dílčí test PASS neznamená vizuální přijetí.

## C17: PDP projekce a kompozice — 2026-11-04

358/358N1testů PASS i po aktualizaci upstream na4e8dc03cd; produkční build,
kanonický lint, format check,447token theme check a i18n boundaries PASS.
Nové red/green testy pokrývají skutečný net/tier pár, nejednoznačné nebo chybějící
částky, foreign currency, unknown/untracked stock a selectedvariant vs aggregate.
Review našlo missing/zero summary případ; dvě regresní reprodukce a oprava
nepřipustí parent net/count, pokud produkt obsahuje aktivní varianty.

Actual desktop1440 i mobil390 skutečně otevřeny: LXL25ks → SM14ks, obě varianty
879Kč + explicitní owner net726,45Kč. Žádný dopočet DPH/FX ani přisouzení skupinového
skladu konkrétní velikosti. Popis po přepnutí na sizes zůstává viditelný; desktop
parameters H2 má18/28/700, mobil tento další H2 nemá. Missingguide title24/36/600,
p16/gap24. Gallery gap desktop4/4 a mobil16. Striped parametry skutečně střídají
RGB232 a246. Search všech8 actual obrázků48×48/contain; dlouhé návleky řádky
nerozšiřují. Homepage mobile cena nad CTA/gap0, desktop row/gap16. Bez overflow
a console error/warn v kontrolovaných stavech. Nezávislý code a bounded visual
review bez nového blokátoru; PNG jsou v .local/n1-c17-*.png. Žádná objednávka
nebo zákaznický/inquiry zápis nebyl při tomto ověření vytvořen.

C17 neopravuje přesný desktop Tabs graystrip/indicator/density, selectedvariant
stockcorner nebo veškerou Availability typografii. Parametrové řádky mají33px
oproti návrhovým37: DataTable size-sm sdílí Table text14 s účtem, potřebná
oddělená body typography role dosud není veřejná. Globální přepis Table sm
kvůli PDP ani per-instance CSS není použitý. Manufacturer/sizeguide URL/related
a shipping ETA zůstávají bez skutečné native capability; nejde o whole-PDP PASS.

Upstream přešel na effect-tsgo --tsrs-lint a odstranil standalone tsgolint.
N1 lint script nyní používá stejný workspace řetězec a stávající pravidla;
závislosti/lockfile se tím nemění. Poslední celkový pnpm check z C16 měl chyby
mimo N1 a nebyl dokončený; tento cílený výsledek není tvrzení zeleného celé-repo
gate. Normální commit/push hooky se spouštějí samostatně a neobcházejí se.

## C16: nákupní stavy PDP — 2026-11-04

Po aktualizaci na3db193758:335/335N1testů, lint, produkční build a i18n
boundaries PASS. Regresní testy před opravou prokázaly quantity navíc v no-selection
a mobile sold-out; po opravě procházejí. Chyba storage/scope zůstává odlišená
od skutečného stock unavailable. Static review včetně vytaženého purchase predicate
PASS; žádné vlastní styly kit komponent nebo změna kanonického theme.

Skutečný localhost3071 desktop1440: klik na increment1→2, add→quantity1, toast
s popisem2×produkt+varianta; bez post-add Košík tlačítka a default quote odstavce.
Mobil390 bez varianty:0viditelných spinbuttonů, jediný disabled selection CTA
358×44px, documentWidth390. Screenshoty desktopu a celého mobilu skutečně otevřeny.
Mobilní sold-out je ověřený SSR regresí; v dosud dokončeném stock prefixu nebyl
nalezen vhodný skutečně vyprodaný produkt, takže živý sold-out PASS netvrdíme.

Celkový pnpm check není zelený ani kompletně dokončený: prokázal stale generovaný
Party Registry module manifest a KnipModelError v lokálním netrackovaném
scripts/figma/generate-business-theme.mts. Typecheck a OntOS API boundaries prošly.
Po těchto chybách byl zbývající běh šetrně ukončen, aby neblokoval cílené FE ověření;
log zůstává v .local. Cizí soubory a kontrolní pravidla nebyly měněny.

Finální gutter build PASS. Desktop1440/client1425: article1280, padding16+16,
heading x88.5; bez horizontálního overflow a bez console error/warn. Finální
screenshot skutečně otevřený. Mobilní padding se touto změnou nemění.

Nejde o vizuální PASS celého PDP. Čerstvé Figma podstromy a přesné legacy
interakce jsou mapované v COMPONENT-MAPPING.md; metadata/tax/count/related a
veřejný selected desktop variant appearance mají dál konkrétní datové/API mezery.

## C12: native password recovery — 2026-11-04

318/318 testů, lint a produkční build PASS. Testy skutečného generovaného klienta
přes Effect Fetch seam pokrývají request/reset body, anti-enumeration, uzavřený
payload, Origin, duplicitní cookie, native rejection/reconciliation/nejistý write,
jediné odeslání a terminální odstranění tokenu. UI SSR testy nepřipustí password
form bez server cookie-presence proof a nikdy nevykreslují token input.

Desktop1440 a mobil390 skutečně prohlédnuty: request CS/EN, reset s testovací
cookie a missing-token stav. Funkční login odkaz vede do recovery formuláře;
desktop šířka448, žádný overflow/console error. Kompozice vychází z auth333:4671,
ne z neexistujícího samostatného reset Figma rámce.

Cross-site navigace z localhost3099 na127.0.0.1:3071 callback reprodukovala Strict
chybu: po303 chyběla cookie ve SSR a pomohl až reload. S Lax cookie tentýž skutečný
click po vyčištění test cookie ihned vykreslil2passwordfields bez reloadu. URL byla
čistá `/cs/obnova-hesla`; syntetický token nebyl v DOM ani flight HTML. Origin+JSON
guard zůstal zachovaný; platná cookie s cizím Origin vrací403 před native I/O.
Testovací cookie byla po kontrole odstraněná, neproběhl mail ani password POST.

Skutečný e-mail→N1 callback a pozitivní změna hesla nejsou live ověřené. Owner
určuje mail origin přes `COMMERCE_PORTAL_AUTH_URL`; integrační hranice a potřebné
deployment směrování jsou popsané v INTEGRATION.md. Není zavedený runtime mock
mailu, účtu, token validity nebo přihlášení.

## C11: přístupné ovládání množství — 2026-11-04

Browser odhalil anglické výchozí názvy QuantityField tlačítek na českém produktu
a košíku. Veřejné zděděné NumericInput `translations` nyní dostávají existující
dictionary increment/decrement popisky; bez zásahu do kitu nebo jeho vzhledu.
LineItem.Remove sám doplňuje titul produktu: předáváme jen akční label, takže
název není dvakrát. Před volbou varianty purchase helper vysvětluje „Zvolte variantu“
místo obecné nedostupnosti nákupu.

Živý lokální390 browser potvrdil české názvy, quantity1→2→1, přidání vybrané LXL,
skutečný owner quote dvou položek1728Kč a následné odebrání pouze testem přidané
položky. Původní položka zůstala zachovaná. Neproběhla další objednávka ani platba.
Košík bez overflow/console chyb. Produkční build a N1 suite295/295 PASS.
Mezitím skončený lokální owner proces byl obnoven stejným launcherem nad stávající
izolovanou DB; žádný reset, import sample ani změna oprávnění nebyly potřeba.

## C10: navigace, katalog a detail — 2026-11-04

Čerstvé Figma čtení ověřilo nav170:2077 skutečně16/bold700, kategorie214:3203
nadpis32/underline28, count214:3240 výšku55/font14/21/p16/gap4. Produkt219:2758
má vlastní nadpis36/underline32; mobil39:2453 text32/48 bez varianty v nadpisu.
Shipping219:2816/39:2497 je skutečný Link do dopravy, nikoli další tlačítko.

Produkční1440 a390 prohlédnuty se skutečným lokálním katalogem. Computed styly
potvrzují tyto rozměry i nav16/bold. Mobilní produkt zachovává selected variantu
před dostupností a shipping mezi cenou a QuantityField. Link skutečně naviguje
na `/cs/doprava`, která z owner nabídky ukazuje PPL129Kč a Českou poštu119Kč.
Desktop ani mobil nepřetéká; opravené screenshoty byly otevřeny, ne pouze uložené.
Mobilní počet zůstává „Nalezeno2“, desktop používá skutečné total a český plurál.
EN počet nelze označit za živě ověřený: lokální EN katalog vrací unavailable;
anglická větev ani tento datový stav se nenahrazují CS daty.

N1 testy295/295, lint a produkční build PASS. Nezávislé source review nenašlo novou
P1/P2 chybu. Není to plný vizuální PASS produktu: desktopový selected-variant button,
podkategorijní instance a některé Link metriky nemají přesný knihovní prop/role;
související produkty, skladový max/ETA, výrobce a další fixture údaje bez owner
projekce nejsou doplněné vymyšlenými daty. NumericInput compact104×36 a mobilní
QuantityField používají platné API instalovaného balíčku; starší příklad ve skillu
není důvod měnit string value/onValueChange zpět na zastaralé props.

## C9: katalogový strom — 2026-11-04

Figma `214:3169`: skutečně vyhodnocené variables určují text16/24, nadpis700,
řádky32, padding panelu8 a fill-hover `#f6f6f6`. Generovaný fallback20 není
skutečná hodnota proměnné. Kategorie používá veřejné compound části TreeView,
bez folder/file ikon a indent guides; existující sémantické ikony jsou plus/minus.
Kanonický N1 theme se nekopíruje ani nepřepisuje vlastní paletou.

Produkční browser1440: panel256, text16/24, nadpis700, řádek32, šedé pozadí
a skutečné SVG masky plus/minus ověřeny přes computed styles. ArrowLeft zavře
fokusovanou větev, ArrowRight ji otevře; URL se nemění. Kliknutí na text kategorie
naviguje na skutečný slug. Mobil390: otevření „Procházet kategorie“, strom342,
řádky32, scrollWidth390 bez horizontálního přetékání. Desktop i mobil zachyceny
a otevřeny; nejedná se o tvrzení úplné shody celého katalogu. Podkategorijní
tlačítka mají stále odlišné instance oproti Figmě a budou řešena samostatně.

N1 testy295/295, lint a produkční build prošly. Zdrojové review nepotvrdilo novou
P1/P2 chybu; nativní Zag collection/selection/focus zůstává zachován.

Nejnovější stav je popsán v závěrečné sekci „Integration checkpoint before the work-in-progress commit“;
starší části níže zachovávají výsledky svých předchozích běhů.

## Aktuální pokračování: portal login a enrollment

Navazuje na push baseline `77d89dc53`. User potvrdil napojení podle Akrosu na
existující OntOS API. Přidané session/enrollment/recovery adaptéry neimplementují
nový backend ani runtime mock. Scope je N1 a nutné workspace závislosti.

Fresh čtecí Figma session `52f1ec68-61cc-4343-83f7-ed710c5270c3`; skutečně otevřené
design contexty a screenshoty login333:4671/5192 a registrace333:5341/5536.
Osm dev kontrol (CS1440/390/320 + EN390, oba módy) bez overflow, console/pageerror,
hydration chyby či business POST. Layout a kit props jsou popsané v COMPONENT-MAPPING.
Kanonické primary tlačítko, label/link metriky a radius se liší od Figma instancí;
nejde o tvrzení úplné pixelové shody. Footer registrace je opraven na „Přihlaste se“.

Nezávislé integrační review našlo a následně ověřilo opravu dvou mezer:
verification callback a explicitní enrollment resume. Provider vždy přidává
callbackURL, standardně `/`; N1 ho přijme nejvýše jednou do2048 znaků, zahodí ho
a předává pouze jediný validní token. Ověření používá skutečný generovaný veřejný
owner klient s čerstvým assertion a bez cookies/Origin. Není automatický retry.
Pevný303 redirect neobsahuje token; response má no-store/no-referrer a nepřenáší
owner cookies. Callback notice nikdy nepřiznává session. Resumed COMPLETE vyžaduje
nové customer admission; nejistý výsledek ani reconciliation neopakuje zápis.

Nové testy nejprve selhaly na404/400 a skutečném provider query tvaru. Finální suite
má127 testů. Transportní testy poskytují Effect Fetch referenci pouze v testech:
skutečný handler a veřejný generovaný klient, přesný gateway + owner call,
success/reconciliation/503, pevný redirect a izolace cookies. Nejde o runtime mock.
Password12..128 pochází z owner kontraktu, ne z8znakové Figma fixture.

Produkční browser: login1440, registrace390, invalid notice390/320, verified notice390
a reconciliation notice390; šest screenshotů skutečně otevřených, HTTP200,
žádný overflow, console/pageerror/hydration nález ani business POST. Skutečný GET
callback bez tokenu vrací303 na token-free invalid landing. Query notice rendering
není důkaz skutečného ověření e-mailu nebo účtu. Verified nabízí login, reconciliation
jen bezpečné čtení; screenshoty nepředstírají owner úspěch.

Plná gate367/371, stejné čtyři neúspěšné testy mimo N1 jako po pullu:
native-data-factory-proof, dva no-service-constructor-imports a repository-policy.
N1 není v diagnostikách. Řetězec se zastavil na lint-rule testech; pozdější globální
kroky nejsou tímto během ověřené. Samostatné i18n:boundaries má12 nálezů mimo N1.
Scope lint, formát,447token theme a produkční build se ověřují samostatně.

Úspěšné N1 login/signup a produkty zůstávají runtime neověřené. MFA completion,
forgotten-password a account/order obrazovky zatím nejsou součástí této implementace.

### Lokální backend po povolení načtení konfigurace (2026-11-03)

Uživatel výslovně povolil interní načtení `.env` aplikací a prozkoumání backendu.
Byly ověřené pouze přítomnost a lokálnost konfigurace; její obsah ani klíče se
nevypisovaly. Runtime a issuer DB míří na lokální Docker5433, SpiceDB na50051.
Shell3020 a merchandise4123 byly spuštěné bez resetu, migrací, seedů nebo přepisů
oprávnění. Market4109 a customer-context4101 neběží. Merchandise používá existující
serve artefakt se starším shared-source fingerprintem: odezva nedokazuje shodu
s aktuálními zdroji. N1 produkční server3071 zůstává spuštěný.

Přes veřejné API proběhlo přihlášení dokumentovaným lokálním demo účtem200.
Veřejné čtení tenantů200 vrací1 viditelný tenant, čtení firem200 vrací5 viditelných
firem; názvům N1/N Distribution nic neodpovídá. Je to rozsah viditelný tomuto účtu,
nikoli důkaz, že N1 neexistuje v jiném tenantu, pod jiným názvem nebo na serveru.
Samotné porty Docker DB/SpiceDB/Mailpit ani owner route nejsou důkaz katalogových dat.

Veřejné composition čtení vrací503 `ShellCapabilityUnavailableProblem`; Shell
hlásí `InstalledModuleCatalogUnavailableError`. Katalog proto nejde ověřit přes
governed gateway. Owner route bez assertion odpovídá400 `RecordsInvalidProblem`,
což dokazuje pouze dostupnou routu. Nevznikla náhradní revision ani obejití gateway.
Kanonický composition publisher není pouze read-only server: může inicializovat
authority schema, drainovat práci a měnit authority; nebyl proto spuštěný jako
pouhý diagnostický GET. `up.sh` rovněž zahrnuje migrace/seedy a přepis grantů.

V lokální konfiguraci chybí `ONTOS_N1_STOREFRONT_API_KEY`,
`ONTOS_STOREFRONT_TENANT_ID` a `ONTOS_STOREFRONT_LEGAL_ENTITY_ID`. Commerce Portal
realm není nastavený. N1 search zůstává unavailable a account503; klíč/identita
Akrosu nebyly převzaté. Další runtime předpoklady jsou fungující composition,
skutečné N1 přiřazení klient/tenant/seller a aktivní N1 B2C market asociace.
Teprve následné autorizované owner čtení může potvrdit import produktů.

Backendové zdroje zůstaly beze změny, index prázdný, žádný nový commit/push.
Uživatel omezil další commity pouze na `app/n1-storefront/`; existující lokální
workspace změny a veškerá `.local` evidence se do Gitu nepřidávají. Runtime
konfigurační výjimka nenahrazuje toto omezení.

Evidence `.local/n1-review/2026-11-03-auth-continuation/`. Následující baseline
a starší výsledky jsou historie, nikoli potvrzení těchto zbývajících bodů.

## Baseline pro první commit po aktualizaci demo větve

Základ aktualizován fast-forwardem na `44c987a3c` (45 commitů), bez konfliktů.
Commit obsahuje samostatný N1 CS/EN shell, homepage, katalog, detail, skutečné
hledání a kontakty nad existujícími veřejnými API, kanonických447 tokenů a assety.
Auth/registrace/účet/checkout do tohoto commitu nepatří. Žádný nový backend,
provisioning, runtime mock ani import soukromé implementace jiné aplikace.

Přesný vybraný rozsah prošel84 testy, lintem, frozen instalací a čistým produkčním
buildem včetně TypeScriptu po pullu. Normalizace veřejného originu je sdílená
infrastruktura Next kanálu; její nezávislé testy jsou `tests/request-origin.test.ts`.
Staré vygenerované Next typy od odložených auth rout odstranila čerstvá kompilace;
žádné pravidlo/exclude nebylo upraveno kvůli jejich potlačení.

Produkční baseline smoke po pullu: home1440 a kontakty390 bez overflow, console
či pageerror, screenshoty skutečně otevřené. Žádné auth odkazy a přímé přihlášení404.
Žádný business POST. Naplněné N1 owner stavy nadále nejsou vizuálně potvrzené.

Plná gate po pullu367/371, čtyři neúspěšné testy mimo N1: native-data-factory-proof,
dva případy no-service-constructor-imports a repository-policy. Nové N1 diagnostiky
nejsou v reportu. Testy Core míří i na změněné/migrované upstream zdroje; další policy
nálezy jsou ve zbytku checkoutu. Nejsou opravované rozšířením N1 scope ani skryté.
Řetězec se zastavil na lint-rule testech, následné globální kroky nebyly ověřené.
Historické počty a důkazy níže nejsou výsledkem tohoto běhu.

Evidence `.local/n1-review/2026-11-03-baseline-commit/`; lokální evidence není součást
commitu. Commit používá běžné hooky bez bypassu.

## Aktuální pokračování: kontakty a opravy kompozice

Čtecí Figma session `fc726167-f2e2-44b1-9781-a83a73bcafd0`; kontakty main
`369:2578/369:2758`, hero `33:771/34:954`. Mapování v COMPONENT-MAPPING.md.
Krátký seznam kontaktů nahradila celá kompozice: reklamační a provozní adresa,
tel/mail odkazy, dvousloupcový FormInput/FormTextarea a Button. Odstranění optional
Carousel.Control řeší bílé plochy/padding bez appearance CSS. Novinky v navigaci
nezávisí na dostupnosti katalogu. Zbývající rozdíly canonical vs instance jsou přiznané.

Kontakty používají veřejný work-tasks generated client; nejde o nový backend ani
potvrzení bez ownera. Nezávislý review ověřuje N1 server identity, fresh write
assertion s Bearer po redeemed read, opakování jen explicitního revision conflict
a matching tenant/requestId/taskRef pro success. Neznámý výsledek se neopakuje.
Review nalezl synchronní completion race po validaci: opravena uložením fiberu před
registrací observeru. Regresní test ověřuje warmed runtime → whitespace invalid →
valid retry; 11 inquiry testů prošlo.

Dvě nové deklarace jsou existující workspace work-tasks a shared-contracts, bez
nových externích verzí. `exactOptionalPropertyTypes:true` sjednocuje N1 s workspace
base; odstranilo Core chyby vyvolané jinou optional sémantikou. Dvě N1 optional
předání jsou opravena bez změny měnové sémantiky (Struct.pick zachová absenci měny).

Dev browser: CS kontakty1440/390/320, EN390, screenshoty skutečně otevřené.
HTTP200, žádný overflow/console/pageerror/business POST; gutter40, kolony552/147,
gap16, asociované labely a správné tel/mail. První hero průchod během HMR zachytil
hydration warning hledání; následující izolovaný čerstvý GET jej nereprodukoval.
Rozhodující je produkční smoke po finálním buildu.

Finální produkční browser: kontakty CS1440/390/320 a EN390, home1440/390.
Bez overflow, console/pageerror a hydratačních warningů. Labely/required a nativní
prázdný submit ověřené bez business POST; klik Novinky vede na skutečnou routu.
Negativní lokální API testy: cizí origin403 a neplatné DTO400, oba před owner voláním.
N1 úspěšný zápis/grants zůstávají runtime neověřené. 74 testů, lint, typecheck,
format, theme:check a produkční build prošly. Po poslední serverové Match opravě
byly znovu spuštěné testy i build; UI se proti produkčnímu browser důkazu neměnilo.

Plná gate při opakování369/371, bez timeoutu. Vedle dvou existujících selhávajících
testů obsahovala policy diagnostika i5 nových N1 tag zápisů. Ty byly opravené přes
Match.tag bez změny pravidel. Následný přesný celorepozitářový repository-policy
recheck už neobsahuje žádný N1 nález; zbývají ostatní dříve existující diagnostiky.
Celá371-testová gate se po této poslední opravě znovu neopakovala. Řetězec dál za
selháním lint-rule testů nebyl ověřen; nejde o PASS celého repozitáře.
Samostatné i18n:boundaries má11 Shell chyb mimo N1.

Evidence `.local/n1-review/2026-11-02-figma-transfer/`, zejména production screenshoty,
repository-final a policy-final logy. Bez commitů, push/deploy, změn backendu/Figmy/kitu
nebo runtime mocků. GitHub byl pouze fetch: lokální HEAD a94937205, origin2f08a5fcf,
21 commitů napřed, bez překryvu souborů při kontrole; pull nebyl proveden.

## Předchozí přírůstek: kanonické Theme/N1 a správná tokenová kaskáda

Uživatel upřesnil jako autoritu [New Design System / Theme / N1](https://www.figma.com/design/gi5GUSWwAeXknaKEeLqK5w/New-Design-System?node-id=2667-2).
Čtecí session `0397b40e-b436-4ebb-bf27-114466df5aa0`, kolekce Theme, mode4082:0.
`n1.json` nyní obsahuje všech 447 kanonických proměnných. Starý 418-tokenový mix
222 Theme položek, 186 sdílených komponentových snapshotů a 10 lokálních App overrides
byl odstraněn. Předchozí soubory jsou jen důkaz v `.local/n1-review/theme-correction-before/`.

- Všechny kanonické názvy již registruje instalovaný kit. Generované `n1.css` pouze
  aktivuje přesné hodnoty/aliasy jako jeden unlayered `[data-theme="n1"]` za knihovnou.
- `globals.css`: importy, nutná content registration a metadata aplikačního layoutu.
  Žádná `n1-*-tokens` třída ani kopie per-instance komponentových defaultů.
- `tokens/storefront.css`: řídké společné aliasy Header/Footer tmavých slotů a
  full-bleed footer layout. Kit pro tyto organismy nemá tone prop. Žádná nová paleta,
  lokální shadow reset, rozměry Button/Input ani vlastní produktová typografie.
- Header používá Actions/ActionItem a current/unstyled Button pro dědění barvy menu;
  kontaktní a adresní tokenové wrappery patky jsou odstraněné.
- Typovaný Effect renderer ověřuje kanonickou identitu, úplné Schema, kolize
  normalizovaných názvů a neexistující/cyklické aliasy. Opacity/font-weight jsou
  skaláry, duration sekundy, brightness procenta, délky px, STRING CSS se zachovává.
  CLI používá FileSystem, effect/cli a NodeServices, žádný throw/fetch/argv parser
  nebo úprava pravidel. Dev dependency pouze deklaruje již workspace používaný
  `@effect/platform-node` ve stejné verzi; žádná UI závislost se nemění.

Použité skutečné reference v `new-engine/libs/ui/skills/`: workflow orchestrator,
component usage, app-token-initialization, app-token-overrides, tailwind-token-authoring,
app-ui-kit-audit; API a runtime vždy porovnané s instalovaným 0.57.0. Starší názvy
adopt-ui-kit-in-app a app-component-inventory nejsou v této kopii dostupné.
Referenční skilly se nepovažují za důkaz, že jejich novější balíčkové chování již
existuje v 0.57.0. Konkrétní rozdíl: odstranění explicitního @source při prvním
průchodu přestalo generovat kit utility; nezávislý browser nález byl opraven
obnovením content registration. Nejde o povolení obnovit vzhledové scopes.

Nezávislý kontraktový reviewer potvrdil source, jednotky, kaskádu a veřejné slots
bez blokujícího nálezu. Browser po opravě registrace ověřil všech 447 výsledných
hodnot: primary base/hover/active #ffe710/#ffdd00/#ffc700, oba on-primary #141414,
duration-slow3s, brightness100%, opacity přibližně0.6. Context class count0.
Header#141414, footer#333, skutečný retry390358×44 a radius2, menu bílé a ovladatelné
Enterem, žádné přetékání při1440/1920/390/320. Čerstvé načtení bez hydratačních chyb.

Přiznané rozdíly proti instančně upravené storefront Figmě: patka má knihovní
typografické metriky (přibližně346desktop/664mobile místo předchozích291/550),
carousel knihovní controls/indikátor, search footer44/radius2 místo36/square a status
text v kanonické foreground místo lokální modré. Nejsou schované dalšími tokenovými
třídami a nejsou vydávané za 1:1 vizuální PASS. Naplněné owner stavy nadále chybí.

63 testů a theme:check prošly, lint zahrnující scripts a typecheck prošly.
Produkční build prošel. Finální produkční browser smoke ověřil 447/447 tokenů
(po sémantické normalizaci minifikovaných CSS barev), nulové context classes,
menu/retry/search bez přetékání, console warning/error a hydratačních chyb.
PNG logo patky používá podporovaný NextImage fill v layout wrapperu s poměrem322/78;
původní warning při frakčním zaokrouhlení obou rozměrů se už neobjevuje.
Evidence `.local/n1-review/2026-11-02-theme/n1-theme-production-*`.

Plná gate doběhla:369/371 lint-rule testů, dva existující neúspěchy mimo N1
(`no-service-constructor-imports.test.mts` a `repository-policy.test.mts`).
Žádný diagnostický nález v N1; řetězec se zastavil v lint-rule testech, navazující
celorepozitářové kroky proto nejsou označené za ověřené. Log
`.local/n1-review/2026-11-02-theme/n1-theme-repository-check.log`.
Žádné commity, push, deploy, úpravy knihovny ani runtime mocky.
Vývojový server byl po produkční kontrole obnoven na http://127.0.0.1:3071 (HTTP200).

## Předchozí přírůstek: inventář, kategorie a plný detail

Figma session `a9159725-64c3-4266-80d6-c4c922c33291`; nezávislá vizuální session
`91737d15-649e-4679-8126-6071bc134ef2`. Úplné top-level rámce a všech 16 hlavních
typů obrazovek jsou v `FIGMA-INVENTORY.md`; žádný fixture produkt nebo objednávka
z návrhu není runtime data.

- Kategorie: owner strom a breadcrumb, skutečné podkategorie a celkový počet,
  URL page předaná ownerovi, knihovní Pagination. Hledání při stránkování zachovává q.
- Mobilní karty mají vlastní kompozici `38:2185`: obrázek před názvem, PriceBlock,
  AvailabilityStatus, outlined detail. Homepage si zachovává vlastní skladbu.
- Full decoder zachovává owner gallery, descriptionParagraphs, parameters a aktivní
  variantRecords. Varianty mají vlastní cenu, stock, minimum i unit. Opaque variantId
  se sdílí URL; neznámé ID nevybere cizí variantu. React key resetuje galerii/množství.
- Gallery používá pouze povolené skutečné HTTPS obrázky. Předaná prázdná gallery
  nesmí vrátit starou imageSrc. Core Media není nahrazeno odvozenými URL.
- Mobilní QuantityField a nákup zůstávají disabled do skutečné cart/quote integrace;
  nejsou vložené návrhové limity 1–3 ks, ceny, značky ani termíny doručení.
- Produktové Tabs jsou knihovní. Parametry respektují Code Connect `219:2884`:
  DataTable hideHeader, bez sortingu, line na mobilu a striped na desktopu.
- Route loading používá knihovní Skeleton; nedostupnost má skutečné router.refresh
  retry. Není vydávaná za empty/not-found ani za konkrétní vyprodaný produkt.

Nezávislý code reviewer nalezl a root opravil neplatný browse trigger při
unconfigured marketu, zachování starého indexu galerie po výběru varianty,
nerespektovanou owner gallery a rodičovské minimum/unit vybrané varianty.
Mobilní kategorie při otevření stromu nyní zachovává viditelný h1.

Skutečný browser: kategorie a produkt při 1440/1920/390/320, angličtina při 390.
HTTP 200 unavailable, právě jeden h1, bez horizontálního přetékání, správné html.lang
a copy, bez console warning/error a pageerror. Retry provedlo další RSC GET 200 a
zachovalo category?page=2. Cílený recheck po opravě: category heading 32/48,
product heading 24/36, oba retry 358×44 při 390. Screenshoty byly skutečně otevřené.
Evidence `/tmp/n1-catalog-wave-*`; finální kopie se ukládají do `.local/n1-review/`.

Limity: na localhost:3020 není Shell listener. Přesná runtime příčina konfigurace
není veřejným unavailable DTO rozlišená; žádná `.env` nebyla čtená. Naplněné karty,
galerie, parametry, varianty, loading při skutečném pomalém owner čtení, browse a
paginace mají zatím unit/type/build důkazy, nikoliv naplněný vizuální PASS.
Chybí skutečný media přístup pro N1: owner guard rozpoznává jen konkrétní demo
prodávající entity a pro ostatní vyžaduje staff readAll. Tato práce jej neobchází.
Desktopové size chips, related products, výrobce, daňový rozpad a doručení nejsou
vymyšlené; čekají na doložené owner podklady/integraci. Tabs na úzkém mobilu dovolují
horizontální posun místo CSS zásahu do knihovního zalamování triggeru.

Kontroly: 58 testů prošlo, včetně skutečného server renderu celé naplněné produktové
kompozice nad označeným unit fixture (Gallery, Tabs, headerless DataTable, vybraná
owner varianta, disabled nákup). Test runner má automatic JSX runtime pro TSX;
není přidaný React globál ani náhradní BE v aplikaci. Typecheck a produkční build
prošly. Produkční browser smoke kategorie/produktu při 390/1440 potvrdil stejné
geometrie, skutečný retry, jediný h1 a nulové browser chyby.

Plná gate doběhla bez timeoutů: 369/371 lint-rule testů prošlo, dva stejné existující
neúspěchy mimo N1 (`no-service-constructor-imports.test.mts` v Shell a
`repository-policy.test.mts`). Log `/tmp/n1-catalog-repository-check.log`; žádný N1
diagnostický nález. Řetězec se zastaví v testech lint pravidel, následné kroky tím
nejsou ověřené. Limity ani pravidla se neměnily. Předchozí samostatné i18n má
11 Shell chyb mimo N1; v této vlně se jeho celorepozitářová kontrola neopakovala.
Lokální dev server je po produkčním smoke obnovený na portu 3071.

Finální vizuální a produkční důkazy: `.local/n1-review/2026-11-02-catalog/`.
TraceDecay při kontextovém průzkumu této vlny zúžil výstup o přibližně 30 tisíc tokenů.

## Předchozí přírůstek: SearchSuggestions zapojené přes existující API

Základní integrace je hotová bez změny UI kitu. Figma výsledků a API fallbacku se
znovu načetla v session `e4748632-a96c-48ba-9994-83421a018efb`, rooty 63:1548/63:1591
a detail 440:1961. Dřívější odkládání celé komponenty kvůli query-submit detailu
bylo opravené; nejde o podmínku jejího běžného použití.

### Implementace a nezávislé review

- Jeden existující SearchSuggestions input nahradil SearchForm. Přístupný kit Label
  je propojený pomocí explicitního id; sr-only slouží pouze přístupnosti.
- Podporované groups/resultSlot obsahují pouze skutečné produkty owner čtení;
  maximálně 8 návrhů. Image a PriceBlock jsou z kitu; uvnitř navigačního anchoru nejsou
  další interaktivní odkazy. Nejsou přidané historické Fox produkty ani značky.
- Řízené open/onOpenChange otevře loading i tehdy, když zatím neexistují žádné položky.
  Empty a unavailable mají různá datová pole i pravdivé zprávy; výpadek nepředstírá
  úspěšné nulové hledání. Fallback používá stejnou empty kompozici jako návrh.
- Native form používá řízený dotaz a běžné chování kitu: první Enter bez zvýraznění
  zavře popup, další odešle dotaz. Footer a výběr položky zavírají seznam; žádný
  wrapper key handler ani interní DOM patch.
- Readonly GET `/api/search-suggestions` validuje locale/query, používá stávající
  getCatalog → veřejnou OntOS gateway a vrací omezený veřejný DTO. Cache-Control:no-store.
  API klíč ani tenant/seller konfigurace se do browseru nevrací.
- Effect HTTP klient v browseru má no-store a shared ManagedRuntime. Debounce 250 ms,
  decode sdíleného Schema a cleanup fiberu chrání před výsledkem jiného dotazu/locale
  a ruší nepotřebný browser fetch. Core read na serveru není browser abortem prokazatelně
  přerušený; zůstává omezený existujícími owner timeouty.
- Dočasná Next Server Action byla před předáním nahrazená GET adapterem: review
  lokálního Next kódu prokázalo serializaci RPC a nepřerušitelnost jejich fronty.
  Současná implementace tuto frontu nepoužívá a neregistruje tento read jako Action.
- API/datové a závěrečné GET review jsou bez nového blokujícího nálezu. Drobné
  A→B→A může do obnovení A zobrazit dřívější snapshot stejného A; nejde o prohození
  různých dotazů nebo locale.

### Skutečný browser a produkční build

Prohlédnuté snímky a metriky jsou uchované v `.local/n1-review/2026-11-02-search/`:
produkce 1440/1920, skutečný loading při síťové latenci a accepted dev kontrola.
Checker i root otevřeli produkční 1440 a loading snímek; checker navíc 1920 a další stavy.

- Jeden pojmenovaný input „Hledat produkty“ / „Search products“.
- Desktop control/popup 576/768 px při 1440/1920; input 32 px, footer 36 px/radius 0.
- Popup překrývá obsah správně, focus po ustálení přesně #d0d0d0; mobil 390 hledání skrývá.
- Skutečný GET vrací 200 se state:unavailable a no-store, bez mockovaných odpovědí.
- Skutečné zpomalení sítě ukázalo loading; smazání dotazu přerušilo request
  net::ERR_ABORTED, odstranilo text a zavřelo popup. Stará odpověď ho znovu neotevřela.
- Kliknutí na footer naviguje na skutečnou `/cs/vyhledavani?q=Fox` a popup zavře.
  První/druhý Enter odpovídají výše popsanému chování. English copy je lokalizovaná.
- Produkční smoke po finálním buildu při 1440/1920 bez console warning/error a pageerror,
  bez horizontálního přetékání.

Není potvrzená naplněná app nabídka ani brand group: stále chybí funkční N1 datový
kontext. Zůstávají tři doložené P2 odchylky standardního widgetu vůči Figmě: gutter
přibližně 8,5 px místo 4 px, menší status řádek než 42 px a otočení search trigger glyphu
při otevření. Nejsou skryté vlastním CSS nebo neexistujícími props; žádný plošný
pixelový PASS. Nedostupný text se záměrně nevydává za úspěšné „nic jsme nenašli“.

### Kontroly tohoto zapojení

Cílený lint/typecheck, všech 43 testů a theme:check 418 tokenů prošly. Nové testy ověřují
blank/invalidquery bez owner I/O, odlišení unavailable/empty, omezení preview,
GET no-store a odmítnutí neplatného/velkého transport DTO. Finální standalone build
obsahuje skutečnou route `/api/search-suggestions`; produkční smoke prošel.

Plná gate při souběhu s buildem měla 15 timeoutů nástroje a 1 existující Shell testový
neúspěch (355/371). Samostatné opakování bez souběžného buildu již nemá timeouty:
369/371 prošlo. Zbývají dva dříve doložené neúspěchy mimo N1:
`no-service-constructor-imports.test.mts` (Shell API composition factory) a
`repository-policy.test.mts` (17 diagnostik mimo N1). Gate se zastaví v testech
lint pravidel; následné kroky celého řetězce tím nejsou ověřené. Limity ani závažnosti
se neměnily. Logy `/tmp/n1-search-repository-check.log` a
`/tmp/n1-search-repository-check-serial.log`. Samostatné i18n má 11 existujících Shell
chyb; log `/tmp/n1-search-i18n-check.log`.

## Pokračování: hero, promo a dostupná kompozice karet

Aktuální Figma se znovu načítala v session `232083fa-dc15-43a0-91e5-82f5a4ddc31e`.
Kořeny `33:771/34:954` pro hero, `33:831/34:1003` pro promo a `33:880/34:1031`
pro produktové karty. Změny byly znovu nezávisle kontrolované component reviewerem
a vizuálním checkerem; pouze root upravoval app zdroje.

- Hero používá skutečný Carousel a jediný doložený banner. Jeden indikátor je
  skutečný stav dat, ne náhrada třemi kopiemi. Obě šipky jsou nativně disabled.
- Čtyři promo assety jsou z aktuálních Figma Image instancí, ne z screenshotu sekce.
  Desktop row1152/tile279/image256 a mobil3+1/image114 při390 sedí na předlohu.
  Při320 byl opraven kolidující dlouhý popisek v nativním titulkovém layoutu.
- Promo cíle ve Figmě nemají skutečný hyperlink ani potvrzený owner záznam; runtime
  nevymýšlí href. aria-disabled/title přiznávají neaktivní stav, Enter nenaviguje.
- Karty používají podporované tokeny paddingu/gapu/border/radius a typografie,
  originální PriceBlock a skutečně disabled nákupní Button. Body neznámé dostupnosti
  zůstávají neutrální. Obrázek a Name řádek mají layoutové wrappery dle návrhu.
- Ověřen skutečně generovaný CSS výstup: Name/Stock a PriceBlock line-height metadata
  se konzumují; registrace patří do @theme, ne jen scope. Small-shadow je řešený
  čistým N1 app semantic tokenem, nikoliv změnou knihovny nebo --tw-shadow hackem.
- Čtyři nové cenové regrese ověřily CZK bez nadbytečných nul, zachování haléřů,
  on-request bez vymyšlené nuly a skutečnou EUR/from hodnotu. Před opravou selhaly
  dvě cenové kontroly, po opravě všech34testů prochází.

### Evidence tohoto pokračování

Checker otevřel screenshoty hero/promo1440/1920/390/320 a cílený recheck popisku320.
Root navíc otevřel promo1440, opravené promo320 a hero390. Uchovaná lokální evidence:
`.local/n1-review/2026-11-02-wave2/` v kořeni repozitáře. Metriky jsou v
`n1-wave2-metrics.jsonl` a `n1-wave2-accepted-metrics.jsonl`. Obě úzké šířky bez
horizontálního přetékání; prohlédnuté interakce bez pageerror.

Lint, typecheck, všech 34 testů, theme kontrola 418 tokenů, format:check a produkční build prošly.
Celková gate znovu doběhla na stejných dvou existujících neúspěších mimo N1:
369/371 lint-rule testů. Navazující fáze se kvůli tomuto selhání nespustily.
Samostatné i18n zůstává na 11 existujících chybách Shellu. Logy:
`/tmp/n1-wave2-repository-check.log`, `/tmp/n1-wave2-i18n-check.log`.

Poslední čistý desktop promo a mobilní hero jsou uložené jako
`n1-wave2-accepted-promo-1440.png` a `n1-wave2-accepted-hero-390.png` ve složce evidence.
Checker oba skutečně otevřel; čerstvý průchod bez Next issue badge a console warning/error.
Příčina historického přechodného badge nebyla zpětně určovaná.

### Zbývající konkrétní hranice

Produktové karty bez skutečného N1 katalogu nejsou vizuálně odzkoušené s reálnými daty.
Víceřádkové centrování ProductCard.Name zůstává mezerou jeho API/tokenů. Statické promo
cíle ani dvě chybějící kampaně nejsou vymyšlené. Nákupní integrace není simulovaná.

SearchSuggestions v instalovaném npm balíčku existuje a může nahradit celý SearchForm.
Samotné nespojitelné inputy nebyly dostatečný důvod žádat změnu knihovny. Nezávisle
reprodukovaná skutečná mezera je Enter volného dotazu bez zvýrazněného výsledku při
otevřeném popupu a chování submit ikony; selection Enter přes navigate funguje.
Doklad v `n1-search-suggestions-contract-probe.json/.cjs` je izolovaný test skutečného
Zag connectoru, nikoliv React/browser test nebo backendová simulace. Žádná knihovní
změna, node_modules patch ani změna new-engine neproběhla.

## Aktuální opravy podle guardrails — 2. 11. 2026

Implementace proběhla s nezávislým read-only component/token reviewerem a vizuálním
checkerem. Root byl jediný zapisující vlastník. Orchestrace je v lokálním
`.local/N1-REVIEW-GRAPH.md`. Komponentové mapování a skutečné API mezery jsou v
`COMPONENT-MAPPING.md`. Starší sekce níže jsou historická evidence, nikoliv aktuální
tvrzení o použitých props nebo fontu.

Odstraněny vlastní maska hledání, barevný wrapper kolem ActionIcon, per-instance CSS
výšky ikonových Buttonů a globální body font override. Vzhled řídí podporované props
a doložené tokeny; Tailwind na wrapperech řídí layout. Knihovní font zůstává system-ui.
Doplněn mobilní utility bar a ovladatelné menu, patka má čtyři sloupce, copyright
správné seskupení a padding. Statické benefity jsou přítomné i při nedostupném
katalogu. Známé stock stavy používají ProductCard.Stock, unknown neutrální stav.

### Skutečně prohlédnutá browser evidence

Nezávislý checker zachytil baseline, druhý průchod a cílené opravy. Poslední snímky
otevřel checker i root: `/tmp/n1-audit-accepted-1440.png`,
`/tmp/n1-audit-accepted-390.png`; checker navíc otevřel
`/tmp/n1-audit-accepted-320.png`. Metriky jsou v
`/tmp/n1-audit-accepted-geometry.jsonl`, opakovatelný čtecí browser skript v
`/tmp/n1-visual-accepted.cjs`. Kopie screenshotů, metrik a skriptu jsou uchované v `.local/n1-review/2026-11-02/`.

- Hledání má při 1440/1920 kontejner 576/768 px. Enter naviguje na skutečnou
  `/cs/vyhledavani?q=helma`; ustálený focus po 500 ms je přesně #d0d0d0.
- Mobil 390: hlavička 139 px podle aktuálního rootu 34:915, hledání skryté. Menu funguje
  kliknutím i Enterem, aria-expanded odpovídá viditelnosti a focus zůstává na tlačítku.
- Šířky 320/390 bez horizontálního přetékání; porovnány clientWidth/innerWidth/scrollWidth.
- Copyright 1440 je 41 px; 390/320 je 57,594 px oproti návrhu 58 px.
- Celá patka 1440 je 291,078 px oproti návrhu 295,817 px; 390 je 550,594 px oproti 556,517 px.
  Zbylé metrické rozdíly nejsou označené jako pixelová shoda a nejsou maskované posuny.
- Mobilní benefit Image rámečky 35,531/38,078/32,813/24,859 px odpovídají aktuální Figmě.
  Řady mají 72,781 px oproti 74 px; fontové metriky system-ui se od Inter liší.
- Kontrolované interakce bez pageerror. Produktová data ani API nebyly mockované.

### Automatické ověření této vlny

Cílený lint, typecheck, všech 30 testů a theme:check 418 tokenů prošly. Finální produkční
build po poslední opravě footer tokenů i format:check prošly.
Lint nadále vypisuje známé varování o rozlišení catalog závislosti.

Úplné `pnpm check` bylo znovu spuštěné nad výsledkem. Typecheck lint pravidel prošel;
jejich testy skončily 369/371, se stejnými dvěma neúspěchy jako před opravami:
Shell composition factory v no-service-constructor-imports a repository-policy
se 17 diagnostikami mimo n1-storefront. Navazující fáze společné gate se po tomto
selhání nespustily. Log `/tmp/n1-guardrails-repository-check.log`.

Aktuální `i18n:boundaries` selhalo na 11 existujících chybách v Shellu, žádný nález
v n1-storefront; log `/tmp/n1-guardrails-i18n-check.log`. Závažnost ani pravidla se neměnila.

### Výslovně nedokončené / neověřené

SearchSuggestions popup není implementovaný; přesná kompozice se stávajícím SearchForm
je mezerou instalovaného API, nikoliv dokončeným stavem. Chybí carousel ovládání a
promo kategorie. Naplněné karty/detail čekají na skutečná N1 data, média a identitu.
Cookie consent ovládání je neaktivní, account/cart/checkout integrace zůstávají mimo
tuto vlnu oprav. Žádný plošný vizuální PASS celé homepage nebo storefrontu.

## Historická oprava Figma postupu a theme

Po zpětné vazbě byl znovu načten skutečný `Theme / N1` včetně aliasů, společných
komponentových kolekcí a aktuálních lokálních overrides pro návrhy hledání. Zapojen
reprodukovatelný export 418 tokenů, aktivní `data-theme="n1"`. Ruční barevné náhrady
z prvního přírůstku byly odstraněny.

Nová kontrola v prohlížeči ověřila hlavičku vysokou 180,5 px, hledání široké 576 px,
ActionIcon 32 × 32 px, jeho originální ikonu 16 × 16 px a ikonové Buttony 24/28/28 px.
Props byly načteny přímo z aktuálních Figma instancí. Čerstvě exportované SVG ikony
hlavičky jsou obsahově shodné s lokálními assety. Opraveny explicitní prázdné fills
u tří Figma Button instancí, které samotné globální theme nereprezentuje.

Kontrola CSS hodnot prošla u 417/418 přímých zápisů; zbývající `text-input-sm`
UI kit vyjadřuje jako `max(16px, 14px)`, což má v prohlížeči očekávaných 16 px.
`theme:check`, cílený lint a build prošly. Jde o kontrolu theme a vybrané hlavičky,
nikoliv o dokončenou vizuální shodu ostatních obrazovek. Inter z textových vrstev Figmy
je nyní self-hostovaný přes Next localFont se stejným fontovým assetem jako v AKROS.
Finální rozložení ostatních obrazovek musí projít další kontrolou.

Aktuální snímek této kontroly: `/tmp/n1-header-theme-updated.png`. Návrh se mění,
proto je nutné při dalším převodu znovu načíst relevantní frame.

## Původní kontrola kostry

Základ: `demo/sales-crm`, commit `a94937205`. Změny zůstávají lokální.

## Automatické kontroly

- `mise run deps`: prošlo, sdílený lockfile obsahuje nový workspace.
- `pnpm --filter n1-storefront test`: 30/30, tři soubory; používá projektový Effect Rstest harness.
- `pnpm --filter n1-storefront typecheck`: prošlo.
- `pnpm --filter n1-storefront lint`: prošlo; nástroj navíc vypisuje varování o rozlišení
  workspace `catalog:` závislosti UI kitu, které neblokuje kontrolu ani instalaci/build.
- `pnpm --filter n1-storefront build`: prošlo, dynamické trasy pro locale, katalog,
  vyhledávání, kategorii, produkt a obsah.

Celé `pnpm check` prošlo typovou kontrolou lint pravidel a skončilo na jejich testech:
369/371 prošlo, dva neúspěšné testy se týkají původního kódu:

- `no-service-constructor-imports.test.mts`: aktuální Shell authentication composition factory.
- `repository-policy.test.mts`: 17 diagnostik v původních skriptech, AKROS a testech storefront-registry,
  včetně uživatelského necommitovaného Figma skriptu. Žádný nález v `n1-storefront`.

Samostatné `pnpm i18n:boundaries` rovněž neprošlo: nálezy jsou v existujícím Shellu
(API boundary a lokalizace lidí/rolí). Kontroly ani jejich závažnost se neměnily.

## Prohlížeč

Lokální skutečný Next server na `127.0.0.1:3071`, bez náhradního API a produktových fixture dat.
Porovnány desktopová reference Figmy `31:636` a mobilní skladba stránky.
Zkontrolovány šířky 1440, 390 a 320 px, žádné horizontální přetékání při 390/320 px.
Ověřeno načtení log, banneru, vlajek a ikon. Opraven layout patičky, bílé pozadí
vyhledávání a zachování poměru stran loga. Anglická stránka má `lang="en"` a lokalizované
přístupné popisky. Odeslání hledání klávesou Enter ověřeno na skutečný přechod
`/cs/vyhledavani?q=helma`; konzole bez chyb a varování.

Snímky první kontroly jsou v `/tmp/n1-desktop-final.png` a `/tmp/n1-mobile-final.png`.
Jde o kontrolu dostupné skladby a nedostupného katalogu, nikoliv důkaz úplné vizuální
shody nebo dokončeného e-shopu. Produktové karty, detail s daty, účet, košík a checkout
je ještě nutné ověřit po jejich dokončení proti skutečným N1 datům a oprávněním.

## Před plným ověřením

Chybí předaný N1 produktový import a ověřený N1 Storefront Client / seller / tenant /
market kontext. Proto se nyní zobrazuje pravdivý nedostupný katalog. Ostatní části
implementace i další obrazovky jsou rozepsané v README; nebyly nahrazeny mocky.

# Košík a owner quote — ověření pokračování

N1 má lokální draft košíku oddělený tenantem/prodávajícím/marketem/měnou,
přidání přes skutečnou naceněnou dostupnou product/variant selection,
změnu množství a odebrání. `POST /api/cart-quote` používá existující veřejný
generated merchandise apply client s `PlaceStorefrontOrder dryRun:true`.
Čerstvý server scope/offer/revision a oddělený nový assertion se ověřují před
Action. Žádná objednávka, seed, grants, backend změny ani runtime mock.

**172 N1 testů PASS**, scoped lint PASS (zůstávají informativní catalog resolver
warnings), formát a 447-token theme check PASS. Produkční Next build včetně
TypeScriptu PASS; finální standalone běží3071. Pro standalone se kopírují public
a .next/static do jeho vlastního build adresáře, ne do zdrojů.

Nové testy prokazují scope/storage izolaci, poškozené payloady, variant identity,
aggregate quantity limit, A→B→A a A→null→A quote freshness, external quantity
update vs invalid draft, remove/readd, globální owner issues a scope recovery.
28 owner/HTTP testů používá test-only transport fixtures, skutečný generated client
a handler: fresh assertions, revision7/market, odmítnutí/nullable totals, neplatné
requesty, content size/type, no-store a žádný automatic retry. Nejde o live
owner úspěch. Produkční negativní smoke: foreign Origin403 a empty DTO400,
oba no-store a před owner voláním.

Nezávislé review a dvě kola oprav dokončené: žádné další P1/P2 v prověřeném
rozsahu. Reviewer původních UI nálezů pak implementoval refaktor, proto finální
nezávislé UI recheck provedla jiná lane. Všechny tři následné P2 uzavřené.

Aktuální vizuální evidence `/tmp/n1-cart-final-*`: scope-unavailable CS1440/390/320,
EN390 a homepage1440. Všech pět screenshotů otevřeno; overflowfalse,
console/hydration/errors prázdné, business writes prázdné. Retry provedl nový RSC
GET; skutečná ikona košíku navigovala na /cs/kosik, ENhref/en/kosik. Assets se
načítají, cart28×28. Figma empty/guest summary i Netlify home/popover reference
prohlédnuté. Empty/filled owner stavy a celý checkout/reference parity nejsou PASS.

Full gate po prvním souběhu s buildem:358/371, včetně tool timeoutů. Samostatný
opakovaný běh367/371; zachytil i pět nových N1 testových assertions s ručním
porovnáním Effect tagu. Ty byly opravené přes typed instance assertions; žádné
pravidlo ani timeout nebyly snížené. Konečný samostatný full gate znovu367/371:
native-data-factory-proof, dva no-service-constructor-imports a repository-policy
mimo N1. Konečný log nemá N1 diagnostiky ani tool timeouty. Globální řetězec
skončil v lint-rule testech; další kroky této gate nebyly ověřené.
Scoped výsledky nejsou globální PASS. Starší důkazy patří svým předchozím běhům.

Nic nebylo commitnuto/pushnuto/deploynuto externě. Index zůstal prázdný. Kromě
N1 jsou lokálně potřebné workspace metadata z předchozího auth a veřejný
merchandise workspace link v lockfile; tyto změny zůstávají mimo povolený commit scope.

## Header mini panely, mobilní navigace a sdílená session — 2026-11-03

Po restartu:177 testů a build prošly ještě před tímto přírůstkem. Po doplnění
mobilní navigace a sdílené session:179/179 testů. Scoped lint po opravě
konkrétních nálezů prošel; výstup má stávající catalog-resolution warnings.
Produkční build včetně TypeScriptu a jediného page workeru prošel pod3GB cap;
pozorovaný peak2.44GiB. Browser nekolidoval s buildem/testy.

Nezávislý reviewer /root/n1_reviewer skutečně otevřel screenshoty aktuální
Figmy (333:7435/311:2331/311:2164 a418:2484), veřejné Netlify reference a
lokálního runtime. Desktop login/cart mají384px; mobil login372px ve viewportu390.
Mini panely se přepínají výhradně, Escape zavírá. Cart bezscope ukazuje unavailable.
Naplněný/prázdný skutečný N1 cart nebyl ověřen.

Mobilní drawer:320px, y139, spodek844; Escape vrací focus na Kategorie, close
tlačítko funguje, resize1024 zavře a obnoví body scroll. Po zavření lze kliknout
footer link; fixed wrapper neblokuje stránku. Pageerror prázdné, console má jen
očekávané503 pro nedostupný owner kontext. Reviewer našel chybějící DOM cíl
aria-controls; opraveno stabilním ID aplikačního controlled regionu.

Výhradně test-only browser HTTP fixture ověřila přesně1 mount session GET,
stejnou admitted identitu současně v auth stránce a headeru a1 logout
odstraňující oba výskyty. Fixture se nedostala do aplikace a není důkazem
živého N1 loginu či vytvořeného zákazníka. Žádný skutečný business POST.

Běží FE3071, Shell3020, merchandise4123 a read-only composition3041, jednotlivě
omezené. Existující DB/SpiceDB byly spuštěné bez resetu/importu/grantů.
Composition stále503: původní autorita je expirovaná. N1 scope a produkty
nejsou ověřené. Backend recovery/import a úplný checkout zůstávají další etapa.
Globální gate nebyla v tomto přírůstku opakovaná; předchozí čtyři problémy
mimo N1 nejsou vyřešené ani přeznačené za PASS. Bez commitů/pushe.

Finální cache build po aria-controls opravě znovu prošel. Reviewer na něm ověřil
`targetExists=true` a `containsRealDialog=true`; nález je uzavřený. Browser zavřen.

## Integration checkpoint before the work-in-progress commit

The branch was fast-forwarded to `df54c2eb0` before this checkpoint. The commit
scope is this storefront plus the necessary workspace catalog and lockfile
entries; backend bootstrap/seed changes and private local runtime/data are excluded.

- Frozen offline lockfile validation and dependency installation passed.
- The focused N1 suite passed: 180 tests in 21 files, no skips or failures.
- Production Next build including TypeScript passed after the branch update and
  minimal-lockfile installation, under a hard 2 GiB memory cap.
- This remains a work-in-progress integration, not a completed Figma conversion
  or a production-readiness claim. Earlier full-gate results above are historical.
- Actual local owner quotes and populated catalog/cart were verified previously.
  Complete customer enrollment/login and checkout are not live end-to-end proofs.
- Recent desktop/mobile checks corrected card typography/layout and detail variant
  props/purchase-row composition. Outstanding: ProductCard hardcoded shadow and
  image cropping, exact detail NumericInput anatomy, heading/panel details, search
  brands and other missing data-backed sections. No whole-storefront visual PASS.

## C7 — guest checkout a nativní potvrzení (2026-11-04)

Figma session `29658e25-06ad-415c-a929-b9b88d7db11f`:
checkout desktop `44:1226`/`319:1734`, mobil `44:2285`/`319:1955`;
potvrzení desktop `55:1948`/`372:3125`, mobil `55:2309`/`372:3356`.
Snímky i konkrétní Code Connect instance byly skutečně prohlédnuté.

Ověřeno na skutečném odděleném lokálním N1 backendu, nikoli na shared stage:

- Produkt Fox Defend/YS → košík → native quote → PPL129CZK → shipping-inclusive
  quote → skutečný OBJ-2026-0001, celkem898CZK. Owner vrátil DPH155.85 a cenu
  bez DPH včetně dopravy742.15CZK.
- Potvrzení zaměří H1. Detail dohledá skutečný kontakt, adresu, stav a dopravu.
  Po reloadu i restartu FE stejný nonce vrátí stejnou objednávku pouze čtením.
  Potvrzený odeslaný košík je odstraněný; odchod domů uvolní pouze původní guard.
- Prázdný formulář zaměří první povinné pole, vyznačí neplatná pole a nepřenese
  osobní údaje do URL. Bez JavaScriptu používá pevný POST endpoint, který
  nepodporovaný form payload odmítne.
- Finální desktop1440: article1280, vnitřek1240, dvě604pxkolony, gap32, p20,
  H1 32/48, skutečný thumbnail64×64. Mobil390: obsah350, p20, párová pole
  po152px/gap12, input44px, Select56px. Bez horizontálního overflow.
- Opraveno po vizuální kontrole: thumbnail16→64 přes existující dimension-64,
  nadpis32/48, cena dopravy v pravém sloupci wrapperu, mobilní stav pod titulkem.
  Kit komponenty nemají vzhledové className/style. Konzole průchodu bez chyb/varování.
- 246/246 N1 testů PASS; N1 lint, format a samostatná repository Effect
  discrimination policy pro celý N1 consumer PASS. Produkční Next build PASS.
  Source review nehlásí zbývající P1/P2. Nejde o pozitivní test zákaznického účtu.

Schválené či skutečným kontraktem vynucené rozdíly od fixture:

- Firma, druhý řádek adresy a kraj vynechané s výslovným souhlasem uživatele.
- Skuteční dopravci/ceny/země z ownera, bez fixture ParcelShop nebo dodacího slibu.
- Online platba není dostupná; přijetí netvrdí zaplacení či odeslaný e-mail.
- Ověření úplného quote předchází potvrzení; ceny nevypočítává frontend.
- Guest receipt nemá neimplementované „Moje objednávky“. Obnova po reloadu nemá
  obrázek, pokud owner ani aktuální cart neposkytuje jeho ověřená metadata.

Full pnpm check nebyl zelený: selhaly čtyři repository lint-rule testy
(native-data-factory-proof, dva proof testy no-service-constructor-imports,
repository-policy). Všechny reportované N1 manual-tag nálezy byly opravené a
ověřené samostatnou stejnou policy konfigurací. Zbývající diagnostika zasahuje jiné
aplikace/tooling a lokální necommitovaný seed mimo N1 scope. Celkové repo nemá
zelený full gate; pravidla ani hooky se neoslabují.

## C8 — vlastní profil a objednávky (2026-11-04)

Figma profile desktop/mobile54:1417/54:1629, own orders54:2060/54:2241
a detail55:2509 byly skutečně načtené. Kompozice používá FormInput md,
Tabs default/sm, Button primary/solid, Badge info/md, semantic Table
a ProductCard. Nepřibyly vzhledové CSS třídy ani tokenové přepisy.

295/295 testů PASS; Next produkční build, N1 lint/format a samostatná
Effect repository policy PASS. Source review serveru i klienta bez zbývajících
P1/P2. Ověřena izolace zákazníků, CAS konflikt, nejistý zápis bez retry,
uložené měny a bezpečné textové vykreslení.

Živý lokální BE: anonymní profil GET200/anonymous; vlastní objednávky
GET401/anonymous; query s podvrženým customerAccountId400/invalid;
cross-origin profile POST403/forbidden. Account na390 bez overflow,
noindex/nofollow. Chybějící Shell/composition služby byly obnovené přes
stávající izolované launchery bez resetu dat. Pozitivní přihlášený účet
není ověřený a naplněné account obrazovky nemají live vizuální PASS.

Native displayName zůstává jedním polem, kontaktní email readonly. API
nedodává globální statistiky útraty ani historická produktová média;
partial page se za globální statistiku nevydává. Adresář má explicitní
unavailable stav. Přihlášený checkout zůstává dalším samostatným celkem.

Full pnpm check byl opět spuštěný a skončil na stejných čtyřech repository
lint-rule testech mimo N1; nový report neobsahuje žádný N1 nález.
Pravidla a hooky nejsou vypnuté.

## C13 — aktuální ceny a kompozice košíku/checkoutu

328/328 N1 testů, lint a finální produkční build PASS. Nové regresní testy
nejprve reprodukovaly storage-error admission a nadbytečné ruční potvrzení
již ověřených cen. Sdílený feedback navíc testuje pending, unavailable,
scope mismatch, neplatný draft, PRICE_CHANGED a rozporný VALID výsledek.
Kanonický N1 export zůstává beze změny: theme:check447 PASS.

Aktuální Figma `39:2395/208:2267`, `311:2475/2490` a `319:1756/1977`:

- Header na skutečných390px: actions gap12, skupina152, logo194; desktop1440
  má skupinu104 a logo256. Bez horizontálního overflow.
- Naplněný mini košík: panel384, mezera akcí12 a samostatný1px oddělovač
  border-secondary před celým souhrnem. Ověřená jednotková cena není současně
  označená jako neověřená; úspěšné oznámení zůstává dostupné přes aria-live.
- Doprava: nativní RadioCard má padding12, content gap8 a description14.
  Žádný vzhledový className na knihovních komponentách ani změna primitivní palety.

Živý browser ověřil automatické ceny košíku bez dalšího kliknutí. Při záměrně
vypnutém spojení a změně množství1→2 se vrátil viditelný unavailable stav,
draft cena, ruční retry a disabled checkout. Po obnovení spojení a retry
native quote potvrdil1918Kč; změna zpět na1 automaticky potvrdila959Kč.

Checkout na390/1440 použil skutečné959Kč za zboží +129Kč dopravu =1088Kč.
Změna adresy A→B→A zneplatnila původní ověření až do nového native quote.
Konečné odeslání nové objednávky a pozitivní přihlášený Portal účet tento
průchod zatím nepotvrzuje; úspěšné ověření ceny není doklad o objednávce či platbě.

Celé aktuální checkout screenshoty byly znovu porovnané včetně pending a empty
referencí. Následující celek má doplnit samostatný divider před checkout totals,
kompozici skutečně loaded-empty pokladny a disabled zpětný odkaz při pending.
TotalsSummary0.57 nemá veřejné varianty pro mini total14/semibold a checkout
total16/bold; společný default20 není obcházen kontextovým CSS. Tyto otevřené
body znamenají, že C13 není plošný vizuální PASS celého storefrontu.

Aktuální plná repository gate se znovu zastavila na367/371 lint-rule testech:
stejné4 dříve doložené chyby v native-data-factory-proof,
no-service-constructor-imports a repository-policy mimo N1. Řetězec následných
repo kontrol proto není celý PASS; žádné pravidlo ani git hook se nevypíná.

## C14 — prázdná pokladna, pending navigace a skutečná objednávka

331/331 N1 testů PASS. Nové regresní testy nejprve reprodukovaly nesprávný
empty stav a aktivní návrat při pending. Loading, storage, scope a unresolved
order mají dál přednost před prázdným košíkem. Lint a produkční build PASS.

Figma empty desktop56:636/mobile56:800 sdílí kompozici s prázdným košíkem:
max1280, p20, gap16, h1 24 a home LinkButton primary/solid/md. Browser ověřil
desktop min-height424 a skutečných390px bez overflow; mobilní obsah má198px
při min-height196 kvůli zalomenému textu. Košík/pokladna používají existující
compactContent layout: shell již nepřidává min-height50dvh. Patička začíná
na mobilu y337 (Figma335), desktopu y604.5 (Figma604). Checkout má před cenovými řádky
samostatný1px border-secondary oddělovač. Browser skutečně zachytil disabled
návrat i submit při quote i place podle pending323:1465.

V izolovaném lokálním backendu byla jednou odeslaná objednávka OBJ-2026-0002:
Northwave Extreme2 Leg Warmer LXL959Kč + PPL129Kč =1088Kč. Po reloadu
existující akce ověření výsledku obnovila stejné číslo, adresu a owner ceny;
objednávka nebyla znovu odeslána. Home akce následně odstranila recovery guard
a checkout správně zobrazil skutečně prázdný košík. Platba se nepředstírá.

Pozitivní Portal profil/own orders a skutečný password reset nejsou živě
ověřené. Lokální launcher explicitně nepropouští COMMERCE_CORE_IDENTITY_*
konfiguraci, takže zákaznická admission vyžaduje samostatné zprovoznění
podporované identity služby. Mailpit na127.0.0.1:1026/8026 je dostupný, ale
chybí známý skutečný Portal účet pro reset; staff login ani guest objednávka
nejsou zákaznický účet. Nebyl odeslán reset na neznámého příjemce.

TotalsSummary0.57 total typography API gap a schválené vynechání adresních
polí zůstávají otevřené jako v C13. Plná repo gate má poslední doložený výsledek
367/371 se4 baseline chybami mimo N1; tento celek ji neoznačuje za PASS.

Dodatečný skutečný průchod na uživatelově localhost URL Arm Warmer ověřil:
bez vybrané velikosti je purchase disabled s „Zvolte variantu“, po výběru
LXL je aktivní a přidání do košíku uspělo. Veřejné vyhledávání má231stránek;
homepage je pouze featured výběr. Nový lokální import není doporučený ani
přiřazený do17 existujících kategorií a jeho sklad zatím není aplikovaný.
Tyto zbývající datové mezery nejsou vydávané za dokončený katalogový storefront.

## C15 — toast po přidání do košíku

Historická N1 UX reference byla přečtená z herbatika-shop/apps/n1; její role
a konkrétní soubory jsou uvedené v COMPONENT-MAPPING. Add-to-cart používá
současný knihovní useToast/Toaster s kanonickým N1 vzhledem. Toast vznikne až
podle skutečného výsledku uložení; inline post-add output a Košík link zmizely.

333/333 testů PASS včetně reprodukce chybějícího success/error toastu před
opravou. Testy ověřují skutečný handler s úspěšným/neúspěšným cart.add.
Lint, format a finální produkční build PASS. Browser ověřil skutečné přidání
ArmWarmerLXL, title+produkt+množství+variantu v oznámení, lokalizované zavření
a následně nula otevřených toastů. Desktop1440 i mobile390 mají skutečné
viditelné screenshoty; mobile toast360×120 leží x6/y700 a nepřetéká viewport.
Jeden globální renderer zachovává live region a nativní zavírání. Délka10s
umožňuje přečíst delší název; při hoveru se časovač nativně pozastaví.

Chybová větev má unit důkaz, nikoli úmyslně poškozené živé úložiště.
Tento review potvrzuje přenos toast UX; nejde o plošný Figma PASS všech
produktových detailů nebo vyřešení zbývajících skladových/kategoriálních dat.

## C20: desktopové záložky a typografie parametrů

Aktuální Figma39:1965 a řádek219:2885 znovu načteny přes design context
se screenshotem. Instalovaný kit0.57 byl ověřen před úpravou. Dvě Tailwind
utility mění jen existující tokenové vazby na nativních wrapperech; canonical
N1 theme, komponenty knihovny a ostatní instance Tabs/Table se neupravují.

Skutečný Chrome po změně: desktopový seznam i triggery36px, padding6/10,
šedý pruh a tmavý indikátor. Buňky parametrů mají16px/24px, řádky36px.
Mobile390: bez horizontálního přetečení; Tabs zůstávají bílé a mobilní tabulka
má původní14px. Oba screenshoty byly skutečně prohlédnuté. Nezávislý reviewer
otevřel desktopový screenshot i Figma referenci a potvrdil pouze tento scope.

Nejde o PASS celé PDP: výška tabulky36 vs37, výrobce, úplná hierarchie,
další produktové akce a související produkty zůstávají samostatné body.

Po integraci upstream fotografií5a47963d6:366/366 testů PASS, N1 lint a format
PASS, typová kontrola přes `effect-tsgo tsrs --noEmit -p n1-storefront/tsconfig.json`
PASS. Nutné opravy nových media souborů zachovávají route200/404/503 i cache
kontrakt: pojmenované regex skupiny, optional výsledek a bezpečný pevný Effect
log bez SDK error dumpu. Nezávislý source reviewer nenašel blocker; existující
testy ověřují media paths, nikoli přímo všechny živé error response obrázků.
