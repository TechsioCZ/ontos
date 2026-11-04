# N1 storefront

> Rozpracovaný integrační stav. Katalog, varianty, návrh košíku a backendové
> ověření cen byly ověřené se skutečným lokálním N1 kontextem. Nejde o hotový
> převod všech obrazovek Figmy. Detail nyní rozlišuje desktopový NumericInput
> a mobilní QuantityField; karty používají contain a vypnutý stín přes knihovní API.
> Guest checkout a potvrzení mají nativní integraci; úplný zákaznický účet ještě chybí.
> Portal registrace/přihlášení mají implementaci a testy; celý pozitivní živý
> průchod ještě není doložený. Lokální data ani přístupové údaje nejsou součástí aplikace.

Samostatná Next.js aplikace v demo workspace. Vychází z Figma souboru
[N1 Storefront](https://www.figma.com/design/gIHtMwCCl2OXhMAW9s9LIn/N1-Storefront)
a z [AKROS handoffu](../akros-storefront/FOR-KAI-UWE.md).

## Aktuální rozsah

Aktuální přírůstek obsahuje vlastní workspace, responzivní hlavičku a patičku, originální
N1 logo, knihovní Carousel s jediným doloženým bannerem, statické promo dlaždice,
češtinu a angličtinu, domovskou stránku a čtení katalogu, kategorií,
vyhledávání a plných detailových dat přes veřejnou OntOS Shell gateway. Používá publikovaný
`@techsio/ui-kit` z workspace katalogu se sdíleným pnpm patchem popsaným níže.
Neimportuje privátní zdroje jiné aplikace.

Je to rozpracovaný storefront, nikoliv hotový převod všech obrazovek Figmy. Login,
registrace a ověření e-mailu mají existující Portal integraci; košík a owner dry-run
ověření jsou popsané níže. Guest checkout čte skutečné dopravy, ověřuje celkovou
cenu a vytváří objednávku s dohledáním výsledku podle stabilního požadavku.
Účet/profil, uložené adresy a zákaznický seznam/detail objednávek nejsou dokončené. Doprava a platby čtou skutečné market checkout možnosti; právní
texty a ostatní obsahové stránky kromě kontaktů čekají na skutečný obsah.

Úplný seznam všech aktuálních rámců a stavů je v `FIGMA-INVENTORY.md`. Kategorie nyní
obsahuje skutečný strom, breadcrumb, podkategorie, počet a serverové stránkování;
mobilní karty mají vlastní návrhovou skladbu místo přestylování homepage karet.
Detail zachovává galerie, parametry a aktivní varianty ownera. Výběr varianty v URL
mění skutečnou cenu, dostupnost, jednotku a minimum; resetuje galerii. Ovládání množství
a přidání do košíku vyžadují skutečný N1 kontext, konkrétní naceněnou dostupnou
položku a platné množství. Galerie a tabulky velikostí nemají náhradní data.
Naplněné stavy byly prohlédnuté se skutečným lokálním N1 kontextem;
kvůli zaznamenaným rozdílům stále nemají úplný vizuální PASS.

Bez nakonfigurované N1 identity se ukáže nedostupný katalog. Neexistuje přepnutí na
AKROS, statický produktový feed ani mock backend. Testovací data jsou jen v testech.

## Košík a ověření zboží

`/{locale}/kosik` ukládá pouze zákazníkův návrh výběru, odděleně pro tenant,
prodávající Legal Entity, market a měnu. Návrh není rezervace ani objednávka.
Poškozená nebo cizí uložená data se netváří jako prázdný košík. Chyba zápisu
do browser storage nepotvrdí přidání; vymazání se týká pouze aktuálního trhu.

`POST /api/cart-quote` znovu ověří vlastní N1 konfiguraci, aktivní asociaci trhu,
skutečnou měnu/nabídku a revision ownera. Existující generovaný merchandise klient
volá `PlaceStorefrontOrder` s `dryRun:true`, čerstvým assertion a idempotency key.
Není to nový backendový Action ani raw owner POST. Browser neposílá autoritativní
scope a server nikdy nepoužije Akros identitu nebo market fallback.

Souhrn zobrazuje jen skutečné owner částky za zboží; doprava/platba nejsou vybrané
ani doplněné nulou. Změna položek nebo neplatný quantity draft zneplatní quote.
Vrácení se ke stejnému návrhu neobnoví staré ověření. Změněná cena vyžaduje
výslovné přijetí a nové ověření. Ovládání checkoutu zůstává neaktivní, dokud není
implementovaný celý navazující tok. Endpoint žádnou objednávku nevytváří.

Čerstvé Figma podklady: empty desktop `56:636`, mobile `56:800` a guest summary
`319:1778`. Fixture produktu/cen z Figmy ani veřejného referenčního N1 webu se do
runtime nepřebírá. Lokální přidání varianty a VALID owner quote byly ověřené;
vytvoření objednávky zatím nemá potvrzené live end-to-end ověření.
Hlavička nyní otevírá mini košík podle rámců `59:1042`/`59:1074` a mini login
podle `59:1709`. Otevřený zůstává jen jeden header panel. Mini košík sdílí
skutečný návrh/quote se stránkou košíku; chybějící scope neprezentuje jako empty.
Stránka a hlavička sdílejí jednu paměťovou Portal session v aktuálním scoped
storefrontu, obnovovanou owner GET při mountu. Credentials se nepersistují.
Mobilní menu skládá Dialog a návrhové kořenové Accordiony (`59:1595`); hlubší
owner větve používají VerticalNavigation. Názvy ani cíle se nekopírují z fixture.
Celý checkout ani živý N1 nákup tím nejsou dokončené.

## Figma → code

Před převodem každé části znovu načíst její aktuální Figma frame a varianty instancí;
návrh se průběžně mění. Screenshot samotný neurčuje API komponenty. Použít Code Connect
a porovnat `variant`, `theme`, `size`, stav a compound anatomy s instalovaným UI kitem.
Při ověření znovu načíst referenční frame, neporovnávat jen s historickým screenshotem.

`src/tokens/figma/n1.json` je úplný čtený export knihovního
[New Design System / Theme / N1](https://www.figma.com/design/gi5GUSWwAeXknaKEeLqK5w/New-Design-System?node-id=2667-2)
(`4082:0`), aktuálně 447 proměnných. Nemíchá komponentové snapshoty ani lokální
App overrides ze storefrontové Figmy. `src/tokens/figma/n1.css` generuje `pnpm theme:generate`;
`pnpm theme:check` kontroluje shodu se snapshotem. Nová data se musí nejdřív znovu načíst
z Figmy — samotné spuštění rendereru Figma soubor nekontaktuje. CSS nepatří ručně měnit.

Theme je aktivní na `html[data-theme="n1"]`. Kit již registruje všech 447 názvů;
generovaný unlayered brand selector pouze aktivuje kanonické hodnoty a aliasy po kitu.
`globals.css` obsahuje importy a app layout/typography metadata. `tokens/storefront.css`
obsahuje společnou mapu Header/Footer slotů na kanonické tmavé role a doložené
komponentové role ProductCard a header popupů. Tyto organismy nemají tone prop.
Žádné kontextové `n1-*-tokens` třídy nezůstávají.
App CSS neobsahuje
vlastní masky ikon, body font override ani vzhledové CSS komponent. Zdrojové props
a rozměry jsou zachycené v `src/tokens/figma/components.json` jako historický snapshot;
aktuální rozhodnutí a mezery popisuje `COMPONENT-MAPPING.md`.

| Figma instance                     | Ověřený kit kontrakt                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `440:1961`, `440:2153`             | `SearchSuggestions size="sm"`, vlastní knihovní input/trigger, reálné groups/resultSlot a allResultsLink     |
| `170:2045`, `170:2057`, `170:2067` | Runtime Button tertiary/unstyled/current s originálním assetem přes children; geometrie bez CSS přestylování |
| `39:2500`, `39:2527`               | Mobil: QuantityField md a plný primary/solid/md Button (44 px), owner minimum/unit                           |
| `219:2820`, `39:2074`              | Desktop: NumericInput compact 104 × 36 px a secondary/solid/md Button s density compact (36 px)              |

Tabulka je záznam načtené verze, ne náhrada dalšího čtení Figmy. Footer, katalog,
produkt a zbývající obrazovky potřebují další kontrolu; zapojení theme samo o sobě
nedokazuje shodu celého storefrontu. Runtime zachovává knihovní `system-ui`; samotné
Inter ve Figmě podle handoffu neopravňuje přepis tohoto kontraktu.

Vizuální API rozšiřuje existující `app/patches/@techsio__ui-kit@0.57.0.patch`:
Button/LinkButton a NumericInput mají opt-in `density="compact"`, ProductCard
`shadow={false}`, `presentation="featured"` a ProductCard.Image `objectFit="contain"`. Výchozí varianty
zachovávají původní výšku, padding, stín a ořez. Rozměry compact jsou tokeny kitu;
app nepřepisuje appearance třídami na knihovních komponentách. Instalace vyžaduje
odpovídající workspace lockfile. Patch není publikovaná nová verze knihovny.

Homepage a desktopový výpis používají featured tokenové role. Mobilní výpis
zachovává původní ProductCard role (padding10, medium16 název, border1); nesdílí
homepage appearance. Obrázek skládá podporovaný NextImage fill v layoutu4:3,
takže na šířce390 má336×252. Radius a barvy přebírá z kanonického N1 theme.
Strom kategorie ukazuje skutečnou aktuální kořenovou větev. Desktop má accent
nadpisu a warning panel počtu; mobil má samostatné rozložení podkategorií.

Desktopové hledání má responzivní kontejner 40vw (576/768 px při 1440/1920).
Na mobilu je podle návrhu skryté; utility bar a ovladatelné menu jsou součástí shellu.
Našeptávání používá existující `SearchSuggestions` s jediným inputem, externím
přístupným Label, groups/resultSlot a allResultsLink. Přebírá běžnou interakci kitu:
první Enter bez zvýrazněné položky zavře popup, další Enter odešle form; výběr výsledku
naviguje přes `navigate`, footer odkazuje na celý dotaz. Neobsahuje wrapper key handlery.

Skutečná data čte přes lokální readonly `GET /api/search-suggestions?locale=cs&q=…`
se `Cache-Control: no-store`, nad stejnou validovanou veřejnou OntOS gateway jako
výsledková stránka. Browser používá Effect HTTP klienta, runtime dekódování DTO,
debounce250ms a přerušení nepotřebného fetch. Next Server Actions se pro typeahead
nepoužívají, aby nové čtení nečekalo v jejich klientské frontě. Serverový owner read
zůstává omezený vlastními timeouty; samotný browser abort nedokládá jeho přerušení.

Nejvýše osm produktových návrhů pochází ze skutečného owner výsledku. Značky nebo
historické Fox produkty se nevymýšlejí. Loading, skutečně prázdný výsledek a nedostupnost
jsou odlišné stavy; nedostupnost používá návrhovou kompozici empty s pravdivým textem.
Živé naplněné výsledky čekají na funkční N1 konfiguraci a data.

Statické promo obrázky a popisky odpovídají návrhu včetně mobilní skladby 3+1.
Jejich odkazy nemají v předaných podkladech potvrzený cílový owner záznam; proto jsou
neaktivní, bez vymyšleného href. Carousel má jeden skutečný indikátor a obě šipky
disabled, dokud nejsou dostupné další kampaně. Banner se neduplikuje do falešných slidů.

Šířka desktopového návrhového frame 1440 px není maximální šířka aplikace.
Hlavička, banner a patička mají ve Figmě `FILL`; jejich vnější obal vyplňuje viewport.
Limit 1200 px se týká vnitřních obsahových sekcí domovské stránky.

## Serverová konfigurace

Nastavit prostřednictvím prostředí procesu nebo deploymentu; žádnou hodnotu nevkládat
do `NEXT_PUBLIC_*`, zdrojového kódu ani prohlížeče:

| Proměnná                           | Účel                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `ONTOS_N1_STOREFRONT_API_KEY`      | Vlastní omezený N1 Storefront Client klíč                          |
| `ONTOS_STOREFRONT_TENANT_ID`       | Tenant přiřazeného N1 storefrontu                                  |
| `ONTOS_STOREFRONT_LEGAL_ENTITY_ID` | Prodávající N1 Legal Entity                                        |
| `ONTOS_SHELL_URL`                  | Shell origin; lokálně výchozí `http://localhost:3020`, jinak HTTPS |
| `STOREFRONT_IMAGE_HOSTS`           | Povolené veřejné HTTPS hosty produktových obrázků, oddělené čárkou |

Storefront Application ID je `n1-storefront`. Vlastník `commerce.market-catalog` musí
vrátit právě jeden účinný ACTIVE B2C trh pro danou identitu a locale (`cs` / `en`).
Merchandise odpověď musí potvrdit stejné `marketId`. Chybějící, zakázaný, neaktivní či
nejednoznačný kontext zablokuje čtení; aplikace nikdy neotevře nefiltrovaný katalog.

Pořadí provisioningu, samostatné Action oprávnění, ověření asociací a bezpečný
import historického skladu popisuje [Napojení N1 storefrontu](INTEGRATION.md).

Použitý veřejný kontrakt: serverové `POST /shell-super-app-api/auth/api-key/gateway-read`
s `audience`, `legalEntityId`, `readName` a `query`. Trhy používají
`commerce-market-catalog/current-market-catalog`; produkty `merchandise/records`
s `view.storefront: true` a `view.storefrontCatalog.marketId`.

Server drží jeden Effect ManagedRuntime. Odpovědi dekóduje Effect Schema a očekávané
chyby mapuje na nedostupný stav. Karty a detail neukazují neplatnou nebo cizoměnovou
cenu jako platnou. Samotný počet na skladě neurčuje dostupnost.

Produktová média typu `media:` zatím potřebují doplnění skutečného owner media readu.
Aplikace z nich neodvozuje adresy ani nepřebírá AKROS obrázky. Zatím podporuje pouze
výslovně povolené veřejné HTTPS URL. Rovněž nepřebírá AKROS váhový index, Smart Address
ani lokální oblíbené. Benefit pás přebírá statický marketingový obsah návrhu;
nedokládá skutečnou dostupnost online platby ani výpočet dopravy v checkoutu.
Cookie settings zůstávají neaktivní do zapojení skutečné správy souhlasu.

## Portal účet

`/{locale}/prihlaseni` a `/{locale}/registrace` používají veřejné session,
enrollment a recovery skupiny vlastníka commerce-customer-context přes čerstvý
gateway assertion. N1 nemá vlastní auth databázi ani fallback na AKROS identitu.
Provider session a dokončený enrollment nejsou samy o sobě customer admission.
Cookies jsou omezené na commerce realm a zůstávají host-only. Nejasný výsledek
zápisu se neopakuje automaticky; UI nabídne bezpečné čtení stavu.

Mailový callback je přesně
`/commerce-customer-context-api/api/portal-auth/verify-email`. Přijímá jediný token
a nejvýše jeden provider callbackURL, který vždy zahodí. Token ověří jednou přes
veřejný owner klient bez browser cookies/Origin a přesměruje na pevnou CS login
stránku s notice, bez tokenu. Notice nepřiznává session. Cílový origin mailu určuje
BE konfigurace `COMMERCE_PORTAL_AUTH_URL`; FE ji nemění ani nenahrazuje.
Úspěšné ověření e-mailu nezaručuje dokončený enrollment: čekající stav má explicitní
pokračování, po dokončení se znovu ověřuje customer admission.

MFA completion, forgotten-password a úplný account/order přehled zatím chybí.
Skutečný N1 tenant, produkty a end-to-end auth nejsou potvrzené. Lokální Shell
a owners musí běžet a N1 musí mít vlastní klíč a přiřazený tenant/seller.

## Lokální spuštění a kontroly

Z `app/`:

```sh
mise run deps
mise exec -- pnpm --filter n1-storefront dev
mise exec -- pnpm --filter n1-storefront test
mise exec -- pnpm --filter n1-storefront typecheck
mise exec -- pnpm --filter n1-storefront lint
mise exec -- pnpm --filter n1-storefront build
```

Vývojový server běží na `http://127.0.0.1:3071/cs`. Prohlížení vyžaduje skutečnou N1
konfiguraci pouze pro datové části. Bez ní lze ověřit rozložení a nedostupné stavy.
Produkční build je standalone; nasazení a provisioning N1 zatím nejsou zapojené.

## Pokračování

1. Připravit N1 tenant/seller, Storefront Client, oprávnění, asociované trhy a import
   skutečných produktů; ověřit katalogová čtení proti těmto datům.
2. Dokončit a ověřit naplněné katalogové rozložení, skutečné Core Media čtení,
   kategoriální obsah a všechny produktové stavy. Veřejný media read existuje, ale jeho
   storefront oprávnění pro samostatnou N1 prodávající entitu potřebuje potvrzení BE;
   nepřebírat staff oprávnění jako náhradní cestu. Filtry přidávat pouze podle návrhu
   a podporovaného owner kontraktu; nefiltrovat náhradně jednu stránku ve FE.
3. Převést dostupné OntOS account, quote a order kontrakty do N1 rozhraní. Ověřit reálné
   dopravní a platební možnosti před implementací jejich konkrétních ovládacích prvků.
4. Dokončit všechny obrazovky a stavy Figmy, provést vizuální kontrolu s reálnými N1 daty
   a teprve potom připravit cílový deployment. Tato změna nic nenasazuje ani nepushuje.
