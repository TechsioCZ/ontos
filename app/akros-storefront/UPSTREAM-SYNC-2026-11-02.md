# Aktualizace integrační větve AKROS, 2. 11. 2026

Aktualizace navazuje na `demo/sales-crm-updated` na `a1af9c3ac8289db4d533671b7dabcdb047383218`
a připojuje 331 commitů z `demo/sales-crm` do `0a29546ea795f9a20ec4f44d67f390262ac6c7ef`.
Referencí opraveného FE zůstává `feat/akros` na `f1b74b02aa9ca978300a88189721c7813ef02e06`
a [jeho Vercel deploy](https://akros-l1k8fzuvl-kaiuweczes-projects.vercel.app/).

## Řešení konfliktů

- Nové trhy, jazyky, měny, lokalizované odkazy a doručování produktových obrázků přicházejí z upstreamu.
- Varianty zachovávají opravenou tabulku, čitelné SKU, kompaktní nákup balení, automatické
  rozměrové filtry a zobrazení všech odpovídajících variant bez stránkování.
- Oblíbené, dotazy a sdílení zachovávají výběr konkrétních variant. Není obnoven původní
  samostatný přepínač oblíbeného produktu bez variant.
- Karty a vyhledávání zachovávají označení ceny dle varianty. Ceny a objednávky přitom používají
  měnu svého trhu nebo objednávky, nikoli pevné CZK.
- Detail a výběr variant používají také formátování měny trhu. Načítání jejich katalogu a
  opakování objednávky předávají trh v novém request headeru; sdílené odkazy a návrat z detailu
  zachovávají jazykový prefix.
- Kategorie zachovávají sjednocené formulářové tokeny a informační text bez nabídkové ceny „od“.
  Účet zachovává telefonní ovladač a rozložení newsletteru. Ověření košíku zůstává pod akcemi
  checkoutu a stále blokuje pokračování při chybě, změně ceny nebo neobjednatelných položkách.
- Patch UI-kitu obsahuje upstream změny i naši opravu klíčů Comboboxu. Lockfile používá hash
  výsledného patche a nový upstream patch Drizzle.
- Browser adaptér zachovává přenositelné Playwright API, Windows cesty a úklid prostředků.
  Změna upstreamového externího macOS bridge se nevrací do této odstraněné větve kódu.

## Zbývající práce

Kontrola zdrojových kontraktů není důkazem úspěšného živého průchodu.

| Oblast                            | Stav po kontrole nového upstreamu                                                                                                                                                         | Potřebný další krok                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vlastní adresy, #1312             | Doménový adresář a akce existují. Zákaznický profil stále vystavuje kontaktní údaje a verzi, nikoli adresář odvozený ze session.                                                          | Doplnit zákaznický kontrakt a napojit skutečné načítání a ukládání. Ověřit persistenci i v jiné session/prohlížeči.                                                                                         |
| Hmotnost, #1305 a #1314           | Produktové `weightGrams` existuje. `CatalogProductVariant` nemá hmotnost za prodejní jednotku.                                                                                            | Vyjasnit a vystavit variantovou hodnotu s jednotkou, rozlišit chybějící údaj od nuly. Poté FE detail a součet podle množství.                                                                               |
| Změna hesla, #1313                | Recovery API nabízí reset přes token. Přímá změna se současným heslem není v kontrolovaných zákaznických kontraktech vystavená.                                                           | Doplnit zákaznické API a napojit formulář účtu.                                                                                                                                                             |
| Další funkce z předchozího review | Hlídání dostupnosti, filtr období objednávek a FE tok obnovy hesla nebyly touto aktualizací dokončeny. Oblíbené používají úložiště prohlížeče.                                            | Ověřit rozsah proti jednotlivým bodům zadání a aktuálním kontraktům, nepovažovat je automaticky za hotové.                                                                                                  |
| Skutečný localhost                | Přítomnost nových runtime oprav sama nedokazuje běžící backend. Na tomto Windows hostu nejsou příkazy Docker a Locki dostupné v PATH. Demo startup předpokládá Docker kontext `orbstack`. | Připravit odpovídající lokální prostředí a ověřit katalog, účet a objednávku se skutečnými daty. Nespouštět reset sdíleného dema jako náhradu.                                                              |
| Vizuální převod                   | Předchozí audit a testovací snímky jsou historické výsledky. Tato aktualizace nenahrazuje nové úplné vizuální porovnání.                                                                  | Po zprovoznění backendu projít [Google Docs](https://docs.google.com/document/d/1zMqf_xghQnQ9u-NcQmTkhVX8qOIjoUZDZ5nSPEjJde0/edit?tab=t.nk2t7k86gd14) bod po bodu proti referenci, včetně mobilu a tabletu. |

## Validace

- Pre-commit odhalil false positive pravidla `no-service-constructor-imports` pro aktuální
  Shell API. Model nyní rozpoznává neměnné importované literální klíče stejného vlastníka a
  složený transport `Layer.mergeAll`; nadále odmítá dynamické klíče, cizí vlastníky a úniky
  transportu. Typecheck pravidel, lint skutečného Shell souboru a pět cílených regresních
  testů prošly, včetně negativních kontrol.
- Převzatý spouštěč fonttools používal přímé Node I/O, které blokovalo pre-commit. Nyní
  používá Effect služby a scoped procesy; zachovává připnuté Python závislosti a zdrojový
  algoritmus subsetů. Lint i ověření chybějícího `uv` (návratový kód 1 a instalační pokyny)
  prošly. Fonty se při této opravě znovu negenerovaly.
- Frozen instalace s připnutými Node `26.12.0` a pnpm `12.11.2` prošla včetně kontroly
  supply-chain politik, patchů, instalačních skriptů a Git hooků. Kvůli pomalému kopírování na
  Windows použil dokončený běh `mise exec -- pnpm install --frozen-lockfile --package-import-method hardlink --reporter append-only`
  s `RAYON_NUM_THREADS=2`. Konfigurace repozitáře se kvůli instalaci neměnila.
- Storefrontový formát, lint a TypeScript prošly. Lint dál zobrazuje existující varování.
  U 311 textových souborů se v pracovním stromu sjednotily pouze konce řádků CRLF na LF.
  Převzatý `inter-subsets.generated.json` vyžadoval také standardní formátování.
- `mise exec -- pnpm --filter akros-storefront exec vitest run --maxWorkers=1`:
  **627/627 testů v 79 souborech prošlo**, 472,99 s. Pokryté jsou i nové trhy, 47 variant bez
  stránkování, okamžitá filtrace a reset, EUR ceny, variantové oblíbené a request kontext trhu.
  Původní paralelní běh narazil na časové limity; testovací limity ani aserce se neoslabily.
- `mise exec -- pnpm check`: kontrola typů lint pravidel prošla. Následující sada lint pravidel
  po 423 s stále neměla výsledek a její procesy byly ukončené. Další fáze agregátu se nespustily.
  Úspěch úplného workspace gate není doložený.
- Samostatné `mise exec -- pnpm database-access:check` bylo po 352 s bez výsledku ukončené.
  Nelze tvrdit, že dřívější nálezy tohoto gate jsou novým upstreamem odstraněné.
- `mise exec -- pnpm i18n:boundaries` neprošlo. Hlásí mimo jiné literal copy v převzatém
  `apps/shell-super-app/src/routes/people/people-table.tsx`, který je shodný s upstreamem.
  Aktualizace nevypíná pravidla ani nepřekládá nesouvisející administraci.
- `mise exec -- pnpm --filter akros-storefront build` prošlo včetně TypeScriptu, generování
  statických stránek a build traces. Převzaté varování o `experimental.staleTimes.static`
  v Next konfiguraci zůstává viditelné.

Živé backendové zápisy ani úplné vizuální porovnání tato aktualizace neprovedla. Úspěšné izolované
testy nepředstavují ověření persistence, odeslání e-mailů ani úplné shody s referenčním deployem.
