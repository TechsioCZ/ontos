# N1 — úplný inventář aktuální Figmy

## Aktuální stav k 8. 11. 2026

Struktura byla znovu načtená ze všech pěti Figma stránek: **87 top-level rámců**
(3 referenční, 6 katalogových, 10 formulářových, 26 účet/obsah, 42 stavů/navigace).
Počet rámců není počet aplikovaných routes ani počet vizuálních schválení.
Níže uvedené původní tabulky „při zahájení“ zůstávají historickým záznamem;
aktuální zdrojový rozsah shrnuje tato tabulka a datované záznamy ve VALIDATION.md.

| Celek                        | Aktuální implementace                      | Otevřené                                                                             |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Homepage                     | Implementováno, obsah částečný             | Kurace katalogu a doporučeného obsahu, úplná vizuální shoda.                         |
| Kategorie                    | Implementováno                             | Dokončit kategoriální kuraci a celkovou vizuální kontrolu.                           |
| Produkt                      | Implementováno, schopnosti částečné        | ETA, skutečné související vztahy, redakční ořez, aktivní wishlist/watch.             |
| Tabulka velikostí            | Pouze nedostupný stav                      | Skutečná brand data a nativní zdroj tabulky.                                         |
| Kontakt / produktový dotaz   | Implementováno                             | Celkový živý a vizuální průchod není touto mapou znovu potvrzený.                    |
| Přihlášení                   | Implementováno                             | Pozitivní živý Portal účet chybí; MFA nemá vlastní Figma rámec.                      |
| Registrace                   | Implementováno; živě neověřeno             | Registrace/e-mail nejsou pozitivně ověřené, potřebná BE diagnostika.                 |
| Checkout / potvrzení vstupů  | Implementováno                             | Živý přihlášený nákup; vynechání firmy/line2/kraje schválené.                        |
| PPL výdejní místo            | Není napojeno v N1                         | Samostatný výběr/widget a zápis vybraného místa; carrier shipping method není totéž. |
| Novinky                      | Pouze nedostupný obsah                     | Skutečný redakční zdroj a naplněné obrazovky.                                        |
| CMS šablona                  | Chybí napojení / vlastní route             | Owner obsah a veřejné směrování konkrétních článků.                                  |
| Právní dokumenty             | Statická dodaná česká kopie implementovaná | system-ui vs Figma Inter mění zalamování; nejde o CMS ani právní validaci.           |
| Doprava / platby             | Čtení skutečných možností implementováno   | Online platební brána není doložená; nevydávat fixture za podporovanou platbu.       |
| Uložené adresy               | Read + výslovná kopie do checkoutu         | Adresní CRUD; popup positioning v knihovně čeká konkrétní výjimku.                   |
| Přidat/upravit/smazat adresu | Neimplementováno                           | Nativní zápis a teprve potom formuláře; žádné FE náhradní úložiště.                  |
| Vlastní profil / účet        | Read + CAS update implementováno           | Živý ověřený zákazník; agregované statistiky nejsou náhradně dopočítané.             |
| Vlastní objednávky           | Seznam a stavy implementované              | Živé ověření vlastnictví s reálným přihlášeným účtem.                                |
| Detail vlastní objednávky    | Implementováno                             | Živý přihlášený zákazník a reálný vlastní detail.                                    |
| Potvrzení objednávky         | Implementováno v checkout stavu            | Nový ověřený backend deploy a aktuální živý průchod.                                 |
| Minikošík                    | Implementováno                             | Aktuální native quote musí být dostupné; plná vizuální shoda neuzavřená.             |
| Navigace                     | Implementováno                             | Skutečné počty a pořadí kategorií se nepřepisují podle fixture.                      |
| Množství / balení            | Implementováno                             | Respektovat balení a veřejné kit varianty, žádné vlastní číslicové ovladače.         |
| Hledání / suggestions        | Implementováno                             | Značky a další filtry pouze se skutečným kontraktem; známé kit metriky přiznané.     |

MFA completion (TOTP/OTP) a obnova hesla používají stávající Portal kontrakty;
samostatné MFA obrazovky v načteném inventáři nejsou. To neznamená vizuální
schválení ostatních auth rámců. Dílčí GO z 8. 11. patří konkrétním PDP stavům,
desktop menu, zavřenému výběru adres, MFA kompozici a kompozici právních článků.
Popup uložených adres má naopak doložený problém šířky UI kitu. Živý pozitivní
zákaznický Portal průchod a plošná pixelová shoda storefrontu zůstávají otevřené.
Právní články jsou dodaná statická česká kopie, ne chybějící route ani CMS odpověď.

Načteno 2026-11-02, Figma session `a9159725-64c3-4266-80d6-c4c922c33291`.
Zdroj: [N1 Storefront](https://www.figma.com/design/gIHtMwCCl2OXhMAW9s9LIn/N1-Storefront).
Inventář top-level rámců není tvrzení vizuální parity. Každý návrhový fixture je pouze reference UI;
produkty, ceny, objednávka #48, adresy ani doručení se nesmějí přenést do runtime jako data.

Aktualizace4.11.: tabulky „při zahájení“ níže jsou historický inventář, nikoli
aktuální seznam chybějící implementace. Portal login/registrace, mini okna, košík,
guest checkout/obnova i vlastní profil a objednávky jsou již implementované.
Pozitivní živý Portal účet a plná vizuální shoda všech stavů zatím ověřené nejsou.
Strom C9 má desktop/mobil vizuální důkaz; C10 navazuje hlavičkou, katalogovým
nadpisem/počtem a produktovým shipping linkem. Přesné současné hranice a výsledky
jsou v VALIDATION.md a COMPONENT-MAPPING.md. CMS/adresy a další chybějící owner
schopnosti zůstávají oddělené od existujících UI kompozic.

Aktuální navazující převod: kontakty `43:1162/43:1595` nyní mají celou veřejnou
adresní kompozici a FormInput/FormTextarea podle hlavních rámců `369:2578/369:2758`.
Formulář volá Action `work.tasks.submit-storefront-inquiry`; success vyžaduje potvrzený taskRef.
Validace, pending, forbidden, unavailable/retry a unconfirmed nejsou návrhové fixtures.
Skutečný N1 zápis nebyl vyvolán; runtime oprávnění tím není ověřené.
Hero je bez nadbytečných Control ploch; Novinky mají skutečný navigační cíl i bez
katalogových dat. Přesné vizuální rozdíly canonical vs instance nejsou vydávané za PASS.

## Hlavní obrazovky

Aktuální přírůstek po inventáři: skutečné serverové stránkování kategorie/hledání,
strom a breadcrumb z owner kategorií, podkategorie a počet, oddělené mobilní karty;
plná detailová projekce, Gallery, URL výběr aktivní varianty, PriceBlock,
AvailabilityStatus, QuantityField (disabled), Tabs a headerless DataTable podle
Code Connect. Přibyly framework loading a retry/unavailable stavy. Původní tabulka
níže zůstává výchozím stavem pro sledování rozsahu. Naplněné stavy čekají na skutečné
N1 prostředí; účet, košík/checkout a obsahové integrace nejsou touto vlnou dokončené.

| N1  | Obrazovka                      | Stav při zahájení této vlny                   | Další práce                                                                      |
| --- | ------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------- |
| 01  | Home                           | Částečně: shell, hero, benefity, promo, karty | Naplněná data, skutečné promo cíle, vizuální shoda                               |
| 02  | Kategorie                      | Základní výpis                                | Strom, breadcrumb, podkategorie, počet, stránkování, loading/empty/error         |
| 03  | Produkt                        | Základní detail                               | Galerie, skutečné varianty, parametry, tabs, související produkty, loading/error |
| 04  | Kontakty                       | Základní statický kontakt                     | Celá kompozice a skutečné inquiry napojení                                       |
| 05  | Novinky                        | Pouze nedostupný obsah                        | Owner obsah a kompozice; promo fixture není záznam                               |
| 06  | Obchodní podmínky              | Pouze nedostupný obsah                        | Skutečný N1 právní obsah                                                         |
| 07  | Ochrana osobních údajů         | Pouze nedostupný obsah                        | Skutečný N1 právní obsah                                                         |
| 08  | Doprava                        | Pouze nedostupný obsah                        | Skutečné market shipping options                                                 |
| 09  | Platby                         | Pouze nedostupný obsah                        | Skutečné market payment options                                                  |
| 10  | CMS template                   | Chybí                                         | Potvrzený owner záznam a média                                                   |
| 11  | Potvrzení objednávky           | Guest nativní PLACED/REPLAYED + obnova        | Skutečné číslo/stav; bez falešného e-mailu nebo platby                           |
| 12  | Pokladna/košík                 | Guest quote, doprava a vytvoření objednávky   | Schváleno vynechat firmu/line2/kraj; zákaznické adresy chybí                     |
| 13  | Přihlášení                     | Chybí                                         | Portal auth, validace, pending, unavailable                                      |
| 14  | Registrace                     | Chybí                                         | Portal registrace, validace a chyby                                              |
| 15  | Detail objednávky              | Chybí                                         | Autorizovaný owner read                                                          |
| 16  | Účet: profil/adresy/objednávky | Chybí                                         | Portal identity a skutečné reads/actions                                         |

## Všechny rámce a samostatné stavy

### 01 · Ověření N1 (`0:1`)

| Node     | Návrh                              | Stav při zahájení                           |
| -------- | ---------------------------------- | ------------------------------------------- |
| `9:14`   | N1 · Ověření komponent             | Referenční kontrolní sestava, nikoliv route |
| `20:339` | N1 · Ověření komponent — mobil 390 | Referenční kontrolní sestava, nikoliv route |
| `25:591` | N1 · Košík 320 px                  | Referenční kontrolní sestava, nikoliv route |

### 02 · Katalog (`31:635`)

| Node     | Návrh                       | Stav při zahájení                          |
| -------- | --------------------------- | ------------------------------------------ |
| `31:636` | N1-01 · Home · desktop      | Částečně převedeno                         |
| `31:637` | N1-01 · Home · mobil        | Částečně převedeno                         |
| `31:638` | N1-02 · Kategorie · desktop | Základ; přesná kompozice/stavy nedokončené |
| `31:639` | N1-02 · Kategorie · mobil   | Základ; přesná kompozice/stavy nedokončené |
| `31:640` | N1-03 · Produkt · desktop   | Základ; přesná kompozice/stavy nedokončené |
| `31:641` | N1-03 · Produkt · mobil     | Základ; přesná kompozice/stavy nedokončené |

### 03 · Formuláře a pokladna (`42:635`)

| Node       | Návrh                                                 | Stav při zahájení                                         |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `42:636`   | N1-13 · Přihlášení · desktop                          | Chybí                                                     |
| `42:1088`  | N1-13 · Přihlášení · mobil                            | Chybí                                                     |
| `43:816`   | N1-14 · Registrace · desktop                          | Chybí                                                     |
| `43:1026`  | N1-14 · Registrace · mobil                            | Chybí                                                     |
| `43:1162`  | N1-04 · Kontakty · desktop                            | Základ; přesná kompozice/stavy nedokončené                |
| `43:1595`  | N1-04 · Kontakty · mobil                              | Základ; přesná kompozice/stavy nedokončené                |
| `44:1226`  | N1-12 · Pokladna · guest fixture · desktop            | C7 guest implementace; aktuální ověření viz VALIDATION.md |
| `44:2285`  | N1-12 · Pokladna · guest fixture · mobil              | C7 guest implementace; aktuální ověření viz VALIDATION.md |
| `323:1465` | N1-12 · Pokladna · dokončování · fixture · mobil      | Chybí                                                     |
| `323:1813` | N1-12 · Pokladna · validace po blur · fixture · mobil | Chybí                                                     |

### 04 · Účet a obsah (`50:635`)

| Node       | Návrh                                                        | Stav při zahájení                             |
| ---------- | ------------------------------------------------------------ | --------------------------------------------- |
| `50:636`   | N1-05 · Novinky · desktop                                    | Obsah/kompozice nedokončené                   |
| `50:790`   | N1-05 · Novinky · mobil                                      | Obsah/kompozice nedokončené                   |
| `50:867`   | N1-06 · Obchodní podmínky · desktop                          | Obsah/kompozice nedokončené                   |
| `50:1032`  | N1-06 · Obchodní podmínky · mobil                            | Obsah/kompozice nedokončené                   |
| `50:1126`  | N1-07 · Zásady ochrany osobních údajů · desktop              | Obsah/kompozice nedokončené                   |
| `50:1288`  | N1-07 · Zásady ochrany osobních údajů · mobil                | Obsah/kompozice nedokončené                   |
| `51:1020`  | N1-08 · Způsoby dopravy · desktop                            | Obsah/kompozice nedokončené                   |
| `51:1174`  | N1-08 · Způsoby dopravy · mobil                              | Obsah/kompozice nedokončené                   |
| `51:1255`  | N1-09 · Způsoby platby · desktop                             | Obsah/kompozice nedokončené                   |
| `51:1404`  | N1-09 · Způsoby platby · mobil                               | Obsah/kompozice nedokončené                   |
| `51:1482`  | N1-10 · CMS template · promo fixture · desktop               | Chybí                                         |
| `51:1639`  | N1-10 · CMS template · promo fixture · mobil                 | Chybí                                         |
| `54:1417`  | N1-16 · Účet · Osobní údaje · fixture · desktop              | Chybí                                         |
| `54:1629`  | N1-16 · Účet · Osobní údaje · fixture · mobil                | Chybí                                         |
| `54:1759`  | N1-16 · Účet · Adresy · fixture · desktop                    | Chybí                                         |
| `54:1946`  | N1-16 · Účet · Adresy · fixture · mobil                      | Chybí                                         |
| `54:2060`  | N1-16 · Účet · Objednávky · test objednávka #48 · desktop    | Chybí                                         |
| `54:2241`  | N1-16 · Účet · Objednávky · test objednávka #48 · mobil      | Chybí                                         |
| `55:1948`  | N1-11 · Potvrzení objednávky · test objednávka #48 · desktop | C7 skutečný guest výsledek a read-only obnova |
| `55:2309`  | N1-11 · Potvrzení objednávky · test objednávka #48 · mobil   | C7 skutečný guest výsledek a read-only obnova |
| `55:2509`  | N1-15 · Detail objednávky · test objednávka #48 · desktop    | Chybí                                         |
| `55:2784`  | N1-15 · Detail objednávky · test objednávka #48 · mobil      | Chybí                                         |
| `338:2102` | N1 · Adresy · Přidat adresu · anonymous fixture              | Chybí                                         |
| `338:2251` | N1 · Adresy · Upravit adresu · anonymous fixture             | Chybí                                         |
| `338:2380` | N1 · Profil · Ukládání · anonymous fixture                   | Chybí                                         |
| `338:4541` | N1 · Adresy · Smazat adresu · alertdialog fixture            | Chybí                                         |

### 05 · Stavy a navigace (`56:635`)

| Node       | Návrh                                                         | Stav při zahájení                                |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `56:636`   | N1-12 · Pokladna · prázdná · desktop                          | Chybí                                            |
| `56:800`   | N1-12 · Pokladna · prázdná · mobil                            | Chybí                                            |
| `56:883`   | N1-13 · Chyby formuláře · mobil                               | Chybí                                            |
| `56:920`   | N1-13 · Přihlašování · mobil                                  | Chybí                                            |
| `56:946`   | N1-13 · Chyba serveru · mobil                                 | Chybí                                            |
| `56:978`   | N1-14 · Registrace · více chyb · mobil                        | Chybí                                            |
| `57:897`   | N1-02 · Prázdná kategorie · mobil                             | Základ; přesná kompozice/stavy nedokončené       |
| `57:906`   | N1-02 · Načítání kategorie · mobil                            | Základ; přesná kompozice/stavy nedokončené       |
| `57:2904`  | N1-02 · Chyba kategorie · mobil                               | Základ; přesná kompozice/stavy nedokončené       |
| `57:2916`  | N1-03 · Vyberte variantu · mobil                              | Základ; přesná kompozice/stavy nedokončené       |
| `57:2965`  | N1-03 · Vyprodáno · mobil                                     | Základ; přesná kompozice/stavy nedokončené       |
| `57:3009`  | N1-03 · Načítání produktu · mobil                             | Základ; přesná kompozice/stavy nedokončené       |
| `57:3028`  | N1-03 · Chyba produktu · mobil                                | Základ; přesná kompozice/stavy nedokončené       |
| `57:3038`  | N1-12 · Doprava a platba · Nezvoleno · mobil                  | Chybí                                            |
| `57:3063`  | N1-12 · Doprava a platba · Přepočítáváme · mobil              | Chybí                                            |
| `57:3088`  | N1-12 · Doprava a platba · Žádné možnosti · mobil             | Chybí                                            |
| `59:1042`  | N1 · Mini košík · prázdný · Popover                           | Chybí                                            |
| `59:1074`  | N1 · Mini košík · naplněný · Popover                          | Chybí                                            |
| `59:1330`  | N1 · Mini košík · aktualizace · Popover                       | Chybí                                            |
| `59:1595`  | N1 · Mobilní navigace · Pánské rozbalené · source composition | Základní toggle; skutečný strom čeká na data     |
| `59:1668`  | N1-12 · PPL · externí widget shell · mobil                    | Chybí                                            |
| `59:1709`  | N1 · Přihlášení · desktop Popover · source composition        | Chybí                                            |
| `59:1743`  | N1 · Desktop megamenu · Pánské · source composition           | Chybí                                            |
| `61:1343`  | N1-16 · Prázdné objednávky · mobil                            | Chybí                                            |
| `61:1352`  | N1-16 · Chyba objednávek · mobil                              | Chybí                                            |
| `61:1364`  | N1-16 · Prázdné adresy · mobil                                | Chybí                                            |
| `61:1374`  | N1-16 · Načítání účtu · mobil                                 | Chybí                                            |
| `61:1377`  | N1 · NumericInput · Hodnota 4 · ověřený výřez                 | Chybí                                            |
| `61:1419`  | N1 · NumericInput · Přidávání · source fixture                | Chybí                                            |
| `61:1461`  | N1-12 · PPL · Vybrané výdejní místo · fixture                 | Chybí                                            |
| `61:1473`  | N1-12 · PPL · Chyba načítání míst · fixture                   | Chybí                                            |
| `61:1483`  | N1-05 · Novinky · naplněná promo fixture · desktop            | Obsah/kompozice nedokončené                      |
| `61:1635`  | N1-05 · Novinky · naplněná promo fixture · mobil              | Obsah/kompozice nedokončené                      |
| `61:1716`  | N1-03 · Tabulka velikostí · chybějící brand data · mobil      | Základ; přesná kompozice/stavy nedokončené       |
| `63:1548`  | N1 · Hledání · Výsledky a focus · desktop                     | Zapojeno; naplněné výsledky neověřené bez N1 dat |
| `63:1566`  | N1 · Hledání · Načítání · desktop                             | Zapojeno; naplněné výsledky neověřené bez N1 dat |
| `63:1583`  | N1 · Hledání · Prázdné výsledky · desktop                     | Zapojeno; naplněné výsledky neověřené bez N1 dat |
| `63:1591`  | N1 · Hledání · Výpadek API · skutečný FE fallback · desktop   | Zapojeno; naplněné výsledky neověřené bez N1 dat |
| `333:6805` | N1-14 · Registruji · fixture · mobil                          | Chybí                                            |
| `333:6888` | N1-14 · Platné údaje · fixture · mobil                        | Chybí                                            |
| `333:6971` | N1-14 · Chyba registrace · fixture · mobil                    | Chybí                                            |
| `438:2029` | SearchSuggestions · N1                                        | Zapojeno; naplněné výsledky neověřené bez N1 dat |

## Pořadí a hranice této vlny

1. Aktuální high-fidelity Figma kategorie a produktu, přesné npm API/tokens.
2. Skutečná serverová paginace a kategorie, rozšířená projekce plného produktu.
3. Kompozice detailu a katalogu; disabled nákup dokud není skutečný cart/quote kontrakt zapojený.
4. Nezávislé kontraktové a vizuální review. Úspěšné testy nejsou důkaz naplněné vizuální parity.
5. Zbývající auth/account/checkout/CMS se řeší dalšími ucelenými přírůstky; bez změn jiných aplikací.
