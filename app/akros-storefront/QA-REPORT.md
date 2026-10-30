# Kontrola integrace Akros UI — 26. 10. 2026

Nejnovější cílené porovnání původních vizuálních připomínek s `feat/akros`
je v [VISUAL-PARITY-2026-10-27.md](VISUAL-PARITY-2026-10-27.md).

Aktuální následná kontrola je v [UI-REVIEW-2026-10-27.md](UI-REVIEW-2026-10-27.md).
Obsahuje nové vizuální opravy a aktuální neúspěšné testy; níže je zachován výsledek
historického průchodu z 26. 10., nikoli nové schválení integrace.

Větev: demo/sales-crm-updated, základ demo/sales-crm na ad789552.
Hlavní funkční průchody byly ověřeny proti skutečnému lokálnímu OntOS.
**Nejde o bezvýhradné schválení merge:** zbývají technické gate a omezení kontraktů níže.
Nic nebylo commitnuto, pushnuto ani deploynuto.

## Výsledky

| Kontrola                            | Výsledek                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit a component testy              | 498 / 498, všech 69 souborů. Po opravách navíc 14 / 14 cílených regresí včetně tiskového listu. Tyto počty nejsou unikátní testy k sečtení.  |
| Finální produkční build storefrontu | Prošla kompilace, TypeScript a generování stránek.                                                                                           |
| Formát a lint opravených souborů    | Prošlo; lint ponechává existující upozornění na netypované mocky.                                                                            |
| Živá registrace                     | Nový syntetický účet, skutečný ověřovací e-mail do lokálního Mailpitu, potvrzení, přihlášení a nativní admission.                            |
| Profil                              | Nativní uložení telefonu a načtení změny po reloadu.                                                                                         |
| Katalog                             | Homepage, kategorie, živé hledání/návrhy, 47 variant, automatický číselný filtr a reset, detail varianty.                                    |
| Carousel                            | Obrázky/odkazy, indikátory, klávesnice, šipky, poslední/první banner a skutečné tažení.                                                      |
| Oblíbené                            | Dvě konkrétní varianty, uchování po reloadu, otevření správného výběru a odebrání. Jde o výslovně lokální preference prohlížeče.             |
| Sdílení                             | Dvě varianty, výsledný odkaz, potvrzení kopírování a otevření právě těchto variant. Testována záložní větev pro prohlížeč bez Web Share API. |
| Mobilní menu a FAQ                  | Otevření, Escape a návrat fokusu; hledání FAQ, prázdný výsledek, reset a rozbalení odpovědi.                                                 |
| Košík                               | Autoritativní quote, množství, pravidla balení/skladu, reload, odebrání/obnovení položky, vytvoření a odstranění dalšího košíku.             |
| Checkout                            | Nativní doprava/cena, adresa, skutečný návrh s doplněním města/PSČ, shrnutí, odeslání a potvrzení po reloadu. Online platba se neprovádí.    |
| Objednávky                          | Dvě skutečně uložené objednávky, následné čtení vlastníka, historie, detail a historie stavu.                                                |
| Objednat znovu                      | Úspěšné vložení s novým quote i vynechání položky bez zásoby na celé balení. Reorder sám další objednávku neodesílá.                         |
| Dotaz a reklamace                   | Dva skutečné Work Tasks požadavky, ID i obsah potvrzeny následným autorizovaným čtením vlastníka. Podnět není automaticky reklamační případ. |
| Odhlášení a přístup                 | Relace ukončena, anonymní čtení/reorder vrací 401, soukromý detail přesměruje na přihlášení; nesprávné heslo vrací 401 bez nové relace.      |
| Tisk                                | Produktový list s nativními daty, skrytí navigace a skutečné PDF přibližně 109 kB.                                                           |

Živé testy nepřepisovaly HTTP odpovědi, nevkládaly objednávky přímým SQL a nenahrazovaly autentizaci mockem. Používaly izolovanou lokální DB a syntetické kontakty; SMTP transporty směřovaly pouze do lokálního Mailpitu.

## Skutečné zápisy

| Objednávka    | Varianta                   | Množství | Cena za kus | Doprava | Celkem s DPH |
| ------------- | -------------------------- | -------- | ----------- | ------- | ------------ |
| OBJ-2026-0007 | item-6692 / 10799700035016 | 200      | 0,97 Kč     | 129 Kč  | 323 Kč       |
| OBJ-2026-0008 | item-5878                  | 200      | 2,35 Kč     | 129 Kč  | 599 Kč       |

Obě odpovědi měly PLACED a HTTP 200. Řádky, varianty, množství, dodací adresa, stav NEW a součty byly porovnány s následným nativním čtením. První varianta měla před nákupem 360 kusů; po odečtení zůstalo 160, takže reorder správně nepřidá další balení po 200. Druhá měla 929 kusů a umožnila úspěšný reorder 200 kusů za aktuální cenu.

Dotaz na varianty: 7c1d1b34-60b4-4581-ac92-2ec629e1df59.
Reklamační podnět: 4f26230b-8fd8-4d4a-b9eb-274e140a290e.
Při nejistém výsledku se požadavky automaticky znovu neposílaly.

## Responzivita

Celkem **263 živých měření rozložení**:

- 119: 17 veřejných pohledů × 320, 390, 768, 1024, 1280, 1440 a 1920 px.
- 56: profil, historie, detail, stav, košík po reorderu, doprava, adresa a shrnutí na stejných sedmi šířkách.
- 88: čtyři produktové tabulky na 22 šířkách 320–1920 px včetně hran breakpointů. Bez přetékání a kolizí tabulek.

V dokončených průchodech nebyly zaznamenány chyby JavaScriptu přes pageerror. Proběhla vizuální kontrola reprezentativních screenshotů. Testoval Chrome; nejde o potvrzení Safari, Firefoxu nebo systémového sdílecího dialogu. Starších 104 izolovaných fixture layoutů se do živého počtu nezapočítává.

## Opravy nalezené při kontrole

1. Detail objednávky na 320 px přetékal o 26 px kvůli dlouhému názvu varianty. Grid nyní dovolí zúžení karty a text se zalomí. Ověřeno novým buildem a opakovaným měřením přihlášených obrazovek.
2. Tlačítku Tisk chyběl produktový list očekávaný přenesenými styly. List byl obnoven s nativním obrázkem, SKU, popisem a parametry. U kontejneru variant se netiskne zavádějící společná cena. Ověřeno PDF a regresí obsahu.

Nativní backend, src/ontos, cart/checkout providery a checkout layout mají nulový obsahový diff proti základu. Autentizační ani skladová pravidla se neměnila.

## Zjištění a zbývající omezení

- **Smart Suggest:** Bakalovo vrací nulu; Bakalovo nábřeží Brno osm správných adres; Boženy Němcové Tábor jedenáct adres z jiných měst, žádnou z Tábora. Přímý poskytovatel vrací totéž jako proxy. Jde o pokrytí/relevanci služby. Její repozitář nebyl měněn; ruční vstup funguje.
- **Limit relací:** starší testovací účet dosáhl session_limit_reached, protože předchozí testy neukončovaly relace odhlášením. Limit zůstal zachován; nový účet používal opakovaně jednu relaci a byl na konci odhlášen. UI pro tento stav používá jen obecnou chybu, což je kandidát na lepší hlášku.
- **Objednávkový e-mail:** receipt eviduje ORDER_CREATED / SKIPPED, protože doména .test patří do nativního seznamu nedoručitelných domén. To odpovídá politice; skutečné SMTP doručení objednávky není potvrzené. Ověřovací e-mail registrace do Mailpitu dorazil.
- **Kontrakty:** nativní účet nemá zápis adres ani změnu hesla. Chybí automatické hlídání zásob a normalizovaná hmotnost varianty za prodejní jednotku. Tyto funkce nebyly nahrazeny simulací; součet hmotnosti košíku tato větev neposkytuje.
- **Newsletter:** lokálně chybí nativní marketingové purpose/notice reference. Formulář přiznává nedostupnost; skutečný zápis souhlasu není ověřený.
- **Vizuální drobnost:** na úzkém mobilu zůstává nehezké zalomení posledního písmene titulku kroku Shrnutí objednávky. Nejde o přetékání ani blokaci nákupu.
- **Technické gate:** storefront build prošel. Celý workspace pnpm check končí dvěma dříve zaznamenanými Windows ESM chybami lint-rule testů (ERR_UNSUPPORTED_ESM_URL_SCHEME). Check:local navíc neumí na tomto Windows nalézt podřízené pnpm; celý gate byl proto spuštěn přímo. Pravidla nebyla vypnuta. Commerce produkční declaration build/typecheck zůstává nedokončený z předchozích kontrol; běží standardní dev server. To jsou zbývající merge gate.
- Generovaný společný worker host nadále hlásí chybějící descriptory tří vlastníků mimo lokální pětici. Core/Commerce admission fungovala; nejde o čistý celý host.

## Prostředí a důkazy

Frontend: http://localhost:3070, Shell: http://localhost:3020.
Po zavření uživatelského Chrome se podařilo stabilně provozovat testovaný stack. Watchdog ponechává rezervy 1 GiB fyzické RAM a 8 GiB commit prostoru. Uživatelské aplikace nebyly agentem ukončovány; databáze nebyla resetována.

Logy, JSON výsledky, screenshoty a PDF jsou v ignorovaném test-results/local-runtime/ a test-results/ui-integration/. Nové QA výstupy neexportují autentizační cookies ani ověřovací tokeny. Izolovaný profil prohlížeče není určen ke commitu; zákazník je na konci odhlášen.

Přehled integrace a starších gate: [UI-INTEGRATION.md](UI-INTEGRATION.md).
