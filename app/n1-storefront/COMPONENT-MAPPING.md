# N1 — aktuální komponentové a tokenové mapování

Autorita vzhledových tokenů: [New Design System / Theme / N1](https://www.figma.com/design/gi5GUSWwAeXknaKEeLqK5w/New-Design-System?node-id=2667-2),
447 proměnných, mode `4082:0`, čtecí session `0397b40e-b436-4ebb-bf27-114466df5aa0`.
Autorita API: skutečně instalovaný `@techsio/ui-kit`. Storefrontová Figma určuje
kompozici a instance, nikoliv náhradní paletu nebo oprávnění přestylovat knihovnu.

## Tokenová kaskáda

1. Veřejný `@techsio/ui-kit/tokens-with-tailwind` registruje tokeny a komponentové aliasy.
2. Generovaný `tokens/figma/n1.css` aktivuje pouze kanonických 447 proměnných na
   `html[data-theme="n1"]`. Všechny názvy již kit registruje; není druhá ruční kopie.
3. `tokens/storefront.css` jednou propojí existující Header/Footer sloty s N1 tmavými
   rolemi. Tyto organismy nemají tone prop. Nemění paletu, typografii ani velikosti instancí.
4. `globals.css` obsahuje importy, content registration a layout metadata pro wrappery.
   V 0.57.0 je explicitní `@source` nutné: novější referenční skill popisuje už opravený
   balíček, instalovaný CSS entrypoint tuto registraci ještě neobsahuje.

Žádná `n1-*-tokens` třída, vzhledové JSX přepisy ani místní kopie komponentového
defaultu. Legacy `--color-primary` není jediný zdroj: Button čte moderní bg role
a oba on-primary foregroundy. Mobile input floor 16 px zůstává knihovní.
Původní 418-tokenový mix komponentových snapshotů a App overrides byl nahrazen.

## Kompozice

| Oblast / Figma                | Skutečné komponenty                                                                         | Stav / hranice                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Header `33:635/34:915`        | Header vertical/sm; Actions/ActionItem; Button current/unstyled; Image/Link s Next adaptéry | Tmavé role globálně, menu řídí skutečný state; account/cart/favorites disabled                |
| Search `440:1961/2153`        | SearchSuggestions sm, Label, Image, PriceBlock, LinkButton md/secondary/solid               | Jediný input; skutečný readonly GET, loading/empty/unavailable; běžná keyboard interakce kitu |
| Hero `33:771/34:954`          | Carousel full/none/none, jeden doložený slide                                               | Žádné falešné kampaně; controls a indicators používají knihovní theme                         |
| Benefits/promo                | Image s původními samostatnými assety; aplikační layout                                     | Promo bez potvrzeného owner cíle neodkazuje na vymyšlenou kategorii                           |
| Footer `33:1100/34:1255`      | Footer vertical/col/md/sectionFlow col                                                      | Existující sloty, N1 role a layout; žádná kontaktní/copyright tokenová scope                  |
| Home karty `33:877`           | ProductCard Name/Image/Stock; PriceBlock; Button nebo LinkButton                            | Jen owner ceny/dostupnost; unknown přes AvailabilityStatus, nákup disabled                    |
| Kategorie `214:3151/3202`     | Breadcrumb md, přesný home asset; TreeView md; LinkButton md/secondary/outlined             | Skutečný strom, podkategorie a předci; cykly se ukončí                                        |
| Kategorie mobil `38:2185`     | ProductCard Image/Name, PriceBlock, AvailabilityStatus, outlined LinkButton                 | Skladba lišící se od home; vzhledové defaults již nejsou lokálně přepisované                  |
| Paginace `214:4488/38:2138`   | Pagination filled, NextLink, createPaginationGetPageUrl                                     | Owner total/page/pageSize; q zachováno; compact při 320                                       |
| Produkt `39:1965/2430`        | Gallery horizontal, LinkButton varianty, PriceBlock, AvailabilityStatus                     | Skutečné owner varianty, URL variantId; key resetuje gallery/množství                         |
| Množství mobil `39:2500`      | QuantityField md, primary/solid/md Button block (44 px)                                     | Owner minimum/unit; sdílený quantity draft s desktopem                                        |
| Množství desktop `219:2820`   | NumericInput md/compact 104 × 36, secondary/solid/md Button compact                         | Minus 28 + input 48 + plus 28; opt-in knihovní density                                        |
| Informace `219:2876/2884`     | Tabs line/md; Code Connect DataTable hideHeader                                             | Parametry ownera; sorting vypnutý, line mobil / striped desktop; bez falešné size guide       |
| Stavy `57:906/2904/3009/3028` | Skeleton, explicitní output, Button retry                                                   | Skutečný refresh; unavailable není empty ani vymyšlená vyprodanost                            |

## Meze vizuálního tvrzení

Instanční přepisy ve storefrontové Figmě mohou mít jiné metriky než kanonický theme
a podporované variants. Tyto rozdíly se nesmějí vracet jako CSS scope. Patří do
konkrétního záznamu rozdílu komponenty/API a designu. Aktuální browser důkazy,
computed tokeny a otevřené rozdíly jsou v `VALIDATION.md`.
Bez N1 owner dat nejsou naplněné karty, galerie a varianty vizuálně ověřené.
Celý inventář obrazovek a stavů: `FIGMA-INVENTORY.md`.

## Pokračování převodu — kontakty a opravy kompozice

Aktuální čtecí Figma session `fc726167-f2e2-44b1-9781-a83a73bcafd0`.
Kontakty: desktop main `369:2578`, mobil main `369:2758`; celé rámce
`43:1162/43:1595`. Layout má max1200 a40px gutter, centrované veřejné
kontaktní údaje, oddělenou reklamační a provozní adresu a dvousloupcový formulář
i na390 dle návrhu. Na320 se dlouhé kontakty zalamují. Vlastní formulář skládá
FormInput md a FormTextarea md (Label/Textarea stejná knihovní anatomie), secondary
solid Button md. Pole nemají vzhledové className/style ani lokální tokenové scopes.
FormTextarea je podporované zkrácení téhož Label + Textarea compound kontraktu.

Carousel `33:771/34:954`: ovladače jsou přímo v layout wrappers uvnitř Carousel rootu.
Optional Carousel.Control se nepoužívá — přidával nevhodný surface a padding.
Zag kontext, disabled hranice a kanonické ovladače zůstávají. Jeden skutečný asset
není duplikovaný do tří návrhových slidů. Bílá barva/48px reference není opravená
per-instance CSS; veřejné root size full určuje40px a kanonickou foreground.

Header nav obsahuje statické Novinky nezávisle na dostupnosti produktových kategorií;
další položky stále pocházejí jen z owner dat. Footer md a Search footer md zůstávají
stejné jako deklarované Figma props. Nepřepínají se odhadem na sm kvůli přiblížení
instančním metrikám; odlišnosti knihovních metrik jsou přiznaná mezera kontraktu.

## Přihlášení a registrace

Aktuální čtecí Figma session `52f1ec68-61cc-4343-83f7-ed710c5270c3`: login
desktop/mobile `333:4671/333:5192`, registrace `333:5341/333:5536`.
`AuthView` skládá FormInput md, FormCheckbox sm, Link s NextLink adaptérem a
Button primary/solid/sm/block. Formulář má šířku448, na mobilu FILL, jméno/příjmení
dva sloupce s gap4; vnější rozestupy28/24 a login/register gap4/8 jsou layout.
Tři app layout tokeny určují šířku a minimální výšku, nemění vzhled primitiv.

Theme zůstává kanonické: žluté primary tlačítko32px, knihovní labely a input radius.
Šedá28px instance, bold labely a odlišné link/radius metriky ve Figmě nejsou
důvodem pro per-instance CSS. Tyto rozdíly zůstávají výslovně nevyřešené.
Footer registrace používá aktuální text „Přihlaste se“.

Login/registrace volají veřejné portalAuthSession/portalAuthEnrollment kontrakty.
Úspěch vyžaduje čerstvé customer-account admission stejného N1 tenantu.
Ověření e-mailu používá portalAuthRecovery.verifyEmail, jednorázově a bez cookies;
provider callbackURL se zahodí a následuje pevný redirect bez tokenu. Ověřený e-mail
není přihlášení. Pending enrollment může uživatel explicitně obnovit přes resume;
nejistý write ani reconciliation nenabízí opakování zápisu.

Password minimum12 je owner kontrakt, nikoli8znaková Figma fixture. MFA,
verification a reconciliation mají poctivé stavy; dokončení MFA a forgot-password
zatím nejsou implementované. Skutečné N1 přihlášení a registrace čekají na běžící
lokální owner služby a skutečnou serverovou konfiguraci; designová data se nepřebírají.

# Košík a owner quote — aktuální pokračování

Čerstvá read-only Figma session `560fcac5-a660-4370-9fed-3b4e65659547`:
desktop empty `56:636` / body `321:1550`, mobile empty `56:800`, guest summary
`319:1778`. Empty body má desktop1280×424, mobile390×196, padding20/gap16;
max-width a min-height jsou app layout tokeny, nikoli přestylování komponent.

`ProductPurchase` rozlišuje mobilní QuantityField a desktopový kompaktní NumericInput
podle aktuálních rámců `39:2430` a `39:1965`. Obě větve sdílejí quantity draft,
validaci a přidání. Naceněná konkrétní dostupná varianta může uložit jen draft
do vlastního tenant/seller/market/currency košíku. Nejde o potvrzení skladu/ceny.
`CartView` skládá LineItem, Image/NextImage, Link/NextLink, QuantityField,
PriceBlock a TotalsSummary. Jejich appearance řídí kanonické N1 tokeny; žádné
nové komponentové CSS nebo appearance utility na UI-kit komponentách.

Nákupní fixture z Figmy/reference nejsou runtime data. Summary přijímá pouze
aktuální VALID owner částky; doprava/platba zůstává nevybraná a checkout neaktivní.
Globální i variantové owner issues mají lokalizované kódy. Změněný scope obnoví
server přes router.refresh. Neplatné input drafty blokují quote a jsou sladěné
s obnovou storage, změnou množství i odebráním.

Reálná produkční kontrola scope-unavailable větví: CS1440/390/320 a EN390,
plus homepage1440/header cart navigation; všechny screenshoty otevřené.
Bez overflow, console/pageerror/hydration nálezů či business POST. Retry390
vyvolal skutečný nový RSC GET. Logo/vlajky/28×28 cart asset se načítají.
Empty a filled live stavy **nemají vizuální PASS**, dokud nejsou N1 identity/data.
Netlify reference používá cart popover, současný header odkazuje na samostatný
košík; tato interakční parita ještě není implementovaná. Kanonická primary
appearance má přednost před staršími šedými Figma instancemi, jako v auth.

## Header mini panely a mobilní navigace — aktuální přírůstek

Dřívější poznámka o cart odkazu výše je historická. Header nyní skládá
Popover.Trigger/Positioner/Content/Arrow a sdílený skutečný cart/Portal stav.
Rámce:59:1042(empty),59:1074(filled),59:1330(updating),59:1709(login).
Čerstvě prohlédnuté Figma screenshoty a veřejná reference potvrzují mini interakce;
aktuální runtime unavailable/login prošly kontrolou desktop/mobil. Filled/empty
N1 stavy stále čekají na reálný scope.

Mobilní drawer:59:1595/418:2484, přímý CodeConnect Accordion
md/borderless/none418:2491 a sourozenci; app link slot418:2506.
Použitý Dialog left/xs, native kit focus/escape/outside-close; pod headerem
je umístěný wrapperem. Hlubší owner větve jsou VerticalNavigation, nikoli
vnořené Accordiony. Typografie/barvy komponent pochází z N1 tokenů a kit props;
zdokumentované globální Dialog role bindingy vyjadřují současnou drawer roli.
Desktop megamenu59:1743 bylo načtené, zatím není implementované.
