# N1 — aktuální komponentové a tokenové mapování

## Cílené převody podle Figmy — 2026-11-09

- Home171:2215/2047: slot nadpisu má na layout wrapperu šířku186px na
  mobilu a240px od md. Footer34:1258/35:1131 vyplňuje mobilní sloupec;
  desktop zachovává limit322px a veřejný Image/NextImage adaptér.
- Účet54:1417/1629: nativní Tabs sm a Button secondary/solid. Neinteraktivní
  wrapper uvnitř Tabs.List skládá skutečné triggery s gap2px; jejich klávesnici,
  focus a výběr dál vlastní kit. Navigace je horizontální na mobilu a vertikální
  od md. Rozměry triggerů zůstávají přirozené podle lokalizovaného textu.
  `n1-account-navigation` mění pouze veřejné padding tokeny v tomto rozsahu
  (trigger x6, logout x8). Nativní sm panel má padding0/8/8/8; PDP používá md.
  Save button je mimo navigační scope. Profil stále používá jediné owner displayName;
  samostatné firstName/lastName se z něj nevyrábějí.
- Detail objednávky55:2509/2784: mobilní status pod nadpisem, padding x32/y16
  a od md y32. Zpětná navigace používá kit Link/NextLink a Icon. Nadpis má dlouhé
  datum, metadata zachovávají čas. Souhrn ukazuje uložený název dopravy, pokud
  existuje; částky, měna a dostupná pole dál pocházejí z nativního DTO. Chybějící
  obrázky nebo řádkové součty se neodvozují z aktuálního katalogu.
- Doprava51:1020/1174 a platba51:1255/1404 nepřebírají generické minimum výšky
  shellu. Článek zachovává vlastní desktop minimum424px a mobilní padding40px.
- Našeptávání63:1566 používá přesný loading text „Vyhledávám...“; stávající
  nativní SearchSuggestions a oddělený unavailable text zůstávají zachované.

Tyto změny mají dílčí vizuální review. Neznamenají schválení celých stránek,
úspěšné živé přihlášení nebo podporu všech schopností z Figma fixtures.

## Načítání a chyba kategorie — 2026-11-09

Figma57:906/937 rezervuje220px pro média, ale samotný Skeleton.Rectangle
má320×80px. Layout wrappery rezervaci zachovávají a omezují skutečný placeholder
na dostupnou šířku, maximálně320px. Tři samostatné Skeleton.Text noOfLines1
navazují s gap24px a plnou šířkou stejného slotu podle57:2892/2896/2900.
Rychlost i barvu poskytuje původní Skeleton kontext a nativní default.
Nepřidává se vlastní skeleton CSS ani vzhledová třída na kit komponenty.

Figma57:2906 má samostatný kategoriový chybový text, proto používá nový CS/EN
categoryLoadFailed. Globální unavailableDescription jiných čtení se nemění.
Retry zůstává Button primary/solid/md podle57:2907/3031, kde je skutečně žlutý44px.
Produktové PriceBlock/AvailabilityStatus pending a disabled loading Button
zůstávají beze změny. Obecný pravdivý nadpis nenahrazuje fixture název kategorie
nebo produktu, který loading/error kontrakt neposkytuje.

Mobilní kategorie / Figma31:639: stávající Button secondary/outlined/md a kit
TreeView zůstávají. Po otevření se zaměří jeho existující `[role=treeitem]`
roving tab stop pouze uvnitř daného aside. Kit dále vlastní šipky a selekci;
žádné CSS, nové ovladače, tokenové override nebo převzetí desktop fokusu.

Neplatný/neuložený quantity draft: `QuantityField.error` v řádku košíku a
`NumericInput` s navázaným feedback ID v mini košíku zůstávají konkrétním
zdrojem chyby. `CartQuoteFeedback` pro tyto stavy nepřidává obecné shrnutí.
Nezměněné komponenty, vzhled, tokeny, quote request i checkout gate.

Košík/minikošík: jediný stávající CartQuoteFeedback skládá aktuální obecné a
owner globální chyby, deduplikuje podle výsledného překladu a zachovává chyby
položek v jejich řádcích. Nedostupný checkout používá již existující CS/EN
checkout text. Nativní output má jen layoutové block; žádné kit appearance,
CSS/token, cena, API ani guard se nepřepisují. Error fixtures jsou pouze QA,
nikoli runtime implementace nebo živý důkaz objednávky.

Auth chyby / Figma56:883: stávající FormInput validateStatus/helpText zachované,
focus jde na první neplatné pole pouze vlastního formuláře. Při pointer přechodu
na jeho submit se chybový obsah nevloží před dokončením kliknutí; nativní
invalid/submit stejnou chybu zpracují. Vzhled ani tokeny se nepřepisují.

Registrace / Figma333:6888, confirmation333:7202 + feedback333:7210:
existující FormInput validateStatus/helpText dostává platnou shodu při onChange.
Native FormCheckbox ani vzhled se nemění; jeho řádek se při prvním kliknutí
po platném potvrzení neposune. Fresh fullframe43:1026/333:5536 má proti valid
fixture jiný padding; stávající full-page wrapper zůstává zachovaný.

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
Aktuální leaf instance214:3276/3283/3290 mají28px a12/18 regular text,
fill-hover a border-primary. Existující `n1-card-variants` role scope na obou
layout skupinách váže skutečné Button tokeny; portalled popup neztrácí kaskádu.
Compact výška a padding zůstávají nativní. Fixní šířky textů Figma fixture
nejsou podklad pro změnu paddingu ani pro pevné šířky reálných velikostí.

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

Krátké výsledky formulářových akcí: jediný globální Toaster v shellu a nativní
useToast, stejně jako u vložení do košíku. Kontakt43:1162/1595 a profil54:1417/1629
nemají ve Figmě samostatné inline success potvrzení. Společná čistá projekce
action-feedback rozlišuje potvrzené sent/saved od pending a trvalých chyb.
Toast vzniká pouze ve stávajícím potvrzovacím callbacku, nikoli při renderu,
mountu, focus readu nebo router refreshi. Používá existující CS/EN texty a kit
tokeny; žádná další notifikační vrstva, provider nebo vlastní alert styly.

Pending zůstává v nativním loading tlačítku; status output jej neopakuje.
Kontakt po potvrzení zachovává sent lock i durable barrier pravidla, profil
zachovává mounted guard/version CAS/needsRead. Validační, forbidden/unavailable
a především unconfirmed stavy zůstávají dostupné u formuláře. aria-describedby
neodkazuje na skrytý success/pending output. Figma auth chyby a pokyny k e-mailu,
recovery terminal instrukce a potvrzení objednávky se nemění na mizící toast.
Adresy jsou aktuálně read-only; nepředstírá se toast pro neexistující save akci.

Checkout44:1226/44:1687 zachovává nativní FormInput md a Code Connect Select lg.
Výslovný výběr uložené adresy je navazující kompozice tohoto Selectu podle
historického N1 billing-address-section/address-picker, které uživatel určil
jako UX referenci pro chybějící Figma stavy. Objeví se jen při skutečných
uložených položkách přijatého účtu a nic nevybírá automaticky. Zkopíruje pouze
čtyři podporovaná poštovní pole; kontakty nezmění a kopie zůstává editovatelná.
Nevhodné položky zachová nevolitelné s úplným lokalizovaným důvodem.
Guest poznámka pouze odkazuje na přihlášení pro použití adres; neslibuje zápis.

Dlouhý seznam má doloženou veřejnou API mezeru instalovaného Selectu:
deklarované positioning se v runtime nepředává Zag. Návrh opravy má jen dvě
předání této hodnoty a N1 by pak použilo sameWidth; nevyžaduje nový token,
zkracování adres ani appearance CSS. Sdílený patch není zatím aplikovaný,
proto rozbalený selector nemá produkční vizuální GO. Ostatní country instance
by měly zachovat výchozí positioning. Funkční a testovací hranice jsou ve
VALIDATION.md; izolovaný harness není runtime náhrada účtu nebo backendu.

MFA completion rozšiřuje stávající AuthContent. Fresh metadata celé Figma
stránky42:635/50:635/56:635 neukazují samostatný MFA rámec; login333:4672
byl znovu načtený jako kompoziční reference FormInput md, Button sm a Link.
Nejde o tvrzení pixelové shody s existující MFA předlohou. Nabízené metody
jsou nativní Button ve fieldset/legend, kód FormInput s one-time-code autocomplete
a skutečnými nativními mezemi1–32/isTrimmed. Nevyžaduje se šest číslic.
Kód se neukládá do React ani trvalého stavu a po odeslání se vyprázdní.

Potvrzené odeslání OTP používá jediný globální Toaster. Změna zobrazeného auth stavu,
mount nebo safe GET samy toast nevytvářejí. Odmítnutý/neplatný kód má právě
jeden FormInput error text; vypršení, throttle a ostatní trvalé stavy zůstávají
oddělené. Throttle bez nativního času nedostává odpočet. Pending zakazuje
současné akce a označuje formulář aria-busy. Žádná nová komponentová definice,
CSS, appearance class na kitu, paleta nebo obecné nastavení knihovny nevzniklo.

Mobilní navigace59:1595/418:2491: existující Dialog left/xs s Accordion
md/borderless a VerticalNavigation.Link pro skutečné větve ownera. Drawer se
kotví podle skutečného spodního okraje Headeru přes veřejný ref; počáteční
useLayoutEffect a ResizeObserver hlavičky i body mají cleanup; body zachytí
také změnu výšky oznámení nad shellem. Dialog nadále zamyká scroll pozadí.
Dynamický top je pouze geometrie existujícího aplikačního wrapperu, nikoli
inline vzhled knihovní komponenty. Statický součet nezahrnoval demo lištu
ani zalomení utility odkazu a překrýval logo. Vzhled používá doložené role:
průhledné plochy Accordionu nad šedým Dialogem, N1 border-secondary,
8/16 padding titulu, icon-right8 a child-x24 v Content0 s list gap0.
Obsah418:2506 má pouze skutečné childlinks; opakovaný parent Link navíc byl
odstraněn podle Figmy i historického mobile-menu71–86. Historický parent Link
v titulku se nevkládá do nativního buttonu. News/root leaf jsou nativní
LinkButton current/unstyled/secondary se stejnou heading rolí600.
Native Button font role je skutečně spotřebovaná i u Accordion.Header:
root nav scope400, existující heading scope600; původní accordion weight
v shipped cascade přebíjí font-button, proto se neuvádí neúčinný override.

Figma59:1595 /418:2412/2620 má zavírání v headeru. Tentýž Button proto při
otevření používá existující `token-icon-close` (mdi:close) a `closeMenu`, při
zavření `token-icon-menu` a základní název kategorií. Nativní Dialog dostává
`modal=false`, `trapFocus=false`, `preventScroll=true` a `hideCloseButton`:
header zůstává dostupný a nepřibývá druhé nepodložené X uvnitř draweru.
Shipped `behavior` vybírá pouze vzhledové varianty; zůstává jeho dosavadní
výchozí N1 backdrop. Nativní machine samostatně řídí modalitu, scroll a focus.

Kit0.57 nabízí jen `customTrigger`, nikoli compound Dialog.Trigger nebo
onInteractOutside/persistentElements. Externí řízený Button proto zachovává
stejnou veřejnou Zag anatomii jako getTriggerProps: data-scope=dialog,
data-part=trigger a data-ownedby se stejným Dialog id. Native dismissable
layer tak trigger vyloučí z outside-close a native return-focus jej dohledá.
Nepoužívá se hádané vnitřní DOM id ani vlastní document listener. Při otevření
je geometrický wrapper pointer-active pro nativní backdrop; při zavření
pointer-transparent. Knihovní content/positioner pointer chování se nepřepisuje.

Root řádek zůstává40px proti Figma38, child36 proti34 kvůli kanonické24px lince. Separátory borderless
Accordionu nemají přímou slot roli; nový CSS border se nevyrábí. Skutečný strom,
child destinations a další původní demo větve zůstávají, počet není Figma fixture.

Hledání63:1548/438:1947: nativní SearchSuggestions uvnitř existujícího formu,
48px datové obrázky a resultSlot s PriceBlock. Výsledkový scope váže skutečné
popup role na viewport0, item-y-sm6 a indicator0; native x8 už odpovídá.
Navigační položky nepotřebují prostor pro checked indikátor. Loading/empty
zachovávají nativní rozestupy: stejné role zároveň řídí status, GroupLabel
i Footer a neexistuje samostatný footer padding. Popup border438:1917 vede
přes alias search-suggestions/fg na Theme/N1 fg-primary; stejně tak footer.
Obě existující spotřebovávané role jsou navázané pouze v search scope.
Dotaz se v prázdném textu63:1583 interpoluje jako text,
nikoli HTML nebo náhradní vyhledávací pravidlo. Skutečný owner počet zůstává.

Dedikované search-suggestions/light vazby13px/modré nadpisy a15px ceny nemají
v aktuálním N1 exportu protějšek; neřeší se nejbližší barvou či novým primitivem.
React key warning je uvnitř knihovního Combobox group renderu, nikoli resultSlotu.
Značky vyžadují vlastní veřejný kontrakt a skutečný filtr; nejsou odvozené z prvních
osmi produktů ani z textového parametru Značka v detailu.

Kontaktní formulář369:2827 skládá FormInput md, FormTextarea md a Button
md/secondary/solid. FormTextarea používá nativní Label a Textarea podle
371:3088/3089/3092, bez ručního duplikování. Scope na existujícím fieldsetu
váže text-label-md na text-sm: labely43:1645 a371:3089 jsou výslovně
Theme/N1 14px. Vstupy zůstávají44px a jejich mobilní text16px. Figma radius8
je z Light kolekce; kanonický N1 radius se nemění. Native řádek labelu21px
proti Figma20px nemá samostatnou spotřebovávanou roli a zůstává přiznaný.

Strom kategorií214:3169/3175 používá nativní TreeView: šedéfill-hover pozadí,
16px text a32px vnější řádky, pravé plus/minus přes existující ikonové role.
Desktopový tokenový scope přímo na TreeView váže spotřebovávaný
text-icon-control-md na dimension-14. Nepoužitý tree-view-indicator-md token
se nenastavuje; mobil a ostatní ovladače zůstávají nativní. Klávesnice a
rozbalování zůstávají v Zag. Prázdný katalog57:897/900 používá stávající
LinkButton md/secondary/outlined se skutečným návratem na lokalizovanou homepage
a textem „Zpět na hlavní stránku“; dostupnost owneru se dál odlišuje od prázdna.

Podkategorie214:3208/3214: veřejný LinkButton md/secondary/outlined v existujícím
čtyřsloupcovém desktop gridu s gap4. Desktopový scope váže skutečné Button
role na fill-hover, border-secondary/1px, radius-none a text-sm/bold. Výška44
a nativní padding zůstávají. Mobil38:2150/2156 tento scope neaktivuje;
zachovává transparentní outlined2px, text-md/medium a kanonický N1 radius.
Skutečné názvy, počty a pořadí kategorií určuje owner, nikoli Figma fixture.

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

Povrch panelů minikošíku311:2331/2164 a přihlášení333:7435 je explicitní
Theme/N1 white/base. Token-only scope přímo na nativním Popover.Content váže
color-popover-bg a color-popover-arrow na color-base. Existující Zag bridge
arrow-background se musí ve stejném scope znovu vyhodnotit; zděděná root hodnota
už je vypočtená na fill-overlay. Žádná změna globálního Popover theme, popupu
velikostí ani menu. Rozměry, focus a autentizační/quote chování se nemění.

Souhrnné ceny311:2200/2487 a319:1800 nevyžadují rozšíření API kitu.
Nativní TotalsSummary už spotřebovává text-totals-summary-total-size a
font-weight-totals-summary-total. MiniCartTotals váže pouze velikost na text-sm;
jeho výchozí semibold600 odpovídá. Existující souhrnná sekce ReadyCheckout
váže text-md a bold700. Sdílený CheckoutTotals, potvrzení objednávky, hlavní
košík a detail objednávky tento scope nedostávají. Mini řádek dědí20px namísto
Figma19.6px; neexistující line-height token ani vzhledový wrapper se nepřidává.

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
  mapování. Doložený desktopový rozdíl fill-hover/border-secondary/bold je
  vyřešený responzivním scope šesti existujících Button rolí popsaným výše;
  sdílené defaulty a mobil se nemění. Mobilní Figma radius8 je navázaný na
  button/Light kolekci, nikoli Theme/N1; zachováváme kanonický N1 radius2.

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

Theme zůstává kanonické: primary/solid/sm/compact tlačítko28px, knihovní labely
a input radius. Kontrola6.11. potvrzuje labely FormInput700. Šedá login instance
333:6597 má navzdory deklarovanému primary výplň Light/secondary; není podklad
pro přepsání N1 primary. Tučný label FormCheckbox nemá v instalované komponentě
spotřebovávanou váhovou roli; nepřidává se náhradní vzhledové CSS.
Mobilní celé stránky mají formulář FILL bez bočního paddingu; samostatné chybové
fixtures56:883/978 mají16px. Izolovaný stav nemění rozložení celé stránky.
Footer registrace používá aktuální text „Přihlaste se“.

Login/registrace volají veřejné portalAuthSession/portalAuthEnrollment kontrakty.
Úspěch vyžaduje čerstvé customer-account admission stejného N1 tenantu.
Ověření e-mailu používá portalAuthRecovery.verifyEmail, jednorázově a bez cookies;
provider callbackURL se zahodí a následuje pevný redirect bez tokenu. Ověřený e-mail
není přihlášení. Pending enrollment může uživatel explicitně obnovit přes resume;
nejistý write ani reconciliation nenabízí opakování zápisu.

Password minimum12 je owner kontrakt, nikoli8znaková Figma fixture; jména vyžadují
neprázdný znak, nikoli dva znaky z fixture. E-mail má při blur i nativní pattern
shodný s Portal doménovým pravidlem. Změna původního hesla zneplatní starý stav
potvrzení; rovnost se znovu kontroluje při blur potvrzení a před odesláním.
Obnova hesla je implementovaná přes veřejný owner kontrakt; dokončení MFA zůstává
samostatná mezera. Storefront je napojený na sdílený Stage. Živé dokončení
registrace/e-mailu/přihlášení ještě není prokázané, konkrétní403 vyžaduje dohledání
vlastníkem Stage. Klientské validační kontroly nejsou důkazem zákaznického admission.

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

### Checkout field errors after blur

Fresh Figma `323:1813`, field compositions `324:1700`, `324:1714` and
`324:1708`: keep the connected FormInput md and a sibling StatusText sm/error
with its supported icon. A plain layout wrapper supplies the source 4px gap;
no appearance classes or styles are passed to either kit component. The
stable error id is linked through FormInput aria-describedby, and its native
validateStatus supplies aria-invalid. Editing clears both the message and
association; blur and native invalid events recompute them.

Required/blank first name and invalid email use the exact Czech design copy
and an English translation. Email also requires the dotted domain already
required by the public checkout schema. Other errors retain the generic
validation message. Figma's postal example `123` conflicts with the native
address contract (trimmed length 3–12); this slice preserves that contract
for every market country rather than adding a Czech-only admission rule or
misleading format message. The postal fixture is an unresolved design/contract
difference, not a fully reproduced state. No schema, country, shipping or order
write behavior changes.

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

### Desktop category panel — 59:1743 / 418:2368

`DesktopCategoryNavigation` composes installed Header, Link/NextLink, Image/NextImage
and the public multi-trigger Popover.Context API. The Figma layer name
`Dialog.Content` is not a Code Connect binding to the installed non-compound
Dialog. A full-width native Anchor/Positioner/Content provides modeless
dismissal. ArrowDown opens and focuses the first child; Escape restores the
root link, while pointer-only closure and switching to login/cart preserve
the destination's focus. Normal click/Enter still navigate to the real href.

The owner supplies all root/direct-child categories and their ordering. The
current Pánské branch contains ten children, so it has two rows rather than
the five-item fixture's single row; no demo categories are hidden to match
the fixture. Fifty exact static navigation illustrations across all eight roots are documented under
`public/navigation/README.md`; no product photo is used as a substitute.
The six-column wrapper and 96px image slots are composition. The scoped
`n1-category-menu` utility aliases existing Popover surface/border/padding
roles to canonical white/border-secondary/dimension18, leaving login/cart
and mobile navigation unchanged.

Active state419:3253 uses the existing Header background/hover-background and
active/hover foreground roles through the token-only
`n1-category-menu-active` configuration on the existing NavItem. They reference canonical primary Button surface
and foreground aliases. The native `active` prop remains responsible for
state, with no appearance class on the kit component. The earlier conclusion
that this required a shared kit change was incorrect: its existing base
surface role is sufficient. Scoped native padding18/10 gives the60px desktop
item height without changing header actions or mobile navigation.

NextImage `fill` inside relative96×96 wrappers preserves proportions for all
source dimensions, including19×100 artwork. All root/child destinations and
their ordering remain owner data, including13 original demo text-only items.

### Desktop PDP variant states — 219:2778–2807

Native LinkButton remains secondary/outlined/sm with actual NextLink href and
aria-current. The existing group/per-variant wrappers bind consumed Button
roles only at md: unselected fill-hover/neutral300/1px; selected base and
bg-secondary-base/2px. Both use canonical text-md/normal16/24. Mobile retains
its existing selected primary/solid/md and selected-option label. No arbitrary
chip widths or appearance classes on the kit components.

Stock corners219:2787/2797/2807 are separate decorative Image/NextImage
siblings in the existing relative wrapper, not Button icons or CSS shapes.
The original Figma SVG is local at public/brand/stock-corner.svg,8×8; the
overlay is hidden on mobile and pointer-events-none/aria-hidden with empty alt.
It renders only for the individual owner's available/limited variant stock,
never inferred from selection, group count or parent stock. Historical N1
showed its green corner and tooltip even at zero stock; that misleading
behavior is deliberately not copied. No unsupported tooltip copy is added.

The same component-state configuration pass removes the menu's redundant
color-scope div: its token-only utility configures the existing NavItem
directly. Header still owns all visual CSS; no appearance declarations,
descendant selectors, new primitive or basic theme overrides are introduced.

### Product loading and failure — 57:3009 / 57:3028

The current loading composition already uses the connected PriceBlock pending,
AvailabilityStatus pending and native md/primary/solid loading Button. Its
extra loading announcement is screen-reader-only. The unknown product title
stays generic rather than copying fixture data or deriving a title from a slug.
The product failure body now uses the exact Figma57:3030 Czech message and
its English translation; category failure copy stays independent. The native
retry still refreshes the route. No toast replaces this persistent failure.
Two failing-then-passing localized regression cases cover this distinction.

### Confirmation banner — 372:3126 / 372:3357

The existing application status surface keeps its canonical N1 success color
at the exact15% paint opacity recorded in the Figma instance. The design
context omits that paint opacity; the direct paint/binding inspection confirms
it. No palette override or new alert component is required. The existing
wrapper now uses a column with4px gap, and the20px semibold title uses28px
line height. Payment status copy remains truthful; a fixture claim of email
delivery is not evidence that an email was sent.

An isolated test-only SSR render of the actual CheckoutView with shipped CSS
was inspected at320/390/1440. It uses explicit visual fixture data outside
the application; no order, backend call or runtime mock was introduced.

### Unavailable shipping — 57:3088 / 322:1665

An owner-ready response with no shipping methods renders the connected native
StatusText md/error with its supported showIcon prop, using the exact Figma
Czech copy and its English translation. It replaces the empty required
RadioCard group; available methods still use the existing native choices.
The shared no-shipping text also remains suitable for the shipping information
page. Parent action disabling and the submit guard still require a real method.
The fixture's cash-on-delivery payment is not evidence of an available provider;
the actual payment state is preserved. No ad-hoc component styles or backend changes.

The installed kit exports line-height-status-text-md but does not pair it
with its text utility. The app's @theme initialization bridges the supported
Tailwind typography companion to that existing role, yielding the Figma16/30
without per-instance classes or a new theme value. This applies to all N1
StatusText md messages; sm messages retain their existing typography.

### Checkout operation feedback

The persistent failure pattern in57:3088/322:1665 uses the native StatusText
md/error. Checkout operation failures now use that same component; unresolved
orders and a preserved cart use its warning state. The specific owner rejection
replaces the simultaneous generic form instruction. A fresh quote hides the
previous rejection, while a confirmed receipt suppresses stale quote/guard
fallbacks. Explicit storage, recovery and preserved-cart notices remain visible.
This is application state mapping, not a claim that Figma defines each backend
failure. No new copy, component styles, price calculations, transport or intent
guard changes are introduced. Persistent recovery instructions stay on screen.

An isolated SSR render of the actual CheckoutView was inspected at320/390/1440,
including English recovery. No Stage rejection/order was manufactured for the
screenshots. The320px action-label overflow found during that pass is addressed
by the responsive action composition below; it was excluded from the earlier
notice-only visual approval.

Price semantics remain owner unit amounts. Although fixture319:1787 displays
950 Kč with quantity2, the layer is named Unit price including tax, and the
historical N1 CartItemRow also renders the unit amount. Its sample arithmetic
does not justify changing checkout to derived line totals. Recovered native
orders deliberately expose no lineTotalMinor; unit price times quantity is not
used as a substitute for an owner total.

### Responsive checkout action labels — 319:1803 / 319:2032

Fresh desktop/mobile Code Connect preserves Button md/primary/solid, the
two-column action row and its8px gap. The existing native Button loading branch
accepts ReactNode children when loadingText is omitted, so the pending label is
an accessible child span: sr-only below the canonical xl breakpoint, visible
from xl. The kit still renders and animates its own spinner. No custom spinner,
appearance CSS, viewport JavaScript, kit/token change or duplicate submit is
introduced. The button exposes aria-busy and the full localized operation name.

The initial verification action also clipped vertically at320px. Below xl its
visible label is the localized Ověřit/Check, while aria-label retains the full
verification purpose. Wide layouts keep the full label. The previously approved
Objednat/Order confirmation label is unchanged. The same Button, ref, click
handler, disabled logic and form submission remain in place.

Actual-component SSR browser checks cover56 CS/EN combinations: idle,
verified, quoting and placing at320/390/768/1024/1279/1280/1440px. Geometry,
effective visibility, busy/name/disabled semantics and eight320px AX snapshots
passed; the real local checkout idle action was also inspected. Native spinner
frames vary through its ring-resize animation, and its own margin remains.
This verifies layout and accessible names, not an unsolicited screen-reader
announcement or a new Stage order end-to-end test.

### Právní články — 370:2679/2870/3084/3264

Existující LegalView převádí dodaný český redakční dokument, ne runtime CMS
nebo přepočítanou policy. Figma výslovně používá p40 i na mobilu, Privacy
navíc pt48. Vnitřní šířky1120/310, mezery24/16/8, nadpisy a96×4 underline
jsou v současné kompozici přítomné. Obsah ponechává lang=cs pod EN chrome.
Nové actual desktop/mobile PNG potvrzují strukturu bez přetékání. Zalamování
system-ui vs Inter způsobuje známou24px odchylku výšky vybraných sestav;
padding se kvůli tomu nemění. Nejde o nové vzhledové přepisy ani pixelové GO.

### Kategorie — mobilní Pagination 38:2409 / desktop 214:4488

Existující CatalogPagination nadále skládá skutečné kit Pagination a NextLink.
Mobilní Figma parent 38:2138 řadí stránkování vlevo, desktop vpravo.
CategoryView proto volí `mobileAlignment="start"`; samostatné vyhledávání
ponechává výchozí end. Mění se jen responzivní flex zarovnání app wrapperu,
nikoli vzhled nebo interakční kontrakt knihovní komponenty. Skutečné count,
stránka a query zůstávají datové; návrhových 182 stránek se nekopíruje.

### Vyprodaný produkt — 57:2965

Figma zobrazuje AvailabilityStatus unavailable a na mobilu zakázané tlačítko
Vyprodáno. ProductPurchase proto pro přesný owner stav `unavailable` nevypisuje
ještě obecnou hlášku o nedostupném nákupu. Pro neznámý sklad nebo chybějící
nákupní kontext tato diagnostika zůstává. Podmínky nákupu, validace množství,
kit komponenty a jejich vzhled se nemění. Skutečný vyprodaný produkt byl
zkontrolovaný v CS/EN na mobilu a v CS na desktopu; nákup zůstává zakázaný.

### Přihlášení a registrace — 56:883/978, 333:6888 a 59:1709

Formuláře používají `FormInputRaw` se standardním `StatusText`: validní heslo
má neutrální okraj a samostatnou úspěšnou zprávu podle návrhu; chyba zachovává
nativní error variantu. Prázdné heslo rozlišuje povinné pole od nesplnění
vlastnického pravidla délky 12–128 znaků. Návrhová ukázka 8 znaků toto pravidlo
backendu nemění. Stav chyby registrace po neplatném odeslání zakáže CTA,
oprava polí ho znovu povolí; políčka zůstávají editovatelná.

Validace při kliknutí počká na dokončení stejného pointer gesta. Zobrazení
chyby při blur tak neposune souhlas před dopadem prvního kliknutí. Klávesnice
validuje bez tohoto odkladu. Pomocný stav uchovává pouze název pole a výsledek
validace, žádné hodnoty ani přístupové údaje. Názvy a popisy jsou navázané
na jedinečné ID formuláře, i když je současně otevřené minipřihlášení.

### Kategorie a produktová metadata — 31:638/639, 219:2772–2774

Aktuální kategorie skládá strom, podkategorie, počet produktů, karty a stránkování.
Návrh neobsahuje filtry ani řazení. Mobilní strom zavírá stejný horní přepínač,
který jej otevřel; dodatečné tlačítko s názvem kategorie pod celým listingem
nemá předlohu a bylo odstraněno. Otevření dál předá focus do skutečného TreeView.

Desktopový řádek Kód produktu zůstává přítomný i při chybějícím SKU a používá
přeloženou pomlčku podle 219:2774. Skutečné SKU vybrané varianty má přednost.
Mobilní viditelnost metadat, galerie, sklad, ceny i nákupní logika se nemění.
Žádné nové vzhledové třídy komponent ani tokenové override tím nevznikají.

### Toast a neaktivní checkout CTA — mobilní runtime kontrola

Toaster 0.57.0 nemá veřejný width prop. Jeho `w-toast-width` používá alias
`--spacing-toast-width → --size-toast-width`; nativní store má odstup 24 px.
App `@theme static` omezuje pouze tento alias na minimum knihovní šířky a
viewportu zmenšeného o dvě nativní mezery. Základní N1 tokeny ani per-instance
styly se nemění. Oprava řeší doložené oříznutí textu na 320 px; paleta zůstává
kanonická. Skutečná poloha zahrnuje šířku scrollbarů, negarantuje přesně stejný
okraj na obou stranách viewportu.

LinkButton 0.57.0 blokuje disabled kliknutí, ale jeho `disabled:*` vzhled necílí
na aria-disabled odkaz. Neaktivní CTA košíku proto skládá existující `Button disabled type="button"`, aktivní stav skutečný `LinkButton` do pokladny.
Původní podmínka ready + verified + valid zůstává. Kratší text „Přejít k pokladně“
vychází z 59:1074. Nejde o frontendové povolení nákupu při chybě quote.

### Checkout validace a čekající návrat — 323:1813, 323:1566

FormInput nadále používá veřejné `validateStatus` a popsaný StatusText pod
polem. Neplatný submit zachovává nativní constraint validation, ale potlačí
duplicitní prohlížečovou bublinu a zaměří první neplatný input. Žádné
`noValidate`, obcházení schématu nebo vlastní komponentové styly.

Během quote/place je Zpět nativní `Button disabled type="button"` se stejnou
secondary/solid/md rolí jako předtím; po dokončení zůstává skutečný NextLink
přes LinkButton. Tím se uplatní i knihovní disabled vzhled. Ověřování, zápis,
obnova objednávky, skutečné možnosti dopravy ani dostupnost plateb se nemění.

## 9. 11. — samostatné odkazy mobilního menu

Aktuální Code Connect pro 418:2487 (Novinky) a 418:2606 (samostatná kořenová
položka) mapuje přímo `@techsio/ui-kit/atoms/link`. Mobilní menu proto pro
tyto navigační odkazy používá `Link as={NextLink}`. Tlačítkové props a
wrapper role `n1-mobile-category-heading` z těchto dvou míst odstraněny.
Accordion.Header si ponechává svou samostatnou roli. Žádné CSS ani tokeny se
kvůli změně odkazu neupravují. Kontrola knihovny 0.57.0 potvrzuje, že Link
nemá tlačítkovou typografii; runtime Novinky má weight 400.

Data zůstávají skutečná: nynější kořeny, pořadí a počty nejsou nahrazeny
Figma fixture. Zavíraní v headeru, native focus a disclosure zůstávají zachované.

## 9. 11. — oddělovače kořenů mobilního menu

Figma `418:2489`, `418:2517` a další obsahují samostatný oddělovač za
celým kořenovým řádkem, mimo mapovanou instanci Accordion. Aplikace jej
skládá na existujícím obalu pomocí `border-b border-border-secondary`.
U větve obal zahrnuje celý Accordion.Item včetně rozbalených potomků.
U Novinek a samostatného kořenového odkazu je stejný oddělovač na jejich
obalu. Vnořené řádky jej nedostávají. Accordion zůstává md/borderless/none;
žádná komponentová CSS ani tokenové override nebyly přidány.

## 9. 11. — samostatné odkazy desktopového megamenu

Aktuální Figma `418:2368` mapuje obrázek kategorie a textový Link odděleně.
Stejná skladba je nyní v desktopovém menu; odstraněný bold span již
nepřebíjí typografii Link atomu. Obrázek zůstává přístupným odkazem se jménem
kategorie a oba odkazy navigují stejnou cestou a zavírají popup.
Auditované lokální ilustrace mají přednost, ostatní kategorie mohou použít
skutečné owner imageSrc. Nevznikají ilustrace odvozené z názvu ani fixture.
Stávající modeless popup, šest sloupců, mezera 8 a panelový padding 18
zůstávají beze změny; používají zavedené tokeny a app kompozici.

## 10. 11. — potvrzení objednávky a nativní readback

Fresh Figma55:1948/55:2309, obsah372:3125: potvrzený nákup doplní své
datum, adresu a dopravu jedním existujícím status readem. Úspěch placementu
zůstává potvrzený i při chybě čtení; ruční načtení je jen fallback. Automatické
i ruční doplnění pouze aktualizuje receipt, neopakuje placement ani čištění
košíku. Odpověď musí patřit stejné objednávce, scope, guardu a session.

Nadpisy Položky objednávky, Doručovací adresa a Souhrn ceny jsou převzaté
z návrhu. Děkovná věta neslibuje odeslaný e-mail, protože pro něj nativní
kontrakt nedává důkaz. Žádná nová komponenta, CSS nebo tokenový override.
Moje objednávky pro guest nákup nepřidáváme; přihlášená větev zůstává
samostatnou neověřenou částí.
