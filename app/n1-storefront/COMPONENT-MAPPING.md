# N1 — aktuální komponentové a tokenové mapování

Cena / Figma39:2031 a57:2918: veřejný `PriceBlock state="known"`, explicitní
owner částka a jen skutečný paired net caption vybrané varianty/leaf produktu.
Počet velikostí není podklad pro `state="from"` ani lokalizovaný prefix „od“.
Historický N1 formatter není autorita pro výběr ceny: bral první variantu, nikoli
minimum. Stávající owner monetary projection se touto prezentační opravou nemění.

Karty / Figma214:3250: skutečné první3velikosti → `LinkButton`
sm/tertiary/outlined/compact; native wrapper flex/center/gap1(4px), následně
`+N` dle owner total−3. Native preview dodává stabilní veřejné variant IDs,
názvy a total; při absenci se velikosti ani počet nevymýšlejí. Kliknutí vede na
reálný detail produktu jako historická card navigace. Žádné appearance classes
nebo inline styly na komponentách. BE projekce schválená uživatelem; hover/focus
expansion používá veřejný Popover a živý market-scoped reader. Dne6.11. ověřeno
rozbalení `+N` se skutečnými velikostmi i přechod na správné vlastní variant ID.

Autorita vzhledových tokenů: [New Design System / Theme / N1](https://www.figma.com/design/gi5GUSWwAeXknaKEeLqK5w/New-Design-System?node-id=2667-2),
447 proměnných, mode `4082:0`, čtecí session `0397b40e-b436-4ebb-bf27-114466df5aa0`.
Autorita API: skutečně instalovaný `@techsio/ui-kit`. Storefrontová Figma určuje
kompozici a instance, nikoliv náhradní paletu nebo oprávnění přestylovat knihovnu.

## Tokenová kaskáda

1. Veřejný `@techsio/ui-kit/tokens-with-tailwind` registruje tokeny a komponentové aliasy.
2. Generovaný `tokens/figma/n1.css` aktivuje pouze kanonických 447 proměnných na
   `html[data-theme="n1"]`. Všechny názvy již kit registruje; není druhá ruční kopie.
3. `tokens/storefront.css` jednou propojí existující Header/Footer sloty s N1 tmavými
   rolemi. Tyto organismy nemají tone prop. Další doložené komponentové role používají
   existující N1 aliasy; nepřepisuje se primitivní paleta ani typografická/rozměrová škála.
4. `globals.css` obsahuje importy, content registration a layout metadata pro wrappery.
   V 0.57.0 je explicitní `@source` nutné: novější referenční skill popisuje už opravený
   balíček, instalovaný CSS entrypoint tuto registraci ještě neobsahuje.

Žádná `n1-*-tokens` třída, vzhledové JSX přepisy ani místní kopie komponentového
defaultu. Legacy `--color-primary` není jediný zdroj: Button čte moderní bg role
a oba on-primary foregroundy. Mobile input floor 16 px zůstává knihovní.
Původní 418-tokenový mix komponentových snapshotů a App overrides byl nahrazen.

## Kompozice

Hlavička `39:2395`, actions `208:2267`: čtyři nativní ovládací prvky mají
mezeru12, nikoli výchozích16. Existující role `spacing-header-actions-sm`
odkazuje na kanonickou `dimension-12`, aby se mobilní logo nemuselo zmenšovat.
Velikosti ovládacích prvků zůstávají knihovní. Zalamování obchodních podmínek
a e-mail pod ikonou odpovídají mobilnímu návrhu; neopravují se CSS výjimkou.

Mini košík `311:2490` skládá dvě nativní akce do vlastního layout wrapperu gap12;
vnější panel si zachovává gap16. Před souhrnem je samostatný1px oddělovač
`311:2475` v roli border-secondary. Quote běží automaticky na pozadí; běžné
pending/success stavy ani uložené jednotkové ceny nedostávají technické popisky.
Skutečné chyby, neplatné množství a změny cen zůstávají akčními stavy. Checkout
je stále podmíněný aktuálním platným owner quote.

Desktopová dostupnost PDP `39:2022` zachovává `AvailabilityStatus` bez ikony.
Její label používá kanonické18px/bold tokeny jen v desktopovém wrapperu;
mobilní dostupnost se nemění. Podtržení návrhu nemá v aktuálním kitu prop/token.

Množství PDP `61:1377` používá skutečný `NumericInput` s `density="compact"`
a `size="md"`: celek104px, ovladače28px, střed48px, výška36px. Desktopový
wrapper váže vlastní trigger-bg na kanonické neutral300. Sdílený patch opravuje
spotřebu existujících NumericInput barevných rolí; průhledný výchozí stav
zachovává dosavadní vykreslení ostatních skladeb bez zdvojení alpha výplně.
Mobilní `39:2500` zůstává `QuantityField` md mimo tuto barevnou výjimku.
Limity, klávesnice, validace a focus zůstávají v Zag komponentě a aplikaci.

Produktové sdílení `219:2870/2873`, mobil `39:2540`: veřejný `Link` a dekorativní
`Icon` email-outline. Akce připraví mailto návrh v klientovi návštěvníka s názvem
a veřejným odkazem na konkrétní produkt/platně vybranou variantu. Figma ani starý
ProductActions handler neurčují; mailto je minimální funkční interpretace tohoto
odkazu, nikoli kopie existujícího serverového rozesílání. Žádný nový dialog.
Odkaz používá aktuální origin a pouze řízený product/variant path, bez ostatních
query/hash hodnot. Před hydratací je neaktivní, server veřejný origin nehádá.
Mobilní akce se skládají pod sebe s gap24, desktop do řádku s gap16.
Favourites/watch a známé Link appearance/selected-border mezery tím uzavřené nejsou.
Prázdný layout wrapper popisu nemá padding, pokud owner nevrátí žádné odstavce;
neprázdný popis zůstává viditelný i při přepnutí tabů jako historická kompozice.

Doprava checkoutu `319:1756/1977` používá
existující RadioCard sm role: control padding12, content gap8 a popis text-sm14.
Žádné appearance className na knihovních komponentách nebo nové velikostní props.

Mobilní submit checkoutu `319:2032` zachovává Button md/primary/solid a dvě
stejně široké akce. Uživatel schválil kratší copy „Objednat“ místo dlouhého
„Potvrdit objednávku“, které se s kanonickou typografií a paddingem nevešlo.
Přechod ověření zpět do idle vrací focus na povolený submit pouze z body,
pokud odeslání začalo ve stejné form; jiný aktivní prvek se nepřepisuje.

Celý košík ověřuje aktuální platný výběr automaticky stejnou nativní dry-run cestou
jako mini košík. Storage error, chybějící scope a neplatné množství request blokují.
Změnu ceny nadále výslovně přijímá zákazník; unavailable stav zachovává ruční retry.
Aktuální VALID výsledek zpřístupní checkout bez dalšího potvrzování již ověřených cen.
Samotné ověření nevytváří objednávku ani skladový pohyb.

C12 recovery používá aktuálně znovu načtený auth vzor `333:4671`: FormInput md,
Button primary/solid/sm/compact, Link a StatusText; desktop auth šířka448,
mobilní vnější gutter16 a gap formuláře4. Samostatný recovery Figma frame není
předaný, takže jde o rozšíření existující auth kompozice, nikoli tvrzení1:1
nového návrhu. Žádné nové theme/token/CSS appearance overrides. Token se do
komponenty nepředává; SSR poskytuje pouze boolean přítomnosti cookie.

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

## C15 — doplnění UX tam, kde není Figma stav

Uživatelem určená historická reference `herbatika-shop/apps/n1` doplňuje
interakční záměr, nikoli současnou architekturu nebo styling. Pro add-to-cart
byly přečteny `src/hooks/use-toast.tsx` a
`src/components/product-detail/product-info-panel/add-to-cart-section.tsx`:
krátké success/error oznámení podle výsledku, produkt a množství v popisu.

Současný přenos: `@techsio/ui-kit/molecules/toast` → jeden `Toaster` v shellu
(lokalizované label/closeLabel/loadingLabel), `useToast().create` po výsledku
`cart.add`, délka10000ms pro přečtení názvu a varianty a dostupné ruční zavření.
Kanonické N1 toast tokeny řídí vzhled;
žádné vzhledové className, inline Tailwind nebo vlastní notifikační komponenty.
Inline post-add odkaz Košík odstraněn. Nákupní guardy a varování u polí zůstávají;
uložení výběru neznamená ověřenou cenu, sklad ani vytvořenou objednávku.

## C16 — doložené nákupní stavy produktu

Reference: čerstvé Figma podstromy desktop219:2768, mobile57:2916
(bez varianty), mobile57:2965 (vyprodáno), numeric61:1377 a QuantityField39:2500.
Historický `herbatika-shop/apps/n1/src/components/product-detail/` doplňuje
interakci: `product-info-panel.tsx` vykresluje bez varianty pouze disabled CTA;
`product-info-panel/add-to-cart-section.tsx` po úspěchu ukazuje toast a resetuje
množství. Současný reset používá skutečné minimum, nikoli hardcoded1.

Bez varianty: Button primary/solid/md disabled, mobil block, bez NumericInput
a bez dalšího selection odstavce. AvailabilityStatus zachovává pravdivé unknown,
netvrdí probíhající síťové ověření. Vyprodaný mobil: stejný disabled Button
s překladem Vyprodáno, bez QuantityField; desktop quantity zůstává, protože
mobile state crop nedokládá desktopovou kompozici. Dostupný produkt: dosavadní
NumericInput/QuantityField a toast, bez default cart/quote disclaimeru v PDP.

Kanonické N1 tokeny a veřejné kit props zůstávají autoritou vzhledu. Žádný nový
inline Košík odkaz ani automatické otevírání minikošíku: legacy dispatch
open-cart nemá v referenční aplikaci doložený listener. Storage/scope chyby se
nezaměňují za sold-out. Celý PDP dosud nemá úplnou vizuální shodu; zejména
manufacturer, net tax, stock count/ETA a related potřebují skutečné owner údaje.

Desktopový wrapper: metadata31:640/39:1965 dávají při1440px vnější1280,
boční padding16, vnitřní1248 a sloupce448+32+768. Historický PDP `page.tsx`
rovněž používá container s p400=16px. Odstraněn pouze md:px-0 na article;
existující p4 zůstává i na desktopu. Centrování v runtime počítá s reálnou
šířkou viewportu bez svislého scrollbaru. Mobilní wrapper se nemění.

## C17 — skutečná PDP data a doložená kompozice

PDP39:1965/39:2430: veřejný full Merchandise read již obsahuje leaf stock,
base net a explicitní gross/net price tiers. Lokální decoder je zachovává;
ProductDetailModel a varianty přenášejí nullable stockQuantity/net. Výběr
varianty přepíná obě hodnoty, group parent je neukazuje ani při chybějícím
summary. Unknown/untracked není0. Net se páruje se zobrazeným owner gross;
nejednoznačné tiers se vynechají, žádné dopočítání21% ani druhý FX převod.

PriceBlock.taxLabel a AvailabilityStatus.label používají tyto skutečné údaje.
Card/quote/cart amount zůstává owner gross. Popis39:2187/2547 je samostatně
za Tabs.List a přetrvá při přepnutí panelů. Parametry219:2882 mají pouze na
desktopu vlastní18/28 bold H2, přes native app text role nad dimension18.
Missing guide61:1716 má title24/36 semibold, p16/gap24 a pravdivý unavailable
text. Tabs md content padding se váže na dimension0; účet používá size sm.
Gallery219:2762/2763 má na desktopu oba gapy4 přes existující globální role;
mobilní Gallery39:2455 zachovává kit defaults. Žádný crop podle fixture média.

Search63:1548 používá relative48×48 wrapper a Image asNextImage fill/contain
se sizes48px. Home31:637/171:2227 skládá cenu a CTA pod sebe, desktop ponechává
řadu. Jde o app layout wrappery a podporované props, nikoli appearance třídy
na kit komponentách. Kanonický N1 export zůstává beze změny.

Selectedvariant stockcorner a responsive Availability typografie mají nadále
veřejný kit kontrakt gap. Výrobce/sizeguide URL/related
nejsou vytvářené z fixture, jména, SKU ani náhodného katalogového výběru.

C17 striped řádky219:2885/2892 vážou existující DataTable primary/secondary
role na canonical neutral300/fill-hover. Palette se nemění.

C20 řeší desktop Tabs219:2876/223:2174 přes token-only Tailwind utilitu
`md:n1-product-tabs` na existujícím wrapperu `Tabs.List`: neutral200, base-dark,
dimension36, padding trigger-sm a nulová základní linka. Sdílený height role
kit0.57 je přesměrovaný pouze uvnitř tohoto seznamu, nikoli v N1 theme nebo
na nákupním NumericInput. Account ani mobil tento scope nemají.

Desktopový wrapper parametrů219:2885 používá `n1-product-parameters`, který
váže skutečný Table token `--text-table-sm` na canonical `--text-md`.
DataTable předává velikost do Table; mobilní tabulka je mimo tento wrapper.
Pozorovaná výška řádku je nyní36 vs cílových37; přesnou geometrickou shodu
nepotvrzujeme a nedoplňujeme ji nahodilou pevnou výškou.
