# Opravy převodu UI AKROS — 30. 10. 2026

Navazuje na [audit z 29. 10.](FE-TRANSFER-AUDIT-2026-10-29.md). Tato změna řeší potvrzené FE nedodělky v `demo/sales-crm-updated`. Nemění kontrakty backendu ani nevkládá demo data do aplikace.

## Provedené opravy

| Bod auditu               | Výsledek                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rozměry filtrů kategorií | Vstupy a selecty používají scoped tokeny AKROS: výška 60 px, stejný rámeček, písmo a šipka jako schválené formuláře. Zachovány URL parametry, ovládání klávesnicí a odeslání filtru.                             |
| Text nabídkové ceny „od“ | Odstraněna zmínka o nejnižší variantové ceně „od“. Text nyní odkazuje na cenu konkrétní varianty v detailu. Popisky minimální a maximální hranice cenového filtru zůstávají srozumitelné.                        |
| Telefon v účtu           | `PhoneInput` s vlajkou a předvolbou odpovídá referenci. Profil dostává číslo ve formátu E.164, pokud jej ovladač rozpozná; zobrazení používá čitelný národní formát. Neúplný rozepsaný vstup se nezahazuje.      |
| Mobil a tablet — telefon | Kompaktní tokeny a menší vlajka pod 1024 px zachovávají celé číslo i na 320 px a při rozdělení formuláře do sloupců na 768 px. Oba díly mají správný rámeček.                                                    |
| Newsletter               | Panel je vedle kontaktního formuláře od 768 px a pod ním na mobilu. Zachováno skutečné znění souhlasu, revize, grant, odvolání i obsluha konfliktu a nedostupnosti. Není uvnitř formuláře ukládajícího kontakty. |
| Ověření košíku           | Přesunuto z prostoru nad kroky checkoutu pod akce. Běžný stav je stručný text; chyby, změněné ceny a opakování ověření zůstávají výrazné. Backendová kontrola i blokace pokračování zůstávají zachované.         |

U telefonu bylo nutné zachovat dvě již používané drobné adaptace UI-kitu z referenční větve: rámeček `PhoneInput.Input` a slot šipky předvolby. Samotný UI-kit zde natvrdo používá bezrámečkový vstup; další rozměry a mobilní chování řeší aplikační tokeny. Sdílený UI-kit se nemění.

## Ověření

- **Finální `mise exec -- pnpm --filter akros-storefront run check` prošlo:** formát, lint, TypeScript, všech 543 testů a produkční build. Zůstávají viditelná dosavadní lint varování a varování Next konfigurace o `experimental.staleTimes.static`; tato změna je neobchází ani nepotlačuje.
- 165 kombinací skutečné obrazovky a šířky; upravené obrazovky po dokončení změn znovu přeměřené. Šířky: 320, 390, 640, 760, 761, 768, 1023, 1024, 1100, 1101, 1280, 1440, 1535, 1536 a 1920 px.
- Bez zachyceného vodorovného přetékání; 30 kontrol tabulky variant bez překryvu buněk. Všech 30 porovnání množství v košíku a shrnutí zůstalo rozměrově shodných s `feat/akros`.
- 48 interakčních a geometrických kontrol v Chrome: čitelnost celého telefonu skutečným písmem, rozmístění newsletteru, 60px pole kategorií, odeslání všech parametrů filtrů, poloha stavu košíku pod akcemi, zablokování pokračování při chybě a změně ceny, retry a přijetí nové ceny.
- Dva nové komponentové testy ověřují ukládání telefonu s předvolbou a oddělení kontaktního profilu od udělení/odvolání souhlasu včetně správných revizí.
- Původní prohlížečový test profilu aktualizován pro `PhoneInput`: už nehledá obal komponenty jako nativní textový input a kontroluje skutečnou hodnotu s předvolbou.

Geometrické a prohlížečové ověření používá řízené odpovědi API pouze v izolovaném testovacím harnessu. Nepotvrzuje nově živé zápisy do backendu ani doručení e-mailů. Komponentové testy prověřují skutečný FE request/response tok proti simulované transportní vrstvě.

Výsledky příkazových kontrol jsou evidované v lokálních logách `test-results/visual-parity/implementation-*-20261030.log`. Plná workspace gate byla po opravě browser adaptéru znovu spuštěna přes `mise exec -- pnpm check:local --scope full`: 310/320 lint-rule testů prošlo, 10 selhalo v pěti souborech. Zbývají problémy Windows/ESM v generovaných lint fixtures, aserce testu `native-runtime-teardown` a existující nálezy `no-instanceof` ve skriptech CI mimo storefront. Podrobnosti zachovává `test-results/visual-parity/browser-driver-workspace-gate-20261030.log`. Pravidla ani jejich závažnosti se neměnily a celá workspace se nepovažuje za zelenou.

Jeden běh úplné storefront sady zachytil časově nestabilní první recovery test checkoutu při čekání na tlačítko odeslání. Samostatný běh všech 33 testů recovery prošel a následná plná kontrola znovu prošla se všemi 543 testy i buildem (`implementation-storefront-confirmed-gate-20261030.log`). Test ani jeho timeout se kvůli tomu neupravovaly; příčina časové nestability se nepovažuje za opravenou.

Formatter původně označil 150 souborů s CRLF. Byly převedené pouze na LF; Git diff tím nezískal žádné další obsahové změny. Nevznikl hromadný formátovací refaktor.

## Oprava browser adaptéru blokujícího commit

Povinný pre-commit lint odmítl `SharedClient.openTab` v převzatém `scripts/demo/mcp-oauth-e2e/browser.mts`. Jeho externí implementace byla dostupná pouze na pevné macOS cestě `/Volumes/TraceDecayKingston/techsio-demo/shared-browser/client.mjs`; na ostatních počítačích nešlo ověřit její původ. Lint pravidlo se nemění.

Adaptér nyní otevírá vlastní Playwright prohlížeč přes již nainstalovaný `playwright-core`. Zůstává podporovaný CI override `E2E_PLAYWRIGHT_MODULE`, včetně absolutních Windows cest převedených na `file:` URL, a oba způsoby exportu launcheru. Soukromý macOS bridge už není výchozí ani podporovaná větev adaptéru. Jméno funkce pro existující volající, OAuth tok a úklid prostředků zůstávají zachované.

Skutečný start navíc odhalil, že původní dekódování zkopírovalo `chromium.launch` a ztratilo původní SDK receiver. Validace přes `Schema.is` nyní zachovává celou původní instanci. Nový regresní test nejprve chybu reprodukoval; po opravě prošel. Chybné exporty modulu vracejí `BrowserDriverFailure`.

- 10 testů browser adaptéru a 6 existujících testů OAuth hranic prošlo.
- Regresní test lint pravidla prošel včetně původních negativních kontrol. Aktualizované čtení skutečného browser skriptu už nevyžaduje náhradu neexistující macOS cesty.
- Cílený lint všech tří změněných souborů prošel bez výjimek a potlačení pravidel.
- Skutečné Chromium otevřelo lokální testovací stránku ve výchozím režimu i s absolutní Windows cestou k modulu a po obou ověřeních se zavřelo.
- Širší související OAuth sada má 22/24 úspěšných testů: dva stávající testy čtení `prove.mts` a `prove-agent-entity.mts` používají ve Windows neplatnou cestu `/D:/…`. Tyto soubory se v této opravě nemění.

První použití Playwrightu na novém počítači vyžaduje odpovídající Chromium přes `mise exec -- pnpm exec playwright-core install chromium`. Verze závislostí ani lockfile se kvůli adaptéru nemění. Lokální důkazy jsou v `test-results/visual-parity/browser-driver-*-20261030.log`.

## Co tato změna neuzavírá

Zůstávají otevřené závislosti popsané v původním auditu: hmotnost konkrétní varianty za prodejní jednotku a součet košíku, zákaznická správa uložených adres, přímá změna hesla, skutečné hlídání dostupnosti a globální filtr období objednávek. Obnova zapomenutého hesla je samostatný tok a není součástí této úpravy vzhledu.

V obou větvích reprodukované varování `Combobox` o chybějícím React `key` zůstává samostatným bodem UI-kitu.

## Podklady k review

- [Reference / před opravou / po opravě](test-results/visual-parity/implementation-captures-20261030/index.html), přepínání 390 / 768 / 1440 px a samostatné výřezy telefonu na 320 px.
- [Souhrn měření](test-results/visual-parity/implementation-captures-20261030/implementation-summary.json).
- [Podrobné interakční kontroly](test-results/visual-parity/implementation-captures-20261030/implementation-browser-checks.json).

Galerie, logy a pomocné harnessy jsou lokální, ignorované Gitem; nejsou součástí commitu.
