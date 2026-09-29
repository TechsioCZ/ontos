# AKROS: čtyřkrokový checkout

Stav: schválený rozsah implementován a ověřen 29. 9. 2026.
Analýza: 29. 9. 2026. Rozsah: samostatný prototyp `akros-storefront/`.

Potvrzený rozsah první implementace: čtyři kroky s jedním košíkem, bez placeného
prodloužení vrácení a bez ukazatele dopravy zdarma. Panel přepínání více košíků
se proto v první verzi nezobrazuje; nejde o nefunkční napodobeninu návrhu.

## Ověřené podklady

Přečtené Figma vrstvy, design context a screenshoty ze souboru
`SAs905DGG2kT4lnrQ0PnyG`, stránka `6:2` — Redesign prvků:

| Krok                  | Figma                                                                                       | Obsah                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1. Nákupní košík      | [CartStep1, 7:1261](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1261)     | Položky, dostupnost, množství, ceny, odebrání; návrh dopravy zdarma a doplňkové služby; přechod k dopravě. |
| 2. Doprava a platba   | [CartStep2, 7:1437](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1437)     | Výběr dopravy a platby na jedné obrazovce, loga, popisy, ceny.                                             |
| 3. Dodací údaje       | [CartStep3_B2B, 7:1777](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1777) | Předvyplněný kontakt a fakturační adresa, změna údajů, volitelná jiná dodací adresa.                       |
| 4. Shrnutí objednávky | [CartStep4, 7:1598](https://www.figma.com/design/SAs905DGG2kT4lnrQ0PnyG?node-id=7-1598)     | Editovatelné položky, doprava, platba, cenový rozpad, obě adresy, newsletter a finální odeslání.           |

Potvrzení po dokončení je samostatná výsledná stránka, nikoli pátý krok.

## Implementace

- Všechny čtyři routy používají společný provider a UI-kit Steps. Prázdný košík,
  chybějící metody a neplatná adresa chrání i přímý vstup přes URL.
- Sdílená DataTable v krocích 1 a 4 respektuje minimální odběr, sklad i desetinné
  množství. Částky se zaokrouhlují po řádcích v haléřích, stejně i v mini-košíku.
- Zvolená doprava, pobočka, platba a editovatelné adresy přežijí návrat i reload.
  Lokální B2B profil je předvyplněný; newsletter ani jiná dodací adresa nejsou
  automaticky zaškrtnuté. Jiná adresa zůstane rozepsaná i po vypnutí.
- Daňový rozpad používá ceny katalogu, nikoli plošně odhadnutou sazbu.
  Staré snapshoty košíku bez ceny bez DPH se nemažou ani nepřecení;
  chybějící rozpad je výslovně označen. Nově přidané položky ukládají obě ceny.
- Doprava/platba a pobočky jsou explicitní demo konfigurace pro ČR.
  Objednávka se uloží do sessionStorage před vyprázdněním košíku. Potvrzení
  přežije reload a neoznačuje platbu za provedenou; bez snapshotu zobrazí prázdný stav.
- UI je složené z publikovaných komponent, inline Tailwind layoutu a scoped
  override existujících tokenů. Přidané CSS neobsahuje nové vzhledové třídy.
  Typografie je mapovaná na stávající shell: text 14 px, nadpisy 20 px, součet 24 px;
  číslované kroky 40 px a formulářové prvky/tlačítka 44 px.
- Sidebar je vedle obsahu od 1280 px, níže pod obsahem; mobilní řádky tabulky
  se skládají do dvou sloupců. Logo assety jsou originální exporty z Figma uzlů.

Následující analytické sekce zachovávají původní srovnání před implementací.

### Ověření implementace

- `npm run check`: formátování, lint bez nálezů, TypeScript, 76 testů a produkční
  build úspěšné. Všechny čtyři kroky jsou součástí buildu.
- Na `localhost:3000` ověřeny všechny čtyři obrazovky proti Figma podkladům,
  desktop 1920/1440 px, tablet 1024 px a mobil 390 px.
- Ručně ověřeny výběr metody/pobočky, chyby a focus v adrese, návrat mezi kroky,
  reload s rozepsanými údaji, přímé URL bez splněných podmínek a přesměrování `/pokladna`.
- Ověřeno ruční zadávání množství s minimálním odběrem a desetinných metrů.
  Nedopsaná číslice už nepřepisuje košík; normalizace proběhne při opuštění pole.
- Dokončen skutečný průchod lokálního prototypu: uložené položky/adresy/metody/součet,
  prázdný košík po uložení, platba označená jako neprovedená, potvrzení zachované po reloadu.
  Automatické testy navíc pokrývají dvojí submit, chybu zápisu a neplatné potvrzení.
- Produkční platební ani dopravní integrace není implementovaná ani testovaná.

## Co je skutečně v návrhu

### Společná struktura a rozměry

- Desktopové framy mají šířku 1920 px. Vnější vodorovné odsazení je 130 px;
  obsah má 1660 px: hlavní sloupec 1228 px, mezera 24 px, sidebar 408 px.
- Horní odsazení obsahu je 40 px, spodní 80 px. Steps leží nad hlavním sloupcem,
  sidebar začíná již ve stejné výšce jako Steps. Mezi Steps a kartou je 60 px.
- Povrch stránky je světle šedý, obsahové karty bílé s radius 8 px a běžně paddingem 32 px.
  Sidebar má mezi bloky 16 px; karta souhrnu v kroku 1 používá svisle 24 px.
- Steps mají čísla v kruzích 40 px, mezeru 8 px k popisku. Aktuální a předchozí
  kroky jsou tmavé, budoucí šedé. Čísla zůstávají čísly i po dokončení kroku.
- Zdrojová typografie: popisky Steps a hlavní text 20 px, sekundární text 16 px,
  nadpisy karet 31 px, dílčí nadpisy 25 px, výsledná cena v sidebaru 38 px.
  CTA v návrhu mají text 20 px a přibližně 60 px výšku.
- To jsou naměřené hodnoty zdrojového rámce, nikoli pokyn zvětšit celý současný web.
  Aplikace má schválený shell s maximem 1440 px. Při implementaci zachovat shell,
  kompaktní produktové karty a typografickou hierarchii přes existující tokeny;
  sloupce přizpůsobit dostupné šířce. Konkrétní mapování ověřit v prohlížeči při
  stejném viewportu, ne podle zmenšeného obrázku celé stránky.
- Doporučené produkty jsou viditelné v krocích 1–3. V kroku 4 je jejich vrstva skrytá.
  Cenový sidebar je ve čtvrtém kroku také skrytý; ceny jsou přímo v hlavním shrnutí.
- Panel „Vaše košíky“ je viditelný ve všech čtyřech krocích. Obsahuje výběr
  výchozího/komisního košíku, odstranění a přidání košíku.

### Krok 1

- Bez produktových thumbnailů: název a varianta, skladovost, NumericInput, cena řádku,
  ikona odstranění. Podoba řádků se využije i ve finálním shrnutí.
- Zachovat jednotky a desetinné množství z dat, například `0,5 m`; neproměňovat metry v kusy.
- Návrh obsahuje ukazatel „K dopravě zdarma chybí ještě 154 Kč“ a nabídku
  prodloužení vrácení z 30 na 60 dní za 159 Kč. Jde o návrhové obchodní nabídky,
  nikoli o pravidla dostupná v modelu košíku.
- Navigace: „Zpět do obchodu“ a „Vybrat dopravu a platbu“.

### Krok 2

- Doprava ve Figmě: Zásilkovna, Balíkovna, DPD Parcel (ukázkově po 79 Kč), osobní odběr zdarma.
- Platba ve Figmě: GoPay, Apple Pay, kartou na prodejně (ukázkově zdarma).
- Celý řádek má fungovat jako volba RadioGroup, včetně dostupného názvu a ceny.
- Návrh neobsahuje výběr konkrétní pobočky Zásilkovny/Balíkovny, pravidla kombinací
  dopravy a platby ani omezení pro dlouhý a těžký hutní materiál. Tyto části je nutné
  modelovat výslovně, pokud budou tyto metody v prototypu skutečně volitelné.
- „Kartou na prodejně“ dává smysl s osobním odběrem; navržené omezení musí být
  uvedeno v konfiguraci metod a ověřené při změně dopravy.
- Ceny a názvy ve finálním kroku se musí odvodit z vybrané metody. Figma například
  ukazuje GoPay v kroku 2 a Comgate ve shrnutí; nekopírovat tuto nekonzistenci.

### Krok 3

- Zobrazen je B2B scénář: jméno, e-mail, IČ, DIČ, telefon a fakturační adresa.
- „Změnit“ musí zpřístupnit editaci odpovídajících údajů; nestačí statický text.
- Checkbox jiné dodací adresy je v návrhu zapnutý. Pole: jméno, příjmení, ulice/č.p.,
  město, PSČ, země a telefon s volbou předvolby. Desktop má dva sloupce.
- Při vypnutí použít fakturační adresu; rozepsanou odlišnou adresu uchovat pro opětovné zapnutí.
- Není zde navržen přihlašovací krok ani B2C varianta. První implementaci navrhuji
  jako editovatelný lokální B2B profil odpovídající předloze; nepřidávat povinné přihlášení.
- Adresy uchovat při pohybu dopředu/zpět a po obnovení stránky. Chyby zobrazit u polí
  a při pokračování přesunout focus na první neplatné pole.

### Krok 4

- Tabulka má hlavičku a stále umožňuje změnu množství a odebrání položek.
- Následuje zvolená doprava s místem doručení, platba, cena bez DPH a celková cena.
- Fakturační a dodací údaje jsou vedle sebe; na mobilu pod sebou.
- Newsletter je samostatný nepovinný checkbox, ve výchozím stavu vypnutý.
- Finální CTA „Objednat s povinností platby“, pod ním odkazy na obchodní podmínky
  a zpracování osobních údajů. Samotný text z Figmy není návrh nové právní politiky.
- V lokálním prototypu tlačítko vytvoří lokální snapshot objednávky, nepovolí dvojí
  odeslání a až po úspěšném uložení vyprázdní odpovídající košík.
- Přímý vstup na potvrzení bez uložené objednávky nesmí zobrazit smyšlenou zaplacenou objednávku.

## Rozdíly proti dnešní implementaci

| Dnešní stav                                                              | Potřebná změna                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `/kosik` a samostatná `/pokladna`, ve které jsou všechny sekce současně. | Jeden navazující flow se čtyřmi skutečnými kroky.                                       |
| Navigace je obyčejné `<ol>` se třemi popisky.                            | Použít UI-kit Steps s řízeným stavem a navigací.                                        |
| FormInput používá `defaultValue`; odeslání hodnoty formuláře nečte.      | Sdílený checkout draft a řízené hodnoty včetně adres.                                   |
| Checkbox jiné adresy nic dalšího neovládá.                               | Podmíněná dodací adresa, vlastní validace a skutečné použití ve shrnutí.                |
| Doprava/platba jsou pouze lokální `useState` uvnitř jedné stránky.       | Uchování mezi kroky a při reloadu; validita kombinace metod.                            |
| Košík přičítá pevnou dopravu 119 Kč, pokladna používá vybranou metodu.   | Jeden výpočet souhrnu; před výběrem dopravy stav „bude vybráno“, ne pevná cena.         |
| CartItemSnapshot uchovává pouze cenu s DPH.                              | Pro daňový rozpad doplnit cenu bez DPH z odpovídající základní cenové úrovně katalogu.  |
| `CartState` má jen `version: 3` a `lines`.                               | Více košíků není kosmetická změna; případně samostatně rozšířit provider a migraci.     |
| Submit pouze vymaže košík a přesměruje.                                  | Nejprve uložit úplný výsledný snapshot; potvrzení z něj musí číst.                      |
| Potvrzení má pevné číslo, termín, PPL, adresu a stav „zaplaceno“.        | Zobrazit skutečně zvolená lokální data; neoznačovat simulovanou platbu jako zaplacenou. |

Přečtené zdroje: `src/features/cart/{mini-cart,cart-content,cart-provider,product-purchase-form}.tsx`,
`src/features/checkout/mock-checkout.tsx`, `src/mock-storefront/{cart,types}.ts`,
`src/mock-storefront/fixtures/account.ts`, `src/app/{kosik,pokladna,potvrzeni-objednavky}/page.tsx`,
`src/components/{storefront-shell,product-grid}.tsx`, příslušné komponentové testy a
publikovaný runtime, typy a tokeny `@techsio/ui-kit@0.50.0`. Storybook zdroje nejsou
součástí instalovaného balíčku; plán vychází z jeho skutečného exportovaného API.

## Navržená implementace

### Routy a stav

- `/kosik` — krok 1.
- `/kosik/doprava-platba` — krok 2.
- `/kosik/dodaci-udaje` — krok 3.
- `/kosik/shrnuti` — krok 4.
- `/pokladna` ponechat jako kompatibilní přesměrování na krok 2, s kontrolou předpokladů.
- `/potvrzeni-objednavky` — výsledek dokončení, mimo čtyřkrokové Steps.

Společný layout pod `/kosik` drží CheckoutProvider a shell, aby přepnutí stránky
nezahodilo formulář. Aktivní krok odvozovat z URL; nepěstovat druhý nezávislý index.
Zpět/vpřed v prohlížeči i přímé URL musí procházet stejnými kontrolami jako tlačítka.
Po hydrataci vrátit neplatný přímý vstup na první nedokončený předchozí krok.
Prázdný košík vždy vede na prázdný stav kroku 1.

Checkout draft: vybraná doprava, případná pobočka, platba, kontakt/firma, fakturační
adresa, přepínač a hodnoty dodací adresy, newsletter. Rozpracované osobní údaje a
poslední lokální objednávku navrhuji držet v verzovaném `sessionStorage`; košík zůstává
v existujícím `localStorage`. Hydratace musí být bezpečná vůči prázdným či starým datům.
Souhrny počítat z aktuálních položek a draftu, neukládat jejich druhou nezávislou kopii.

Při změně množství se ceny přepočítají v obou tabulkách a sidebaru. Změna dopravy
zneplatní nekompatibilní platbu/pobočku. Změna země znovu ověří dopravu. Odebrání
poslední položky v kroku 4 zabrání odeslání a vrátí uživatele do prázdného košíku.

### Kompozice UI-kitu

| Potřeba                     | Komponenta a ověřená forma použití                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kroky a panely              | `useSteps({ count: 4, step, onStepChange, isStepValid, onStepInvalid })` + `Steps.RootProvider`, `List`, `Item`, `Trigger`, `Content`, `Navigation`. |
| Čísla i u dokončených kroků | `<Steps.Indicator><Steps.Number /></Steps.Indicator>`; defaultní Indicator by použil fajfku.                                                         |
| Položky košíku              | `DataTable` s `data`, `columns`, `variant="line"`, `size="sm"`; společná app kompozice pro kroky 1 a 4.                                              |
| Množství                    | Stávající `NumericInput`, `locale="cs-CZ"`, `min`, `step`, `max` z dat a reduceru; převzít již odladěnou vodorovnou kompozici.                       |
| Výběr metod                 | `RadioGroup` s `value`, `onValueChange`, skrytým inputem a celým klikacím řádkem.                                                                    |
| Adresní pole                | `FormInput size="sm"`, řízené `value`, `required`, `validateStatus`, `helpText`, správné autocomplete.                                               |
| Země                        | Složený `Select` s explicitními `items` a řízenou hodnotou, ne textové pole.                                                                         |
| Telefon                     | `PhoneInput`, `defaultCountry="CZ"`, `value`, `onValueChange`, `Label`, `Control`, `CountryPicker`, `Input`, `StatusText`.                           |
| Jiná adresa a newsletter    | `FormCheckbox size="sm"` s řízeným stavem.                                                                                                           |
| CTA a odstranění            | `Button`, `LinkButton`, `ActionIcon`; obecné ikony z Iconify MDI.                                                                                    |
| Doporučené produkty         | Existující `ProductGrid` a reálná katalogová data; přizpůsobit layout šířce sekce, nevytvářet druhou kartu.                                          |

Steps v tomto balíčku vyžaduje pozornost:

- Samotný komponent `Steps` deklaruje rozšířené machine props, ale v runtime do
  `useSteps` nepředává `isStepValid`/`onStepInvalid`. Exportovaný hook a RootProvider
  je předají správně; není potřeba upravovat sdílenou knihovnu.
- `linear` blokuje všechny standardní kliky na nadpisy kroků, včetně návratu.
  Navrhuji řízený hook bez tohoto přepínače, explicitně zakázané nedostupné kroky
  a společnou kontrolu přechodu pro horní navigaci, CTA i URL.
- Kontrola zabudovaná v machine ověřuje pouze aktuální krok, ne všechny přeskočené
  kroky. Aplikace proto musí ověřit všechny předpoklady cílového kroku.
- Výchozí layout má číslo vedle názvu. Složení do sloupce a zarovnání separatoru
  je app layout přes Tailwind; barvy, velikosti a padding řešit existujícími Steps tokeny.
- Poslední CTA je vlastní submit Button. Nepoužít běžný NextTrigger, který by
  pouze přešel do technického stavu `step === count` bez vytvoření objednávky.

### Ceny a dostupnost dat

- Základní `priceTiers` obsahují cenu s DPH i bez DPH, ale do snapshotu košíku se
  dnes ukládá jen první z nich. Rozšířit snapshot a všechny skutečné cesty přidání
  produktu do košíku; starý uložený košík zachovat a doplnit cenu z katalogu podle
  productId/variantId, případně přiznat nedostupný daňový rozpad.
- Nezavádět množstevní slevy; předchozí rozhodnutí je nezobrazovat zůstává platné.
- Nevypočítávat libovolně všechny položky sazbou 21 % podle textu z Figmy.
  Použít zdrojové ceny; pro dopravu/platbu potřebuje demo konfigurace vlastní
  ceny s DPH a bez DPH nebo výslovně stanovenou sazbu.
- Počítat v nejmenších měnových jednotkách, u desetinného množství stanovit
  zaokrouhlení ceny řádku a používat ho jednotně v tabulce, sidebaru a potvrzení.
- Číselné příklady ve Figmě nejsou účetní podklad: součet více řádků po 899 Kč
  v ukázce neodpovídá celku 899 Kč a cena bez DPH se mezi kroky liší.
- Současná nabídka dopravy (PPL, Zásilkovna, odběr) a plateb (karta, převod,
  dobírka) se liší od návrhu. Pro prototyp připravit jednu explicitní demo
  konfiguraci podle zvoleného rozsahu; nejde o integraci skutečných dopravců/plateb.

### Vizuál, loga a responzivita

- Použít existující tokeny; případné Steps override vložit do odpovídajícího
  app token souboru. Žádný nový CSS modul ani kolekce vlastních vzhledových tříd.
- Logo AKROS, Zásilkovna, Balíkovna, DPD a Apple Pay už mají lokální soubory;
  při implementaci ověřit shodu s konkrétní vrstvou a rozměry. GoPay v této sadě chybí
  a je potřeba stáhnout originální asset z Figmy. Loga nenahrazovat obecnými ikonami.
- Figma má v některých krocích produkty v samostatném rámu, který přesahuje šířku
  stránky. Převést je do běžného responzivního gridu a nepřenášet prázdný čtvrtý placeholder.
- Zachovat společnou hlavičku/patičku aplikace; checkout nemá katalogový sidebar.
- Mobilní checkout v těchto čtyřech framech není definovaný. Návrh: jeden sloupec,
  zalomené čitelné názvy kroků, dvousloupcová adresa přejde do jednoho sloupce,
  souhrn bude v toku stránky a tabulka dostane čitelnou mobilní kompozici.
- Ověřit 1920/1440/1024/390 px, dlouhé názvy, 0/1/více řádků, klávesnici,
  zoom a dotykové cíle. Nepřenést pevné výšky celých desktopových framů.

## Doporučené pořadí implementace

1. **Datový základ a navigace.** Checkout draft, hydratace, výpočet souhrnu,
   rozšíření snapshotu o cenu bez DPH, routy, přesměrování `/pokladna`, Steps a
   pravidla pro přímý vstup/zpět/vpřed. Ověřit uchování existujícího košíku.
2. **Krok 1 a společné části.** CartItemsTable, souhrn, prázdný stav, navigační CTA,
   doporučené produkty. Vizuálně ověřit proti `7:1261`.
3. **Krok 2.** Konfigurace dopravy/plateb, RadioGroup s logy, ceny a kompatibilita,
   případná ukázková pobočka. Ověřit přepočty a návraty mezi kroky proti `7:1437`.
4. **Krok 3.** Editovatelný B2B kontakt/fakturace, dodací adresa, Select, PhoneInput,
   validace a focus. Ověřit reload, chyby a vypnutí/zapnutí adresy proti `7:1777`.
5. **Krok 4 a dokončení.** Znovupoužitá tabulka, aktuální souhrn, údaje a newsletter,
   uložení objednávky, zabránění dvojímu odeslání, vyprázdnění košíku a pravdivé potvrzení.
   Ověřit proti `7:1598`.
6. **Celý průchod.** Komponentové testy přechodů a validace, jednotkové testy
   součtů/zaokrouhlení a migrace, ruční desktop/mobile průchod včetně návratů.
   Nakonec `npm run check` a vizuální kontrola všech čtyř kroků na localhost:3000.

Před každou etapou znovu otevřít konkrétní Figma uzel a relevantní část
storefront/UI-kit doporučení. Rozpracované etapy zakončovat samostatnými
ověřitelnými změnami; commit podle pokynu uživatele.

## Rozsah a odložené funkce

- **Jeden košík — potvrzeno uživatelem.** Neimplementovat vytváření/přepínání
  pojmenovaných košíků ani panel „Vaše košíky“. Zachovat existující uložené položky.
- **Doplňkové nabídky vynechat — potvrzeno uživatelem.** Placené prodloužení vrácení
  a ukazatel dopravy zdarma nejsou součástí první verze, včetně jejich UI.
- **Obchodní data dopravy/plateb — návrh pro prototyp.** Použít explicitní demo nabídku
  podle Figmy. Produkční poskytovatelé, ceny, způsobilost zboží, pobočky a platební
  brána nejsou dostupné z katalogového feedu a nejsou součástí této frontendové přestavby.
