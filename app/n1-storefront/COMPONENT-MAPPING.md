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

Navazující korekce C10:

- Desktop nav `170:2077`: skutečný font16/bold700, veřejné Header.NavItem size=md
  a vlastní existující header-nav weight role. Utility/action row zůstává sm;
  nepřepisuje se globální Button typografie.
- Kategorie `214:3203`: nadpis32, podtržení uvnitř na28; count `214:3240` používá
  skutečný owner total, CS/EN plurály, desktop14/21/gap4/p16 a mobilní „Nalezeno“.
  Pevné textové šířky Figma fixture se nekopírují do lokalizované věty.
- Produkt `219:2758`: desktop nadpis36/podtržení32; mobil32/48 bez připojeného
  názvu varianty v h1. Skutečná varianta má vlastní text i URL výběr.
- Produkt shipping `219:2816/39:2497`: veřejný Link/NextLink na lokalizovanou
  existující dopravu; desktop vpravo od selected-variant, mobil mezi cenou a
  QuantityField. Mobilní medium/AUTO Figma instance nemá vlastní kit typography
  prop; neupravuje se appearance className.
- Podkategorie `214:3208`: veřejný LinkButton md/secondary/outlined je správné CC
  mapování. Figma instance fill-hover/border-secondary/bold se liší od sdílených
  outlined/secondary/medium defaultů. Chybí samostatná navigační role; globální
  změna Button by měnila další ovládání. Tento rozpor zůstává otevřený.

Katalogový strom `214:3169` skládá veřejné TreeView.NodeProvider, Branch,
BranchTrigger/Control/Text/Indicator, BranchContent a Item/Text. Aplikační wrapper
zajišťuje32px řádek; kit nadále vlastní výběr, rozbalení a klávesnici. Existující
role `color-tree-view-bg`, `font-weight-tree-view-label`,
`spacing-tree-view-node-padding` odkazují na fill-hover, bold a dimension-0.
Existující `token-icon-tree-indicator[-open]` používají kit plus/minus. Žádné
vzhledové className/style na komponentách ani nové nečtené knihovní tokeny.

| Oblast / Figma                | Skutečné komponenty                                                                              | Stav / hranice                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Header `33:635/34:915`        | Header vertical/sm; Actions/ActionItem; Button current/unstyled; Image/Link s Next adaptéry      | Tmavé role globálně, menu řídí skutečný state; account/cart/favorites disabled                |
| Search `440:1961/2153`        | SearchSuggestions sm, Label, Image, PriceBlock, LinkButton md/secondary/solid                    | Jediný input; skutečný readonly GET, loading/empty/unavailable; běžná keyboard interakce kitu |
| Hero `33:771/34:954`          | Carousel full/none/none, jeden doložený slide                                                    | Žádné falešné kampaně; controls a indicators používají knihovní theme                         |
| Benefits/promo                | Image s původními samostatnými assety; aplikační layout                                          | Promo bez potvrzeného owner cíle neodkazuje na vymyšlenou kategorii                           |
| Footer `33:1100/34:1255`      | Footer vertical/col/md/sectionFlow col                                                           | Existující sloty, N1 role a layout; žádná kontaktní/copyright tokenová scope                  |
| Home karty `33:877`           | ProductCard featured Name/Image/Stock; PriceBlock; Button nebo LinkButton                        | Samostatné featured tokeny; owner ceny/dostupnost, unknown není in-stock                      |
| Kategorie `214:3151/3202`     | Breadcrumb md, přesný home asset; TreeView md; LinkButton md/secondary/outlined                  | Skutečný strom, podkategorie a předci; cykly se ukončí                                        |
| Kategorie mobil `38:2185`     | ProductCard default, Image/NextImage fill v4:3, Name, PriceBlock, AvailabilityStatus, LinkButton | Původní role padding10/medium16/border1; featured appearance se sem nedědí                    |
| Paginace `214:4488/38:2138`   | Pagination filled, NextLink, createPaginationGetPageUrl                                          | Owner total/page/pageSize; q zachováno; compact při 320                                       |
| Produkt `39:1965/2430`        | Gallery horizontal, LinkButton varianty, PriceBlock, AvailabilityStatus                          | Skutečné owner varianty, URL variantId; key resetuje gallery/množství                         |
| Množství mobil `39:2500`      | QuantityField md, primary/solid/md Button block (44 px)                                          | Owner minimum/unit; sdílený quantity draft s desktopem                                        |
| Množství desktop `219:2820`   | NumericInput md/compact 104 × 36, secondary/solid/md Button compact                              | Minus 28 + input 48 + plus 28; opt-in knihovní density                                        |
| Informace `219:2876/2884`     | Tabs line/md; Code Connect DataTable hideHeader                                                  | Parametry ownera; sorting vypnutý, line mobil / striped desktop; bez falešné size guide       |
| Stavy `57:906/2904/3009/3028` | Skeleton, explicitní output, Button retry                                                        | Skutečný refresh; unavailable není empty ani vymyšlená vyprodanost                            |

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

## Naplněný minikošík — oprava ověřeného rozložení

Figma59:1074/body311:2164, fresh design context2026-11-04. Obsah384px,
obrázek64×64 contain, horizontální NumericInput92px (28+36+28),
odstranění28px a compactsm pokračování. Předešlá Control kompozice
vtěsnala oba triggery dovnitř inputu a vysoký produkt vytáhl obrázek.
Používáme skutečné NumericInput části v layout wrapperech a veřejný
Image.objectFit=contain s NextImage fill v pevném64×64 wrapperu.

Image atom0.57.0 neměl veřejný fit prop; obecný opt-in doplněk stávajícího
pnpm patche zachovává původní default a adapter props, spotřebuje objectFit
před DOM spreadem. Žádný ruční object-fit styl v aplikaci. Je to stejný
fit kontrakt jako již použitý ProductCard.Image. Browser kontrola po buildu:1440px panel384px, mobil390px panel372px
(x8/right380), bez horizontal overflow. Obrázek64×64 contain, trigger28×32,
control36×32, remove28×28, continue28px. Skutečně prohlédnuté screenshoty
filled desktop/mobil a empty mobil; plus mění quantity a native owner quote
4ks=3836CZK (DPH665,75), odebrání vrací empty a focus na nadpis.
Barevnost/typografie zůstává canonicalN1; jiné datové texty a chybějící
finální checkout nejsou prohlášené za pixelovou paritu celého návrhu.

## Doprava a platby — informace z backendu

Figma desktop 51:1020/51:1255, body 370:3467/370:3758 a mobil
51:1174/51:1404, načteno 2026-11-04. Kompozice článku používá app layout
wrapper s paddingem 40px, maximem 1200px a podtržením nadpisu 96×4px.
Kit Button a Link používají veřejné props a canonical N1 tokeny.

Informace se čtou přes aktuální locale market a merchandise records
storefrontCheckout. Vyžaduje se configured market se shodným ID; chybějící
checkout nebo neplatné sazby vedou do unavailable stavu. Částky a měna
pocházejí z ownera, bez dalšího přepočtu DPH či kurzu. Dotaz nečte produkty.
Figma ukázkové sazby a ParcelShop nejsou nabídka backendu. Lokální owner
vrací PPL 129 Kč a Českou poštu 119 Kč; paymentAvailable=false znamená
pravdivý stav nedostupných plateb, nikoli GoPay/dobírku z návrhu.

Browser kontrola produkčního buildu na /cs/doprava a /cs/platba:
1440×1000 a 390×844, prohlédnuté screenshoty obou stránek; bez horizontal
overflow. Vnitřní šířka nadpisu 1120/310px, mobilní x=40px, výška 32px.
Automatické ověření zahrnuje skutečný market query, měnu, nulovou cenu,
prázdnou nabídku i odmítnutí neplatného scope/sazeb. Toto jsou informační
stránky; dokončení objednávky a zprovoznění plateb zůstávají samostatné.

## Guest checkout a potvrzení objednávky — C7

Figma session `29658e25-06ad-415c-a929-b9b88d7db11f`: desktop checkout
`44:1226`, body `319:1734`; mobil `44:2285`, body `319:1955`. Potvrzení
desktop `55:1948`/body `372:3125`, mobil `55:2309`/body `372:3356`.
Checkout používá max1280, padding20, dvě stejné kolony s gap32 od md; na mobilu
jednu kolonu. Panely mají p16/gap16, párová pole gap12. FormInput md a
Select lg vycházejí z Code Connect, doprava RadioCard sm/outline, akce Button md,
stav objednávky Badge info/md. Potvrzení má max768 panely a na mobilu stav pod
nadpisem. Knihovní komponenty nemají vzhledové className ani inline style.

Neutral shipping choice z Figmy používá veřejné RadioCard tokenové role
`border-secondary`, `fg-secondary` a `fill-overlay`; nemá vlastní barvy nebo CSS
třídy. Tyto globální vazby jsou v `src/tokens/storefront.css`.

Schválená odchylka: firma, druhý řádek adresy a kraj nejsou zobrazené, protože je
nativní adresa neumí uložit. Uživatel 2026-11-04 výslovně zvolil jejich vynechání.
Dopravci/ceny/země pocházejí z ownera, nikoli z fixture; online platba ani
potvrzení o odeslání e-mailu se nepředstírají. Souhrn zobrazuje owner celkové DPH;
řádek ceny bez DPH proto zahrnuje i dopravu. První tlačítko ověří úplný quote,
až druhé potvrzuje objednávku. Obnova používá stabilní nonce a veřejný read.
Guest potvrzení neodkazuje na neimplementované zákaznické objednávky.

## C8 — zákaznický účet

Profil54:1417/54:1629: max1024,p16,gap16; desktop navigace vlevo,
mobil vodorovná. Tabs default/sm řídí skutečné peer panely. FormInput md,
Button primary/solid/md, logoutsm; celý displayName je jedno pole, kontaktní
email readonly. Owner nemá strukturované jméno/příjmení.

Own orders54:2060/54:2241: semantic Table desktop, source-composition
mobile cards p12/gap12, Badge info/md, LinkButton primary/solid/md.
Detail55:2509: max1024,p16 mobile/p32 desktop, 3-column ProductCard grid
a 2-column information cards. Ceny jsou native uložené částky/měny.
Chybějící obrázek, line total nebo celková útrata se nevymýšlí; jednotková
cena je výslovně tak označená. Zbývající design/owner mezery nejsou
považované za hotový vizuální přenos všech stavů.
