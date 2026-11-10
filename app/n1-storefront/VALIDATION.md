# Kontrola převodu N1 storefrontu

## Navazující kategoriové stavy — 2026-11-09

Čerstvé Figma57:906/2904/3009/3028 byly porovnány se skutečným CatalogState.
Soukromý actual-renderer průchod před opravou i po ní pokrývá čtyři stavy ×
pět šířek × CS/EN,40/40 layout PASS. After navíc měří Rectangle80px/max320px,
tři čáry16px/plná šířka a mezery24px. Původní before snímky a report zůstávají.
Existující6 regresí zachovává oddělené produktové/kategoriové chyby a pending
semantiku; nové kategoriové copy nejprve2FAIL a po opravě6PASS.

Nezávislý reviewer otevřel before CS390, after CS390/320/1440, EN320 a chybu CS390;
GO platí pro skeleton a kategoriový text, ne pro skutečný owner failure/retry
přechod nebo živý zápis. Žádná runtime fixture či backendový mock nevznikly.
Prázdný CatalogView listing body samostatně10/10 CS/EN × pět šířek, včetně
přirozené šířky CTA a správného lokalizovaného home odkazu. Reviewer otevřel
CS390 a EN320; nadřazený CategoryView ani owner lookup tím nejsou schválené.
Celá N1 regrese po kategoriové opravě znovu797/797 testů v75 souborech.

## Systematická matice a cílené opravy — 2026-11-09

Soukromá matice zachycuje87 Figma rámců × šířky320/390/768/1024/1440.
Rozložení, ovládání a vizuální schválení jsou oddělené výsledky; samotné HTTP200
ani screenshot bez přetékání neznamenají vizuální shodu.

Celá N1 regrese:797/797 testů,75 souborů. Veřejné routy:95 jedinečných
kombinací stav/šířka s aktuálním layout PASS. Soukromé account renderer QA
se do těchto95 veřejných kontrol nezapočítává.

Samostatné N1 typy, lint, formát a447 tokenů prošly. Celková repository gate
na eb5ce50a3 prošla module contracts; globální lint byl následně ukončen po
výrazném zpomalení hostu. Exit130 není PASS ani potvrzený lint defect.
Žádná diagnostika nebo Git hook nebyly vypnuté; celková brána není uzavřená.
Samostatné repository i18n:boundaries znovu hlásí28 diagnostik Effect API mimo
N1. Plný log je zachovaný; nebyly filtrované, potlačené ani opravené mimo rozsah.

- Home: cílené měření před opravou5FAIL, po opravě5PASS. Ověřen slot nadpisu
  a mobilní/desktop šířka loga v patičce; nezávislé review schvaluje jen tyto změny.
- Profil: skutečný client AccountView v izolované soukromé QA, CS/EN × pět
  šířek,10PASS. Nativní šipky/Home, resize a obnovení orientace fungují. Reviewer
  otevřel CS390/1440 a EN320. Testovací identity/router seam není runtime cesta
  ani důkaz živého zákaznického účtu; žádný profilový zápis se neodeslal.
- Detail objednávky: skutečný SSR renderer, CS/EN × pět šířek × tři stavy
  dopravy,30PASS po původních10FAIL. Částky nepřetékají ani s dlouhým názvem
  dopravy. Regrese ověřuje uložený název, chybějící/blank hodnotu, doslovné
  escapování `$& <script>`, data/časy i zachování původního formátu seznamu.
  Izolovaná QA neprokazuje živé načtení vlastní objednávky.
- Navigace: skutečný mobilní drawer a desktop megamenu, pět šířek,5PASS.
  Rozbalení, Escape, návrat fokusu, klávesnice a přechod na kategorii ověřené.
- Doprava a platba: deset skutečných route/viewport kontrol,10PASS; nezávislé
  review schvaluje odstranění minima shellu, nikoli platební integraci.
- Našeptávání:16 desktopových scénářů, CS768/1024/1440 a EN1024 × čtyři stavy.
  Výsledky/prázdné hledání ze skutečných GET; loading drží původní GET a error
  jej přeruší pouze v soukromé browser QA. Šipky/Escape a fallback odkazy prošly,
  všech32 obrázků má nenulovou naturalWidth. Čtyři lokální Next stack-frame POSTy
  jsou diagnostické reads; žádný business zápis se neodeslal ani neobešel.
  Původní prázdné listboxy a nedočkané obrázky byly chyby QA, záznamy zůstávají.
  Mobilní hledání nemá vstup ani ve Figmě/historickém N1 a čeká rozhodnutí.
  Figma15px cena/modrá role a footer34px se rozcházejí s N1 tokeny/kitem;
  celý popup nemá vizuální GO a kvůli snapshotu se nevyrábí nová paleta.

Screenshotování nyní používá `caret: initial`: výchozí Playwright skrývání
kurzoru dočasně měnilo style atribut vstupů a závodilo s hydratací. Původní
záznamy zůstávají v evidenci. Nepřidalo se suppressHydrationWarning ani
aplikační CSS/DOM obcházení.

Otevřené hranice: plná vizuální shoda všech stavů, živý ověřený Portal účet,
chybějící owner pole detailu objednávky, adresní zápisy a naplněné CMS/Novinky.
Soukromé QA soubory a snímky jsou mimo Git; nejsou součástí runtime storefrontu.

## Mobilní procházení kategorií klávesnicí — 2026-11-09

- Reálné otevření category tree dříve ponechalo fokus na tlačítku pod stromem,
  takže následující Tab přeskočil celý strom. Po otevření nyní scoped asideRef
  zaměří existující kit roving tab stop. Žádný zásah do stylů, dat, routování,
  kolekce, selekce nebo šipkové logiky kitu. Desktop mount fokus nepřebírá.
- Fresh Figma31:639 potvrzuje stávající Button secondary/outlined/md. Rozložení
  se nepřestavuje; screenshoty před/po se liší nativním focus ringem.
- Browser reprodukce3RED + desktopcontrolPASS. Oprava4/4 PASS: CS/EN390keyboard,
  CS390pointer, CS1440desktop. Další4/4 průchodů potvrzuje šipky, Tab zpět na
  přepínač, zavření/znovuotevření a Enter navigaci na skutečnou kategorii.
  Skutečné owner GET, žádné business writes nebo overflow. Root+reviewer
  otevřeli before/afterPNG, bounded source/interaction/visual review GO.
- N1 regresní sada783/74, lint, typy, formát a447kanonických tokenů PASS.
  Globální i18n gate dál hlásí28chyb mimoN1; nic se nepotlačuje.
- Browser scénáře jsou uložená lokální QA evidence, nikoli nová CI browser sada.
  Není to schválení celého katalogu ani pozitivní objednávkový či auth test.

## Chyba množství versus neuložená změna — 2026-11-09

- Řízená chyba lokálního zápisu při platném množství dříve vedle správné
  řádkové chyby nesprávně žádala zkontrolovat množství. Invalid draft nyní
  nevkládá obecné shrnutí; konkrétní validace a failed-save zpráva zůstávají
  u pole. Odstraněny dva nevyužité překlady. Quote/checkout guard se nemění.
- RED4 → GREEN32 cílených testů, celá N1 sada783/74 PASS. Lint, typy,
  formát a447kanonických tokenů PASS. Globální i18n gate má28 chyb mimoN1,
  bez suppression. Čtyři izolované browser případy PASS:
  save-failure CS1440 cart/EN390 mini; invalid0 CS390 cart/EN1440 mini.
  Jedna správná řádková zpráva, žádné obecné quantity shrnutí, bez overflow.
  Checkout při chybném draftu blokován, odkaz mini→košík správně přístupný.
- Quote odpovědi jsou pouze řízené testovací vstupy; skutečný katalog GET a
  lokální přidání, žádné business zápisy. Root i reviewer otevřeli before/after
  PNG; bounded source/UI review GO, nikoliv schválení celého UI nebo živého BE.

## Přesné a neopakované chyby košíku — 2026-11-09

- Nedostupné ověření používá existující `checkout.unavailable`, nikoli tvrzení,
  že se košík nepodařilo aktualizovat. Úspěšné lokální přidání a nedostupný
  checkout jsou oddělené výsledky; stará zavádějící CS/EN copy odstraněná.
- Stávající `CartQuoteFeedback` vykresluje obecné a globální owner důvody jednou
  podle výsledného textu. Globální issues jen pro ready a platný draft; různé
  důvody zachované, produktové chyby dál u řádků. Paralelní mapy v košíku a mini
  košíku odstraněné. Nezměnil se quote request, cena, backend ani checkout guard.
- RED5, focused GREEN15/2soubory, konečná N1 sada780/74PASS. Lint, typy,
  formát a447tokenů PASS. Globální i18n gate dál hlásí28 chyb mimoN1, bez suppression.
- Tři izolované browser případy PASS: CS1440 unavailable + duplicitní global
  REJECTED, EN390 unavailable. Skutečný katalog GET a lokální quantity1→2;
  řízené testovací odpovědi quote, všechny reálné zápisy blokované. Zpráva je
  jednou na každé ploše, odlišné důvody zůstávají; checkout disabled, bez overflow.
- Root a reviewer otevřeli aktuální PNG, bounded source/UI review GO. Původní
  předčasné2/3 čtení zachované odděleně; finální test čeká na konkrétní výsledek.
  Tohle není pozitivní živý nákup ani potvrzení opraveného backendu.

## Fokus neplatných auth formulářů — 2026-11-09

- `AuthForm` při neplatném odeslání zaměří první nativně neplatný input vlastního
  formuláře; neshoda hesel zaměří potvrzení. Dosavadní inline chyby, required,
  validace, kit komponenty a odesílání se nemění.
- Při přechodu na submit téhož formuláře přebírá validaci samotné odeslání.
  Blur tak nepřesune tlačítko mezi pointerdown/up v mini loginu. Běžný Tab nebo
  jiné tlačítko nadále vyvolá blur validaci. Submit se poznává přes vlastní
  nativní button a jeho form asociaci, bez instanceof, časovačů nebo CSS.
- RED: sedm browser případů ponechalo fokus mimo chybné pole. GREEN: stejných
  sedm prošlo, včetně mini loginu nad stránkovým loginem, neshody hesel a souhlasu.
  Dvě negativní kontroly zachovaly běžnou blur validaci. Všechny zápisy blokované.
- Figma56:883 je reference chybových polí, ne nový návrh rozložení nebo fontů.
  Bounded source/screenshot review GO; skutečná Portal registrace není tímto testovaná.
- Finální kombinovaný N1 checkpoint:780/74souborů, lint, typy a447tokenů PASS.
  Globální i18n gate má známé nálezy mimoN1; neoznačuje se za celorepo PASS.

## První kliknutí na registrační souhlas — 2026-11-09

- Platná shoda hesel se zobrazí při dopsání potvrzení, ne až při blur. První
  kliknutí na knihovní checkbox proto neodsunuje 34px vložený feedback. Změna
  hesla dál ruší obě potvrzení; validace a odesílání zůstávají stejné.
- Skutečný browser RED/GREEN: CS1440, CS390, EN390. Před opravou 3/3 přímých
  control kliknutí selhala, po opravě 3/3 checked + FormData true + posun0.
  Space, zneplatnění a obnova shody PASS; žádné overflow nebo obchodní POST.
- Root a nezávislý reviewer otevřeli PNG; omezené vizuální GO pro tento problém.
  Plná sada775/74souborů, N1lint, typy a447tokenů PASS; není to živý Portal
  registrační PASS. Globální i18n boundary gate dál hlásí28 chyb mimoN1;
  žádná diagnostika se nepotlačuje a celorepozitářový PASS se netvrdí.
- Fresh Figma333:6888 má p16, ale výchozí fullframe43:1026/333:5536 má boční
  padding0 a pt28/pb24. Wrapper se proto neměnil podle izolované fixture.
  Neplatná potvrzení, font/CTA rozdíly a celá auth pixelová shoda nejsou uzavřené.

## C39: mobilní podkategorie po dvojicích — 2026-11-05

- Fresh Figma mobile38:2149/2150 má řádky po2 s gap8/24; předchozí volný
  wrap mohl dát3. Nemutující slice zachovává všechny skutečné children a jejich
  pořadí. Jen nativní row wrappery; md:contents ponechá stejné jediné odkazy
  desktopovému4col gridu. Žádná změna LinkButton props nebo datového filtru.
- Actual390:10ownerchildren v5dvojicích, kontrola44px a gap24; screenshot
  n1-c39-category-rows-mobile.png prohlédnut rootem i nezávislým reviewerem.
  Actual1440:10odkazů/10uniquehref,4cols275.25/gap4, wrappers contents;
  oba viewporty bez overflow. Nezávislé source+layout region GO.
- Lint/TSRS a formát PASS. Žádný další plný build po OOM; poslední plná sada
  540testů patří C36, tento krok je čisté responzivní rozložení existujícíchodkazů.
- Desktop Figma šedá/lightborder je odlišná od aktuální kit outlined varianty;
  light naopak nemá okraj. Props-only přesná varianta chybí, bez appearanceCSS
  hacku nebo globálního Button override. Paint parity se tímto krokem netvrdí.

## C38: typografie prázdného mini košíku — 2026-11-05

- Fresh Figma59:1042/body311:2331, text311:2338/2339: heading16/500/22.4,
  description14/400/19.6. Původní heading dědil14px. Existující nativní odstavce
  používají canonical text-md/text-sm a již existující leading-n1-copy1.4.
  Žádný nový token, CSS, změna fontfamily nebo restyling kit komponenty.
- Skutečný dev browser1440: heading16/22.4/500/#141414, desc14/19.6/400/#555,
  panel384×190.828, CTA362×28, bez overflow; mobile390 rovněž bez overflow.
  Prohlédnutý screenshot n1-c38-empty-mini-cart-final.png a nezávislé omezené
  Figma/source/screenshot region GO. Fontfamily parity celého webu se netvrdí.
- Aktuální Figma skutečně má fullwidth28 CTA a přibližně190px panel;
  historický vyšší panel/intrinsic CTA není použita jako aktuální autorita.
  Samostatný fresh audit potvrdil i existující PDP H1: mobile32/700/48,
  desktop24/700/36; proto se správná responsive typografie neměnila.
- Package stepper zůstává následný UX bod: přidat jen step nestačí, protože
  Zag po decrementu clampuje na minimum (min3/pkg2/qty4→3). Validace odmítne
  neplatný návrh; tuto edgecase nepovažujeme za dokončenou interakční paritu.

## C37: jednotka počtu produktů i na mobilu — 2026-11-05

- Fresh Figma31:638/31:639, mobile38:2182: také mobil ukazuje počet včetně
  slova produkty/produktů. Odstraněna pouze responsive hidden třída na existujícím
  pluralizovaném unit span; EN prefix Found. Owner total/Intl plurály nezměněné.
- Samostatné Figma/source review GO vůči přesnému dvouřádkovému diffu; následný
  nezávislý tool read nebyl dostupný (transport closed). Není to nový token/API.
- Skutečný browser dev3071:390 „Nalezeno20produktů“,1440 „Zobrazeno20produktů“,
  obě bez overflow. Číslo20 je aktuální owner výsledek, nikoli Figma fixture1451.
  Prohlédnutý mobilní screenshot n1-c37-category-counter-mobile.png soukromě.
- Formát PASS. Poslední plná sada540/540 a plný build patří C36. Dva C37 build
  pokusy byly přerušené; druhý dokončil compile/TypeScript/static pages, ale ne
  build traces. Dokončený C37 produkční build se netvrdí; po pádu PC byl tento
  malý layout/copy krok ověřen jediným dev FE bez dalších těžkých procesů.
- Pozitivní produktový CreateTask QA stále neodeslaný: automatická schvalovací
  kontrola vyžaduje konkrétní souhlas s jedním Stage WorkTask záznamem.

## C36: vlastní nativní balení přes detail a košík — 2026-11-05

- Full public owner variantRecords již packageQuantity poskytuje; N1 reader je
  zahazoval. Nyní zachová vlastní optional pole a native minimum default1.
  Selection odstraní parent balení, nepřebírá je pro variantu bez pravidla.
- Sdílená validCartQuantity ověřuje minimum a násobek balení od0/tolerance1e-6
  v PDP, card shortcut, cart persistence/add/merge/update a obou editorech/gate.
  Min3/pkg2 nepřepočítává:3/5 odmítá,4/6 přijímá. Desetinná balení zůstávají.
- Cart snapshot rozlišuje legacy missing, fresh native absence null a skutečné
  finite balení. Čerstvé null zruší zastaralé pravidlo; legacy re-add ho nezahodí.
  Quote/order payload a native validace cen/skladu/pravidel zůstávají beze změn.
- TDD skutečné RED→GREEN,540/540 testů bez skipped/todo, lint/TSRS, formát
  a produkční build PASS. Nezávislé source review GO po opravě stale-rule nálezu.
- Živý browser1440/390: Fox M1968, min1,0→invalid/disabled,1→toast bez extra
  Cart linku; košík1→2, reload zachová2, native quote950/DPH164.88/net785.12,
  checkout dostupný a bez overflow. Screenshot n1-c36-cart-mobile.png soukromě.
  Balení2/6.21 je regresní test fixture, nikoli vytvořený Stage produkt.
- Žádný nový vzhled, komponenta, BE změna, fixture produkt nebo další objednávka.
  Funkční browser proof neznačí plnou vizuální shodu celého košíku.

## C35: skutečný loading READ detailu produktu — 2026-11-05

- Fresh Figma57:3009: existující CatalogState skládá pending PriceBlock,
  AvailabilityStatus a disabled loading Button z veřejného API kitu. Category
  loading a skutečný unavailable/retry zůstávají oddělené. Nezobrazuje cenu,
  sklad ani Přidávám, dokud žádný produkt / cart Action nejsou k dispozici.
- Generický nadpis zachovává neznámou identitu; nevkládá jméno fixture ani
  její pevnou výšku. Jen layout wrappery; žádné nové vzhledové třídy na kitu,
  paletové hodnoty, radius override nebo změna fontu. Canonical N1 tokeny platí.
- TDD skutečně RED→GREEN;529/529 N1 testů, lint/TSRS, formát a produkční build
  PASS. Samostatné source/contract review GO. Build běžel s naším FE vypnutým.
- Browser390 se skutečným katalogem a Slow3G zachytil pending DOM: section390,
  p16/gap24, H1 24/600/36, Button358×44/disabled/#eee/radius2, bez overflow;
  následně skutečný detail. Price/availability wrappery oba38px, oproti Figma
  34/36px jde o skutečný výstup kitu. Pending screenshot nebyl zachycen;
  screenshot začátku ani konce navigace za tento stav nevydáváme. Plný vizuální
  browser PASS se netvrdí. DOM důkaz zůstává soukromě v n1-c35-actual-pending-mobile-dom.txt.
- Známý rozdíl importované Figma / canonical tématu zůstává: Button radius8
  versus N1 radius2, Skeleton4 versus0; neobchází se lokálním CSS. Čeká také
  společné rozhodnutí o fontu. Celý storefront není prohlášen za1:1 hotový.

## C34: všechny výslovně podporované locale tagy — 2026-11-05

- N1 market admission chybně zkoušela jen supportedLocales[0]. Owner contract
  používá neprázdné unikátní pole podporovaných tagů, bez primarylocale práva;
  jeho testy modelují jeden market s cs-CZ/en-CZ. N1 nyní kontroluje `.some`.
- Scope tenant/app/seller/B2C/effective/ACTIVE a odmítnutí ambiguity zůstávají
  beze změn. Nevybírá jiný jazyk ani nefiltrovaný katalog; dva podporované EN
  tagy jednoho marketu stále znamenají jeden market, nikoli dva kandidáty.
- TDD secondarylocale/order a ambiguous skutečně RED→GREEN;10 nových případů
  včetně unsupported EN/DE a lifecycle, plných525/525 N1 testů PASS.
  Lint/TSRS, formát a produkční build PASS; samostatné source review GO.
- Toto není tvrzení o změně živé market definice nebo pozitivním EN průchodu.
  Dříve ověřený CS-only market se tím anglicky neotevře. Žádná nativní
  ReviseMarketDefinition ani nový měnový market nebyly provedeny.

## C33: skutečný dotaz na produkt přes existující Contact / Work Tasks — 2026-11-05

- Figma desktop219:2865 v219:2854 + aktuální Akros FOR-KAI-UWE kontakt424:
  PDP Link přenáší skutečné productId a zvolenou variantu do kontaktního formuláře.
  Historické N1 NOOP akce nejsou převzaté. Mobil31:641 actionrow nemá;
  desktop-only je doložený rozsah, ostatní tři akce/ETA nejsou prohlášeny hotové.
- Pouze selektory + zákaznická pole v kanálu. Jedna vybraná varianta max300 znaků
  včetně skutečných legacy ID; missing/repeated/plural/foreign/inactive odmítnuty.
  Stejný public catalog Effect používá přesný productIds:[id]/full/pageSize1,
  vybraný N1 market a returned-market kontrolu, nikoli staff či nefiltrovaný fallback.
- Před nativním CreateTask se canonical produkt/varianta čtou znovu, ještě před
  Work Tasks revision read. Kind/title/subject/productName/slug odvozuje server;
  varianta je uložena v canonical description, owner nemá variantIds pole.
  Nejasný Action výsledek zůstává terminal; žádný nový retry nebo náhradní klíč.
- Chybná identita končí404; nedostupný produktový read zamkne produktový dotaz,
  nepřepne jej tiše na obecný CONTACT. Key odpovídá selectoru. Zpráva je editable,
  ale její text není autoritou pro canonical metadata. Limity1500/ownerdescription2000
  mají sdílený konzervativní budget a maxlength; nativní schema znovu validuje,
  žádné ořezávání zákaznické zprávy při zápisu.
- TDD dva nové případy skutečně RED→GREEN.515/515 N1 testů PASS, lint/TSRS,
  formát a produkční build PASS; po scope/props úpravě také cílené route/PDP testy.
  Nezávislé source review GO. Větší kroky běžely postupně s naším FE vypnutým.
- Skutečný browser CS1440/390: M1968→prefill29092-185-M, S1969→29092-185-S,
  produkt490c4aec-197b-45ba-ae19-cb0988b69e14. Maxlength1467, label700, mobilní
  pole147×44, žádný horizontální overflow. Nativní produktový GET byl úspěšný.
- Finální Icon props md/secondary: skutečný paint16×16/#555/gap8/row24;
  `.local/n1-c33-pdp-question-desktop-final.png`, reference n1-pdp-actions-figma.png.
  Link0.57 je unstyled a neumí Figma sm14/fg-secondary/underline přes veřejné API;
  canonical defaultlinktokeny navíc této instanci neodpovídají. Žádné appearanceCSS
  ani app token override nebyly přidány. Plná vizuální shoda actionrow se netvrdí.
- Pozitivní CreateTask QA zatím neproběhlo kvůli běžícímu datovému writeru.
  EN productquestion GET pravdivě skončil unavailable/disabled přes stávající
  StorefrontMarketUnavailable; EN pozitivní průchod ani odeslaný e-mail se netvrdí.

## C32: článková kompozice nedostupných novinek — 2026-11-05

- Fresh Figma desktop370:2418 / mobile370:2538: obal max1200/p40,
  H1 24/32 s96×4 podtržením, gap24, dva source paddingy40=80,
  sdělení16/24 vystředěné. Wrapper používá existující layout/typography tokeny.
- Nedostupnost zůstává skutečná `featureUnavailable`, nikoli fixture tvrzení
  o prázdném feedu. Nezměněné čtení dat, právní články a kit komponenty.
- 490/490 N1 testů PASS, lint/TSRS, formát a produkční build PASS; běželo
  sériově s naším FE vypnutým. První testovací start v sandboxu odmítl lokální
  socket EPERM; standardní běh s povoleným socketem poté prošel.
- Skutečný produkční browser1440/390: obal1200/p40, na mobilu inner310,
  nadpis32, gap24, sdělenípy80/center, žádný horizontální overflow.
  Screenshot `.local/n1-c32-news-mobile.png`; úzká Figma reference
  `.local/n1-news-article-figma.png`. Font zůstává system-ui; úplná pixelová
  shoda celé stránky se netvrdí. Pozitivní news feed není implementovaný.
- Nezávislé source + screenshot-region review GO bez nálezu; posuzované jen
  toto rozložení, nikoli dokončený CMS nebo celý storefront.

## C31: správná registrace kanonické tučnosti Label — 2026-11-05

V kitu0.57 zastaralý --font-label:var(--font-bold) vytvořil font-family utility
a zastínil již exportovaný --font-weight-label. Soukromá skutečná Tailwind
kompilace prokázala původní family pravidlo i opravené weight pravidlo. N1
odregistruje pouze tento neplatný family alias pomocí @theme static/initial;
stejná knihovní třída pak používá původní kanonickou váhu. Nevzniká nový
font/weight/style role ani per-instance appearance CSS. Most má explicitní
odstranění po opravě příslušného exportu kitu a nezávislé source review GO.

Produkční browser1440/390: všechny čtyři kontaktní Label mají700; body zůstává
system-ui400 a Button system-ui500. Mobilní pole147×44, Label147×24, bez
overflow. Login popup používá Label700; checkbox vlastní400 zachovaný.
Theme:check potvrzuje nezměněných447 kanonických tokenů.490/490testů,
lint/TSRS, formát a produkční build PASS.

Další skutečné proklikání3071: katalog233stran/16produktů na poslední; hledání
Northwave vrací8nativních suggestions200, ArrowDown zvýrazní první, Escape
zavře a drží focus, ArrowDown/Enter přejde na správný owner PDP bez mini košíku.
Neplatný kontaktní e-mail drží focus a vytvoří0inquiry požadavků. Login i prázdný
mini košík mají na390 panel372px/x8 bez overflow; Escape zavře a vrátí focus
na příslušnou ikonu. Pozitivní contact write/Portal login nejsou tímto tvrzené.

Zbývající rozdíly jsou doložené v.local/N1-FIGMA-TOKEN-CONTRACT-AUDIT.md:
stale imported radius8 proti aktuálnímu N1radius2, explicitní kontaktní label
14 vs deklarované md16 a desktopové chip overrides. Inter/system-ui rozdíl
je známý v handoffu123–124; rozhodnutí o sjednocení písma čeká na uživatele.

## C30: responzivní výběr velikostí bez duplicit — 2026-11-05

Čerstvá Figma219:2778 má desktop sm/secondary/outlined pro všechny velikosti;
39:2461 má mobil md a vybranou primary/solid se suffixem. Po upstream opravě
duplicitních odkazů používá N1 stejné keyed LinkButton a mění pouze jejich
veřejné scalar props přes useSyncExternalStore/matchMedia768px, podle stávajícího
AccountView patternu. Jeden inline label odstraňuje nechtěný knihovní flex gap
mezi velikostí a suffixem. Žádné appearance CSS ani přepis theme.

Browser skutečně ověřil32↔44px při768→767→768, stejné UID70_17/20/22 a focus
na M, následný Tab právě na S. Desktop selected není žlutý, mobil selected je
canonical primary. Finální mobilní label je jediný textový celek;390 nepřetéká.
Automatické testy ověřují přesný media query, změny stavu, cleanup a nezávislé
subscribery; existující SSR/selection testy potvrzují jediný odkaz na velikost.
490/490testů, cílený finální rerun, lint/TSRS a produkční build PASS.

Omezení: SSR/první hydration snapshot má mobilní fallback; správné desktopové
props nastoupí po hydrataci. Není tvrzen zero-flash SSR. Přesné šířky zůstávají
komponentovou odchylkou: vydaný sm kit má font14/padding-x16 a šířky46.3/41.6/50.3,
Figma40/34/42. Mobilní selected po opravě labelu122.8 vs Figma128. Tyto rozdíly
nejsou maskované instance CSS a celá PDP není prohlášená za1:1 PASS. Důkazy
n1-c30-picker-desktop a n1-c30-picker-mobile-checked jsou v.local.

Nezávislé nativní ověření Stage OBJ-2026-0002 již dokončené: uložená NEW/STOREFRONT
objednávka, právě jeden ORDER−1 a zásoba45→44; scope/trh/částky správné. Jiný
záznam OBJ-2026-0001 je starší zrušená objednávka jiného produktu, nikoli duplicita.

## C27–C29: karty a skutečné právní články — 2026-11-05

Čerstvá Figma home31:636/637 a featured33:877/34:1027 potvrzuje jednu mobilní
kartu na řádek, desktop čtyři288px sloupce, padding112 a mezeru24 pod nadpisem
20/28. Mobilní název má přirozenou výšku; prázdná řádka velikostí se na mobilu
nemontuje. Desktopovou rezervu ani vzhled komponent kitu tato oprava nemění.
Skutečný browser1440 potvrdil112/24/28 a4×288; mobil390 nepřetéká.

Jednoduchá karta může nově použít skutečný košík: výslovný konzistentní počet
aktivních variant0, žádné variantní štítky, skutečné minimum/jednotka/cena/sklad,
načtený bezchybný cart a odpovídající scope/měna. Minimum odporující nativnímu
násobku balení nákup zkratkou zablokuje; množství se nevymýšlí ani nezaokrouhluje.
Regrese pokrývají3/2,3/1.5 i0.3/0.1, skutečnou projekci packageQuantity,
reentrantní přidání a pravdivý storage success/error. Native quote zůstává
autoritou pozdější ceny/skladu a ručních změn množství.

Browser desktop i dotykový mobil skutečně přidal Fox22Purist product16609,
1ks, do uloženého cart draftu. Zůstal na stránce, zobrazil success toast a
neotevřel mini košík. Následná route košíku držela skutečný produkt/množství.
Jde o draft, nikoli objednávku či rezervaci. Důkaz n1-c27-card-toast-mobile
je v.local; minimum3/jednotka m a package kontrakt byly ověřeny automaticky.

Obchodní podmínky50:867/1032 a ochrana údajů50:1126/1288 obsahují přesné
poskytnuté statické N1 články, které jsou také v historické referenci. Nejde
o simulaci CMS. Checksum regrese pokrývají všech21/18 textových prvků,
sémantiku a zachování ostatních rout/404. EN rozhraní ponechává český článek
s article lang=cs, bez vymyšleného překladu. V browseru1440/390 je article
max1200/padding40, mobilní vnitřek310, body16/24; privacy má dalších48 nahoře
a na mobilu H1 přes dva řádky64px. Nezávislé vizuální review přijalo viditelné
regiony; celé znění dokládají testy. Důkazy n1-c28-terms/ privacy-desktop/mobile
jsou v.local. Žádné změny souhlasu, právních verzí, kitu ani globálního CSS.

C29 promítá owner net cenu pouze při prokázané jednoduché dostupné kartě,
bez skupinového cenového minima. Používá existující přesné gross/net párování;
žádný výpočet DPH či další dotazy. Tax caption konzumuje pouze ListingCards.
Skupiny, rozporné/neznámé počty a všechny neaktivní varianty zůstávají bez
neprokázané caption. Umístění a redakce caption jsou ověřené renderer testy;
pozitivní browser kontrola caption ve skutečné kategorii čeká na její skutečné
produktové vazby. Není tvrzená úplná vizuální shoda tohoto regionu.

Po začlenění upstream6f83:488/488 N1 testů, lint/TSRS, formát a produkční build PASS.
Nejde o celostránkový1:1 PASS ani důkaz pozitivního Portal přihlášení.

Sdílený Stage přes lokální3072 již prokázal celý guest průchod: cart quote200,
checkout quote200 a právě jedno potvrzení200 vytvořilo OBJ-2026-0002,
1×Fox22Purist/SKU31190-001-OS, zboží549+PPL129=678Kč, net560,33/DPH117,67.
Tlačítko načtení detailů i reload→read-only status200 obnovily stejnou objednávku,
adresu a fotografii po vyprázdnění draftu. Mobil390 nepřetéká. Žádná online
platba nebyla dostupná ani provedená; skladové ověření běží odděleně. Dřívější
403 není současný univerzální blokátor. Nejde o pozitivní test všech produktů.

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

## 8. 11. 2026 — PDP stavy a krok balení

Aktuální Figma `39:1965`, `39:2430` a mobilní stav bez výběru `57:2916`
byly znovu načtené včetně screenshotů. Porovnání používá stejný skutečný
Fox Rwt Flag Ss Tech Tee ze Stage, samostatně bez varianty a s variantou M.

Mobil bez výběru nyní zachovává návrhové pořadí cena → neznámá dostupnost →
varianty → zakázaná nákupní akce. Vybraný mobilní stav i desktop zachovávají
původní skladbu. Čtyři produktové akce mají pořadí a ikony podle návrhu;
oblíbené a hlídání jsou skutečně zakázaná nativní ovládání přes veřejné
`Link as="button"` API. Nemají href, callback ani náhradní úložiště. Dotaz
a sdílení zůstávají napojené. Nedostupnost má lokalizovaný přístupný popis;
vzhled Linku sám neodlišuje disabled stav ani nepřidává návrhové podtržení.

Všechny čtyři vstupy množství používají skutečnou konečnou kladnou velikost
balení jako krok. Nula, záporná či chybějící hodnota znamenají krok 1;
neplatná nekonečná hodnota se rovněž nepředá stepperu. Nativní validace
minima a balení zůstává samostatná, draft se nezaokrouhluje a sklad není
vydávaný za maximální prodejné množství.

Regrese nejprve prokázaly pět chyb normalizace a dvě chybějící zakázané akce.
Po opravě prošlo **711 testů v 70 souborech**, bez skip/todo. Kontrola všech
447 kanonických tokenů prošla. Root i nezávislý reviewer otevřeli skutečné
before/after PNG pro desktop 1440 a mobil 390 a porovnali je s Figmou;
vizuální GO platí pouze pro tyto změněné stavy a zachování ostatní skladby.
Navíc byl otevřený EN320 screenshot bez vodorovného přetečení.

Konkrétní mezery celého PDP: Figma má pro jednu fotografii redakční ořez,
který současná média nepředávají; plošný cover by mohl oříznout boty.
ETA, aktivní oblíbené/hlídání, tabulka velikostí a skutečné související
vztahy nejsou tímto celkem implementované. Nejsou nahrazené fixtures.
Celý PDP ani storefront nemají plošný vizuální PASS. Tento průchod
neodeslal registraci, e-mail ani objednávku a nedokládá nový úspěšný deploy.

N1 lint, typová kontrola a formát upravených souborů prošly. Globální
`pnpm i18n:boundaries` zůstává neúspěšné se stejnými 28 nálezy
`strict-effect-api-boundaries` v API vstupech ostatních verticalů; nejde
o chybějící N1 překlady. Diagnostika se nepotlačuje a globální PASS se netvrdí.

## 8. 11. 2026 — výslovná kopie uložené adresy do checkoutu

Figma guest checkout `44:1226` a adresy účtu `54:1759` byly znovu načtené.
Guest návrh uložený výběr neobsahuje; interakční předloha pochází z uživatelem
určeného historického N1 `billing-address-section.tsx` a `address-picker.tsx`.
Použitý Select, FormInput, validace objednávkové adresy a zákaznický GET jsou
současné veřejné kontrakty; historické API ani styly se nepřebírají.

Uložená adresa se kopíruje až výslovným výběrem. Kontakty zůstávají ruční.
Adresy s nereprezentovatelnými údaji jsou nevolitelné s lokalizovaným důvodem.
Přesná instance přihlášení, monotónní generace a aktuální seznam zemí chrání
proti pozdním odpovědím, A→B→A i novému přihlášení stejného e-mailu. Provenience
zkopírovaných polí přežije ruční editaci. Checkout controller zneplatní quote
při změně session nebo zemí; explicitní editace používají stávající `onEdit`.

Celá sada prošla: **738 testů v 72 souborech**, bez skip/todo. N1 lint, typová
kontrola a formát osmi zdrojových/testovacích souborů prošly. Nezávislé zdrojové
review nenašlo další blokátor v tomto rozsahu. Po fast-forward načtení šesti
upstream commitů do `0de1c421e` znovu prošlo všech 738 testů i N1 lint.
Produkční Next build po aktualizaci rovněž prošel včetně TypeScriptu,
statických stránek a trasování standalone výstupu. Tento výsledek není
globálním repository PASS.

Skutečný Chrome v izolovaném komponentovém harnessu ověřil nativní FormData,
výslovnou kopii CZ/SK, zachování kontaktů, žádný automatický výběr při načtení,
vyprázdnění zkopírovaných polí po odebrání země i novém přihlášení stejného
e-mailu, pending→ready bez oživení staré kopie a ignorování pozdního výsledku A
po výběru B. Disabled stav zakazuje formulář i selector. Konzole bez chyb a
varování, žádné skutečné zákaznické/quote/order požadavky. Testovací autentizace
a odpovědi jsou pouze v ignorovaném harnessu; produkční kód je nepoužívá.

Vizuální kontrola našla problém skutečného knihovního popupu: dlouhá položka
roztáhne seznam na 1597 px při 570px triggeru a způsobí horizontální přetečení.
Veřejný typ `Select.positioning` existuje, ale runtime jej nepředává Zag stroji.
Přesná dvouřádková oprava byla ověřena pouze privátní simulací; se
`sameWidth: true` měl seznam 570 px na desktopu a 356 px na mobilu. Obyčejný
country Select si zachoval výchozích 279 px. Root i reviewer otevřeli vadný
a oba simulované PNG. Sdílený patch ani lockfile zatím nejsou změněné;
produkční vizuální GO pro tento selector se proto **neuděluje**. Živý pozitivní
Portal průchod, zákaznické adresy na Stage a přihlášená objednávka zůstávají
neověřené. Nebyl odeslán registrační, e-mailový ani objednávkový zápis.

## 8. 11. 2026 — dokončení probíhajícího MFA přihlášení

N1 nově používá existující veřejnou skupinu `portalAuthMfa` pro explicitní
odeslání OTP a ověření OTP/TOTP. Scope je pouze dokončení challenge vrácené
současným loginem. Backend, provider, granty, role ani klíče se nemění.
Native verify acknowledgement nestačí: nový owner klient musí s rotovanými
cookies načíst čerstvou zákaznickou admission. Anonymní, cizí tenant nebo
nevalidní admission není úspěšné přihlášení. Odpovědi zachovávají i mazání
cookies při odmítnutí. Odeslání OTP se potvrdí pouze při skutečném true;
false vede na nejasný výsledek. Origin a uzavřené payloady zůstávají chráněné.

Prvních šest testů nejprve reprodukovalo neexistující endpointy 404. Finální
cílený celek prošel 77 testy v 5 souborech; celá N1 sada prošla **770 testy
v 74 souborech**, bez skip/todo. N1 lint, finální typová kontrola, diff-check
a produkční Next build včetně obou nových API rout prošly. Globální
`i18n:boundaries` má nadále 28 nálezů `strict-effect-api-boundaries`, všechny
mimo N1; žádná diagnostika nebyla potlačená. Globální repository PASS se netvrdí.

Regrese zahrnují chybný/cizí payload, Origin bez owner dispatch, nativní
chybové kódy, false OTP ack, rotované i expirované cookies, neplatné/cizí/
anonymní admission a ochranu proti opožděnému přijetí nebo toastu. Kód je
neprázdný řetězec bez okrajových mezer do 32 znaků podle veřejného kontraktu,
nikoli nucených šest číslic. Vstup se nemění trimem, nepřesouvá do URL, logů
ani storage a po odeslání se maže. Nejasné ověření se automaticky neopakuje;
safe GET může potvrdit aktuální session, neobnovuje domnělou ztracenou challenge.

Fresh Figma metadata formulářů, účtu a stavů neobsahují MFA rámec; načtená
login reference `333:4672` určuje použití stávajících komponent, nikoli nový
MFA pixelový cíl. Root i nezávislý reviewer otevřeli skutečné PNG finálního
desktopu 1440, mobilní chyby 390 a EN throttle 320. Native formulář má 448 px
na desktopu, obě úzké sestavy nepřetékají. Chyba kódu se po nalezené browserové
regresi zobrazuje pouze jednou u pole s aria-invalid/describedby.

Izolovaný loopback harness používá skutečný AuthView, session controller
a veřejný HTTP klient. Pouze framework adaptéry a odpovědi HTTP jsou testovací;
nevolá Stage ani neposílá e-maily. V prohlížeči prošla explicitní volba metody,
zadání nenumerického platného test kódu, přijetí výsledku, vypršení → prázdné
credentials, a pending → zakázané akce/aria-busy/prázdný kód. Unconfirmed stav
odstraní opakovaný submit; po jediném verify POST následoval safe GET recovery.
Volba OTP nic sama neposlala. Read-only DOM pozorování zachytilo skutečný
native toast až po explicitním request POST; na 390 px měl 360 px a x6. Nový
toastový PNG není dokladem tohoto průchodu, krátké oznámení při snímání již
zmizelo. Konzole kontrolovaných stavů byla bez chyb a varování.

Source i vymezené layout review mají GO. Skutečný zákaznický MFA účet,
doručení OTP a živý pozitivní Portal průchod zůstávají neověřené. Nastavení/
vypnutí MFA, backup kódy a trust-device nejsou součástí této implementace.

## 8. 11. 2026 — aktuální inventář a ověření právních článků

Fresh metadata všech pěti Figma stránek obsahují 87 top-level rámců
(3/6/10/26/42). Nová úvodní tabulka FIGMA-INVENTORY rozlišuje současnou
implementaci od původních historických stavů. Strukturní inventář není
87 čerstvých pixelových review ani seznam 87 routes.

Zdrojová kontrola nalezla staré nepřesné tvrzení README: obě právní routes
již renderují dodanou statickou českou kopii. Jejich article lang=cs je
výslovný i pod anglickým chrome. Nejde o CMS, nativní policy/verzi ani tvrzení
právní správnosti. Novinky nadále zobrazují unavailable, vlastní CMS route chybí.

Oba články byly skutečně otevřené na localhost3071 při 1440 a 390 px.
Fresh Figma main370:2679/2870/3084/3264 i všechny čtyři actual PNG otevřel
root a nezávislý reviewer. P40, Privacy extra48, vnitřní1120/310, nadpisy,
obsahové bloky a hierarchie odpovídají. Žádný článek není oříznutý a mobil
nepřetéká. Kompozice článků má dílčí GO; jejich zdroj se neměnil.

Pixelová shoda zůstává otevřená. Terms desktop má958px stejně jako návrh,
mobil1300 oproti1324. Privacy desktop1022 oproti1046, mobil1750 oproti1774.
Konkrétní odstavec370:3125 má při shodných1120px šířky a16/24 typografii
v návrhu72px, v DOM48px. Aktuální system-ui a návrhový Inter jinak zalamují
text. Rozdíl se neobchází24px spacerem ani novou fontovou výjimkou. Hlavička,
patička a již odložené typografické rozdíly nejsou tímto dílčím GO uzavřené.
Konzole kontrolovaných reálných právních stránek byla bez chyb/varování.

Tato navazující změna opravuje dokumentaci a inventář, nikoli runtime.
Předcházející770testů, lint/type/build zůstávají datovanou evidencí stejného
runtime snapshotu; kvůli dokumentaci se znovu nespouštějí jako nový důkaz.

## 8. 11. 2026 — mobilní zarovnání stránkování kategorie

Fresh Figma `38:2138` a `38:2409` umisťují mobilní Pagination na levý
okraj obsahu; desktop `214:4488` je výslovně zarovnaný vpravo. Skutečná
kategorie před úpravou měla při 390 px nav x=234 v obsahu x=16 / w=358.
Oprava mění pouze aplikační layout wrapper přes volitelný `mobileAlignment`.
CategoryView předává start; výchozí end zachovává původní vyhledávání.
Knihovní Pagination, její props, velikost, count a tvorba URL se nemění.

Actual localhost po opravě: kategorie na mobilu x=16, desktop při 1440 px
stále x=1257 / pravý okraj=1397. Skutečné kliknutí na stránku 2 zachovalo
`?page=2`, aktivní stránku 2 a mobilní levé zarovnání. Vyhledávání Spyder
při 390 px zůstalo vpravo x=198 / pravý okraj=374 a odkazy dál obsahují
`q=Spyder` i cílovou stránku. Obě mobilní stránky mají scrollWidth=390.
Root a nezávislý reviewer otevřeli všechny čtyři before/after PNG kategorie
(desktop i mobil) a aktuální Figma kontexty. Dílčí source/layout GO.

Existující katalogové testy: 40/40 ve 4 souborech PASS; N1 typecheck a lint PASS.
Neúspěšný filtr category nevybral žádný test a nebyl počítaný jako úspěch;
první katalogový běh blokoval sandboxový listen EPERM, stejný test potom
prošel s povoleným lokálním socketem. Nový test kopírující jednu layout
class se nepřidával. Poslední celý runtime suite měl 770 testů; tento
záznam netvrdí nový běh celé sady ani nový produkční build.

Lokální Next konzole při scrollu hlásila LCP doporučení loading=eager pro
konkrétní produktový obrázek. Tento warning nebyl skrytý ani označený za
čistou konzoli; není předmětem opravy stránkování. Odložené metriky UI kitu
se touto změnou nemění a celý katalog nedostává plošné vizuální schválení.

## 9. 11. 2026 — upstream, živé auth/checkout a konečná native diagnostika

Fast-forward o 22 upstream commitů do f1ce6770a zachoval všech pět cizích
tracked WIP byte-identical. Následně byly načtené další tři test-only upstream
commity do c12d3213a, bez změny N1 runtime. Na aktualizovaném N1 prošlo
770 testů, typy a lint.
Živý browser login se stávajícím testovacím vstupem skončil HTTP401 credentials.
Jeden nový UI registrační POST po skutečném souhlasu skončil HTTP403,
PortalRefusedProblem / owner-enrollment-rejected. Ověřovací e-mail, přihlášený
profil, vlastní objednávky a přihlášený nákup nemají pozitivní živý důkaz.
Předchozí setupy s nulovým dispatch se nepočítají jako backend pokusy.

Actual cart quote na localhostu i nasazeném N1 vrátila HTTP503; checkout CTA
zůstalo disabled, nová objednávka nevznikla. Nová lokální serverová diagnostika
před ztrátou native failure zachytila HttpClientError / StatusCodeError /404.
To není důkaz chybějícího grantu ani špatného prefixu. Statické porovnání
potvrdilo vydaný baseUrl a dedikovaný place-storefront-order endpoint podle
aktuálního public SDK. Starší AKROS apply-command volání není kompatibilní
alternativa: současný public ApplyCommandPayloadSchema přijímá CreateProduct.
Žádný runtime fallback, nový grant ani obcházení owner kontraktu se nepřidává.

Diagnostický patch mění jen serverový Effect log před dosavadním catch:
pevný operation/tag, kód z uzavřených typed kontraktů, finite transport reason
a HTTP status100–599. Žádný raw error/cause/body/header, URL či identifikátor.
Veřejná API odpověď ani počet nativních požadavků se nemění. Pět nových regresí
ověřuje známé kódy a redakci neznámého kódu, neplatného těla a transportu.
42 cílených testů a nová celá sada **775/775 v 74 souborech PASS**, bez skip/todo;
N1 lint a typecheck PASS. Nezávislé source review GO, skutečný bezpečný log
ověřený v lokálním běhu. Nový produkční build se v tomto kroku neprováděl.

Stage run pro f1ce6770a dokončil všech sedm build shardů a nasadil N1;
společný app stack.build selhal s provider500/InternalServerError. Verify
a source pins byly přeskočené, ověřený release není doložený. Konkrétní
registrační korelace a Zerops proces zůstávají pouze v privátní .local evidenci.

## 9. 11. 2026 — PDP, karty a zpětná vazba vyprodaného produktu

Čerstvé Figma kontexty 39:1965 / 39:2430 a 214:3250 byly porovnané se
skutečným Fox PDP a Spyder kartami. Browser PDP 3/3 (CS desktop a mobil,
EN mobil): výběr varianty, historie Zpět po dokončení renderu, galerie 2→1,
přepnutí záložek, množství 2→0 zakázáno→1 a lokální add přes toast bez
otevření minikošíku. Karty 3/3: tři velikosti +N, skutečné odkazy na šest
variant, popup ve viewportu, Escape a návrat focusu, přechod na přesnou
variantu. Žádný business POST, objednávka ani registrační e-mail.

Figma stav Vyprodáno 57:2965 odhalil redundantní obecný popisek o nedostupném
nákupu. Před opravou byl viditelný na skutečném vyprodaném Capita produktu;
po opravě jej přesný owner stav unavailable potlačí. Blokování nákupu a
validace množství zůstaly stejné, stejně jako diagnostika skutečně chybějícího
nákupního kontextu pro IN_STOCK a UNKNOWN. Nová regrese používá skutečný
projector a UI kit SSR: před opravou 2 FAIL / 2 PASS, po opravě cílených
11/11 PASS. Browser po opravě CS/EN mobil + CS desktop 3/3, popisek chybí,
CTA disabled, bez overflow. Root i nezávislý reviewer otevřeli before/after
screenshoty a Figma stav; dílčí GO pouze pro odstranění popisku.

Celá N1 sada **787/787 v 75 souborech PASS**, bez skip/todo. N1 typecheck,
lint, formát a kontrola všech 447 kanonických tokenů PASS. Nejde o
potvrzení úspěšného Stage checkoutu ani plošnou vizuální shodu storefrontu.
Známé rozdíly metrik UI kitu a chybějící owner schopnosti se tím neuzavírají.

## 9. 11. 2026 — validace přihlášení, registrace a minipřihlášení

Čerstvá kontrola Figma 56:883/978, 333:6888 a 59:1709 odhalila rozdíly
required-password copy, valid okraje a CTA v chybovém stavu. Samostatná
browser diagnostika potvrdila i ztracené první kliknutí na souhlas: blur
potvrzení hesla posunul checkbox o 64 px před dokončením stejného kliknutí.
Oprava podrží jen výsledek blur validace do dokončení pointer gesta;
klávesnicovou validaci neodkládá. Čtyři nové jednotkové regrese pokrývají
běžný blur, odložený výsledek, zrušení a následující gesto.

Public FormInputRaw a StatusText zachovávají knihovní tokeny a neutrální
valid okraj se samostatnou success zprávou bez ikony. Chyby mají stabilní
aria-describedby/aria-invalid, i při souběhu hlavního a popup formuláře.
Pravidla jmen a hesla 12–128 určuje owner kontrakt; návrhová ukázka
8 znaků + číslice je nenahrazuje. Kontrola neodesílá skutečný signup/login,
nepotvrzuje doručení e-mailu ani úspěšné přihlášení na Stage.

Skutečný browser ověřil 80/80 kombinací: osm validačních stavů ve dvou jazycích
na šířkách 320/390/768/1024/1440. Souhlas se zaškrtne prvním kliknutím,
oprava mismatch obnoví CTA, popup validuje vlastní pole a Escape vrací focus.
Business POST ani blokovaný pokus o něj nevznikl. Root a nezávislý reviewer
otevřeli reprezentativní actual PNG; dílčí source + visual GO je omezené
na tuto opravu, nikoli celý storefront nebo přesnou shodu kanonického theme
s odlišnou Figma fixture.

Celá N1 regrese: **801/801 v 76 souborech PASS**, bez skip/todo. Typová kontrola
PASS. Nevzniká nový důkaz funkční registrace nebo nákupu na Stage.

Finální lint cleanup zachoval chování: controller se jednou inicializuje
z event handleru, pomocná metoda se jmenuje validateOnBlur. N1 lint PASS bez
suppressions; cílených 8/8 auth/recovery testů i opakovaná finální typová
kontrola a formát PASS. Kontrola 447 kanonických tokenů PASS.

## 9. 11. 2026 — katalog, PDP a mobilní košík

Čerstvé Figma kontexty 31:638/639, 214:3169/3246, 39:2458 a 219:2772–2774
byly porovnány se skutečným katalogem a Fox PDP. Průchod před i po opravě:
6/6 kombinací CS 320/390/768/1024/1440 a EN390, bez overflow a pageerror.
Mobilní otevření stromu předává focus. Nepodložené druhé spodní zavírací
tlačítko odstraněno; desktopový produktový kód zachovává řádek i bez SKU.
Skutečné SKU vybrané varianty zůstává. Chybějící SKU ověřují existující
owner-projector SSR regrese, nikoli úspěšně dohledaný živý produkt bez SKU.

Katalogová Figma neobsahuje filtry ani řazení; tyto prvky nebyly doplněny.
Skutečné jiné kategorie, počty a obrázky se neskrývají kvůli návrhové fixture.

Lokální košíkový lifecycle před opravou prošel 6/6, ale skutečné otevření PNG
odhalilo oříznutý toast na320 a žlutý vzhled neaktivního checkout odkazu.
Nová omezená aliasová šířka toastu zachovává canonical size role a native
odstupy. Neaktivní checkout větev používá Button disabled, ověřená skutečný
LinkButton; podmínky nákupu se nemění. Tři cílené regrese před opravou FAIL,
po opravě cart-request + product-detail-projection 37/37 PASS.

Košíkový průchod po opravě: 6/6 na stejných šířkách. Add toast bez automatického
otevření popupu, zvýšení/snížení, odmítnutí nuly bez uložení, oprava množství,
badge, Escape, přenos do košíku, persistence po reloadu a odebrání prošly.
Toast má šířku272/342/360 na320/390/desktop a je celý ve viewportu. Neaktivní
CTA je nativní disabled button bez href,44px a s jednořádkovým textem v CS/EN.
Root a nezávislý reviewer otevřeli actual before/after PNG; GO jen pro tyto
opravy. Známá typografie TotalsSummary zůstává samostatně otevřená.

Všechny skutečné quote odpovědi v této kontrole byly503. Průchod proto
nepotvrzuje platný nákup, částky ani novou objednávku. Neproběhl business POST
ani objednávkový/registrační zápis; quote volání jsou skutečné read-only dry runy.

Klávesnicové zavření skutečného toastu Enterem prošlo CS320 i EN390 se správným
lokalizovaným názvem. Izolovaný skutečný ProductView s owner-schema QA props
pro chybějící SKU prošel 6/6: CS/EN ×390/768/1440, včetně skrytí řádku na mobilu.
Nejde o živý produkt nebo client-hydration test celé stránky. První izolovaný
browser harness neměl správně načtené CSS z about:blank; jeho čtyři dílčí PASS
nejsou vizuální evidence. Opravený harness načítá skutečné CSS ze stejného
localhost originu a před geometrií ověřuje computed padding.

Finální N1 sada **801/801 v 76 souborech PASS**, typy, lint, formát a kontrola
447 kanonických tokenů PASS. Globální i18n:boundaries nadále hlásí 28 původních
strict-effect-api-boundaries chyb ve stejných 28 souborech mimo N1; nový log
byl porovnán s předchozím baseline. Žádná diagnostika nebyla potlačena a nejde
o celorepozitářové zelené ověření. Shared UI kit ani backend se nemění.

## 9. 11. 2026 — checkout validace a čekající akce

Čerstvé Figma checkout podklady 44:1226/2285 a 323:1465/1813 byly
porovnány s veřejným formulářem nad skutečným katalogem a checkout options.
Před opravou nativní anglická bublina překrývala český inline StatusText.
Po opravě zůstává nativní blokování neplatného submitu i focus prvního pole,
ale prohlížečová bublina je potlačená. Přidružené ARIA popisy jsou platné.
Čekající Zpět používá nativní disabled Button bez href; v idle zůstává odkaz.
Tím se uplatní kit disabled vzhled bez vlastních stylů nebo změny protokolu.
Stávající quote/place test nejdřív selhal na původním kódu; po opravě oba
cílené checkout soubory prošly 14/14.

Skutečný browser: CS320/390/768/1024/1440 + EN390. Ověřeny povinné chyby,
první focus, popisy, první kliknutí na dopravu, validní vstupy, zamknutí
formuláře při požadavku a zachování hodnot po síťové chybě; bez overflow
a pageerror. První after CS320 skončil po reloadu bez dostupného formuláře
a zůstává uložený jako FAIL. Samostatný recheck320/768/1024 prošel 3/3;
společně s původními třemi úspěchy pokrývá šest unikátních kombinací.
Příčina jednorázově nedostupného formuláře není prokázaná.

Quote POST byl pro pending/recovery zachycen před lokálním FE a backendem
a následně přerušen. Tato kontrola neposlala skutečnou objednávku, registraci
ani e-mail a neprokazuje úspěšný quote/place. Native owner kontrakty, data
a přístupová oprávnění zůstaly zachované. Reviewer otevřel reprezentativní
PNG všech pěti CS šířek a EN390: omezené source/visual GO pro tyto opravy;
nikoli všechny stavy každé šířky nebo celková pixelová shoda checkoutu.
Známé rozdíly podporované dostupností dat, schváleně vynechaná adresní pole
a mezery knihovního cenového souhrnu zůstávají samostatně zaznamenané.

Závěrečná kontrola tohoto checkout checkpointu: N1 801/801 testů v 76
souborech, typy, lint, formát a 447 kanonických tokenů PASS. TraceDecay
package diagnostika bez chyb. Globální i18n nadále obsahuje stejných 28
diagnostik ve stejných souborech mimo N1; porovnáno s předchozím logem,
bez potlačení. Nejde o celorepozitářový zelený výsledek.

## 9. 11. 2026 — mobilní zavírání navigace podle Figmy

Čerstvé Figma podklady 59:1595, 418:2412/2620 potvrzují X v headeru při otevření
a nepřítomnost druhého close uvnitř draweru. Desktop 418:2368 byl zároveň
načtený jako reference šesti sloupců; tato změna desktop neupravuje.

Actual browser RED před opravou: CS 320/390 a EN 390 — všechny tři případy
ukázaly stále menu glyph a původní název; druhý klik na trigger selhal kvůli
modal inert headeru. Regrese je interakční, proto se neřeší SSR mockováním
useState ani testem kopírujícím nový ternární výraz.

Po opravě prošly CS 390 a EN 390. První cold CS 320 pokus skončil na timeoutu
odpovědi vzdáleného account endpointu ještě před UI kontrolami a zůstává
zaznamenaný jako neúspěšná precondition. Samostatný CS 320 recheck čeká na
skutečné zahájení klientského account requestu a dva animační framy, nikoli
na jeho vzdálenou odpověď; proběhl bez mockování a prošel.

Tyto tři kombinace dokládají header X, opětovné zavření triggerem, Escape,
návrat focusu na trigger, body scroll lock, outside close bez navigace na
podklad, přepnutí z menu do košíku a absenci overflow i page errors. Všechny
tři after screenshoty a Figma PNG otevřel také nezávislý reviewer; v této
úpravě nenašel blokující připomínku. Přesný první focus target není doložen.

Návrh používá veřejné Button props, podporované Dialog flags a nativní Zag
trigger anatomii. Nezavádí component CSS override ani nové tokeny. Kvůli
nedostupnému živému katalogu tato kontrola neschvaluje naplněný strom ani
celý storefront jako vizuálně dokončený. Při testu nevznikly business zápisy.

Automatická sada: 801 testů v 76 souborech PASS, bez skipů. Typy, lint,
formát a kontrola 447 kanonických tokenů PASS.

## 9. 11. — mobilní menu se živým katalogem a mapovaným Link

Po novém Stage nasazení proběhl nový actual browser průchod se skutečnými
kategoriemi, bez mocků. CS 320/390 a EN 390: všechny tři případy PASS. První
focus je uvnitř dialogu na odkazu, skutečná větev se rozbalí a sbalí, funguje
header toggle, Escape/return focus, body scroll lock, outside close bez
prokliku a přepnutí do košíku. Bez overflow a page errors; všechny obchodní
POSTy byly v tomto průchodu blokované a žádný nebyl vyvolán.

Čerstvý high-fidelity Figma context 59:1595 a 418:2484 předepisuje samostatné
Link atomy. Původní LinkButton přidával těmto místům tlačítkový weight 600;
po opravě má Novinky v reálném browseru weight 400 bez CSS override. Po
změně znovu prošly stejné tři kombinace a byly pořízené viewport screenshoty
se skutečnými daty. Header a Link mapování nejsou vydávané za celkové
vizuální schválení všech Figma stránek; známé typografické a datové rozdíly
zůstávají oddělené.

## 9. 11. — skutečný košík po obnově Stage

Nový browser průchod CS 390 a 1440 px prošel přidáním skutečné varianty
Northwave LXL, globálním toastem, badge 1, otevřením minikošíku, navigací do
košíku, změnou na dva kusy a odebráním do prázdného stavu bez badge.
Native quote v obou případech vrací HTTP 200 / VALID pro 1 i 2 kusy;
součet dvou kusů je 1 758 Kč. Přidání nevynucuje otevření minikošíku ani
navigaci. Žádné technické popisky o neověřené uložené ceně se nezobrazují.
Bez page errors, bez mocků, vložení storage, auth pokusů či objednávek.
Povoleny pouze skutečné quote POSTy; žádný jiný zápis nebyl vyvolán.

První úplný pokus zastavil chybný testovací selector Odebrat: kit správně
přidává do aria-label název produktu. Po opravě helperu prošly oba viewporty
včetně odebrání. Tato oprava nevyžadovala změnu aplikace. Důkaz je lokální
`n1-cart-live-ui-complete-20261109/result.json` a osm runtime screenshotů.
Jde o funkční kontrolu těchto stavů, nikoli nové vizuální schválení celého
košíku či pozitivní GUI průchod odesláním objednávky.

## 9. 11. — závěrečný kontrolovaný rozsah navigace

Mobil CS320/390 a EN390: 3/3 PASS pro samostatný Link, oddělovač pod celým
kořenovým blokem, nativní ArrowDown/Up, disclosure, Escape/return focus,
header toggle, scroll lock, outside close a přepnutí na košík. Samostatné
výchozí screenshoty bez keyboard focusu potvrzují šedé oddělovače; černé
hrany předchozího snímku byly nativní focus outline, který zůstává funkční.

Desktop CS768/1440 PASS, CS1024 samostatný PASS po čekání na skutečné
načtení lazy ilustrací. Měřeno šest tracků, gap8, padding18 a border1,
pět auditovaných obrázků, plain Link weight400; hover, outside close, vstup
klávesnicí, Escape/return focus a zavření při mobilním resize. Čerstvá
Figma418:2368 má pět položek; skutečný owner strom deset, proto dva řádky.
Počty a názvy zůstávají skutečná data. Reviewer otevřel všechny tři šířky.

EN1024: kliknutí na obrázek i text naviguje a zavírá popup, bez page errors
a zápisů. První cold Next navigace překročila 30s test timeout (30,2s
kompilace); samostatný dokončený průchod prošel s odpovídajícím čekáním.
Původní neúplný report nebyl přepsán na PASS. Nezávislé review potvrdilo
konkrétní upravenou skladbu; neprohlašuje celkovou shodu všech Figma stránek
ani otestování owner-image fallbacku jen na základě auditovaných ilustrací.

Aktuální plná N1 sada: 801 testů v 76 souborech PASS bez skipů.

## 10. 11. — potvrzení objednávky a zachování nového košíku

Cílené nativní HTTP/Deferred regrese ověřují jeden status read, soft failure
po PLACED, pozdní odpovědi po vypršení caller fence, odmítnutí jiné objednávky
nebo scope a explicitní read retry. SSR ověřuje potvrzené texty a fallback.
Tyto testy nejsou vydávané za React lifecycle E2E. Source review odstranilo
dvě skutečná rizika: pending progress po změně session a druhé clearSubmitted
při ručním doplnění již potvrzené objednávky.

Skutečný GUI nákup OBJ-2026-0006: quote200/VALID, právě jeden place200/PLACED,
998 Kč včetně České pošty119 Kč. Samostatné čtení uložené objednávky
vrátilo200/REPLAYED se shodným kontaktem TEST, variantou, cenou a dopravou.
Původní cross-tab část nedokončila testovací přípravu klienta; její neúplný
report zůstává zachovaný. Bez nového nákupu následně prošlo sdílení přidání
i odebrání mezi dvěma hydratovanými panely.

Samostatný regresní GUI případ OBJ-2026-0007 potvrdil nativní vytvoření,
řízené přerušení prvního čtení, zachovaný úspěch, nový stejný košík ve druhém
panelu, ruční status200 a zachování nového košíku po readbacku. Bez runtime
mocků, vložení storage nebo placement retry. Závěrečný screenshot selhal:
completed=false v celém helperu je zachované, následný screenshot a lokální
cleanup se neprohlašují za provedené. Funkční assertions/readback jsou
samostatně doložené; nejde o celkové vizuální schválení potvrzení.

Po převzetí94 upstream commitů na ffe48b6f2 a standardní instalaci UI kitu
0.59.0 znovu prošlo809 testů v76souborech, typy, standardní N1 lint, formát
a kontrola447 kanonických tokenů. Živé GUI průchody výše předcházely této
aktualizaci knihovny; jejich přesná verze není zaměňovaná za nový browser
průchod na0.59. Všechny nové aplikační a testové změny tohoto celku jsou N1.
