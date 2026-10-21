# TASK 02: výběr oblíbených variant, sdílení a tisk

Stav k 21. 10. 2026: lokálně implementováno a ověřeno po souhlasu s realizací.
Původní [TASK 02 / #1300](https://github.com/TechsioCZ/ontos/issues/1300)
se doplňuje o uživatelův požadavek na výběr variant po kliknutí na srdíčko.
Nově požadované akce „Sdílet“ a „Tisk“ jsou popsané samostatně, bez přečíslování
původních 17 úkolů. Návaznosti jsou v [hlavním plánu](../IMPLEMENTATION-PLAN.md).

## Doporučený průchod

Kliknutí na srdíčko konkrétního produktu otevře dialog „Oblíbené varianty“.
Název kontejneru se zobrazí jednou nad seznamem. Uživatel zaškrtne konkrétní varianty,
vidí počet vybraných a změny potvrdí tlačítkem „Uložit výběr“. Již uložené varianty
jsou při dalším otevření zaškrtnuté. „Zrušit“, křížek a Escape zahodí pracovní změny.
Po souhlasu s realizací se používá tento doporučený způsob potvrzení.

```text
Oblíbené varianty                                      [Zavřít]
VRUTY SE ZÁPUSTNOU HLAVOU DIN 7997/A2

[Hledat podle kódu, názvu nebo parametrů…                 ×]
[−] Vybrat všechny výsledky (12)     Vybráno 3, z toho 1 mimo filtr

    Varianta             Kód               Dostupnost    Cena s DPH
[✓] 3 × 20               10799700030020    Skladem       0,88 Kč / ks
[ ] 3 × 25               10799700030025    Není skladem  1,08 Kč / ks
[✓] 3 × 30               10799700030030    Skladem       1,36 Kč / ks
    … seznam se posouvá uvnitř dialogu …

Vybrány 3 varianty                   [Zrušit] [Uložit výběr]
```

Ceny v příkladu ilustrují rozložení; implementace použije současný katalog a jeho
formátování, nikoli pevné hodnoty. Seznam nemá množství, nákupní tlačítka ani
opakované názvy celého produktu. Účelem je vybrat oblíbené varianty.

## Výchozí stav aplikace před implementací

- `product-detail-actions.tsx`: současné srdíčko zapisuje boolean podle `productId`.
  Výchozí React stav je `false`; při otevření se neobnovuje záznam z úložiště.
- Toto srdíčko se na produktové route renderuje v nákupní části produktu s jednou
  variantou / samostatnou položkou. Vícevariantový kontejner potřebuje svůj vstup
  do nového výběru; nestačí přepsat existující tlačítko.
- `product-grid.tsx`: srdíčko v kartě je odkaz na `/oblibene`, nevykonává výběr.
- `CatalogProductSummary` neobsahuje `detail.variants`. Výběr z karty musí konkrétní
  varianty získat cíleně; neimportovat celý katalog do každé klientské karty.
- `/oblibene`: šest pevných ukázkových produktů. K ověření celé cesty doporučuji
  základní napojení na nové úložiště už v tomto kroku; tím se pokryje část TASK 13.
  Finální prezentace a přesné otevírání varianty zůstávají navazující prací.
- Košík už používá `productId` a `variantId`; využít stejné rozlišení referencí.
- `ProductDetailActions` už obsahuje nativní sdílení s e-mailovou náhradou, ale
  akce se jmenuje „Poslat kamarádovi“ a pracuje s aktuální URL bez jednotného
  kontraktu přesně vybrané varianty. Tisk ani tiskové styly v prohledané aplikaci nejsou.

## Inventář komponent: ověřené API

Ověřena nainstalovaná verze `@techsio/ui-kit@0.56.1`, její spustitelné `.js`,
deklarace `.d.ts` a související tokeny. Storybook stories ani TSX zdroje komponent
nejsou v instalovaném balíčku dodané; nevycházím z neověřených příkladů z legacy repozitáře.
Následující zápisy jsou návrhy použití existujícího veřejného API, nikoli implementace.

| Potřeba                          | Komponenta / import             | Ověřené props a preferovaný zápis                                                                                                                                                                                                                                                                                    | Tokeny / poznámky                                                                                             |
| -------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Okno výběru                      | `molecules/dialog`              | `<Dialog open={open} onOpenChange={handleOpenChange} customTrigger size="xl" placement="center" behavior="modal" initialFocusEl={focusHeading} finalFocusEl={focusTrigger} closeOnInteractOutside={false} title="Oblíbené varianty" actions={actions}>…</Dialog>`                                                    | Rozměry, mezery a typografie do komponentových tokenů; rozmístění obsahu je app kompozice                     |
| Seznam, hledání a stabilní řádky | `organisms/data-table`          | `<DataTable data={variants} columns={columns} getRowId={(item) => item.id} variant="line" size="sm" enableSorting={false} enableGlobalFilter={false} enablePagination={false} maxHeight="var(--akros-favorites-list-max-height)" stickyHeader />`                                                                    | Hledání je záměrně externí nad přesným seznamem; pro tento český výběr doporučuji vlastní checkboxový sloupec |
| Český výběrový sloupec           | `atoms/checkbox`                | `<Checkbox checked={selected} onChange={toggle} aria-label="Vybrat variantu 10799700030020" />`                                                                                                                                                                                                                      | Kontext dodá skutečný kód. Žádný paralelní nativní checkbox; stav patří app draftu                            |
| Vybrat aktuální výsledky         | `molecules/form-checkbox`       | `<FormCheckbox checked={allFiltered} indeterminate={someFiltered} onCheckedChange={toggleFiltered}>Vybrat všechny výsledky (12)</FormCheckbox>`                                                                                                                                                                      | Počet, checked i indeterminate se počítají výhradně z filtrovaných ID                                         |
| Hledání podle SKU / parametrů    | `molecules/search-form`         | `<SearchForm value={query} onValueChange={setQuery} onSubmit={preventSubmit} size="md"><SearchForm.Label>Hledat variantu</SearchForm.Label><SearchForm.Control><SearchForm.Input placeholder="Kód, název nebo parametr" /><SearchForm.ClearButton aria-label="Vymazat hledání" /></SearchForm.Control></SearchForm>` | Ověřené řízené API i slot mazání; filtrovat existujícím app helperem, bez dalšího potvrzování                 |
| Dostupnost varianty              | `molecules/availability-status` | `<AvailabilityStatus status="available" label="Skladem" showIcon={false} />`                                                                                                                                                                                                                                         | Stav odvodit ze skutečného minima a skladu; text doplňuje barvu                                               |
| Potvrzení / zrušení              | `atoms/button`                  | `<Button variant="primary" size="md" onClick={save}>Uložit výběr</Button>` a `<Button variant="secondary" theme="outlined" size="md" onClick={cancel}>Zrušit</Button>`                                                                                                                                               | Stávající AKROS tokeny; ukládání signalizovat až po skutečném zápisu                                          |
| Vlastní zavření                  | `atoms/action-icon`             | `<ActionIcon aria-label="Zavřít výběr variant" icon="token-icon-close" size="md" onClick={cancel} />`                                                                                                                                                                                                                | Použít s `Dialog hideCloseButton`; vlastní zavírání řeší anglický text v knihovně                             |
| Sdílet / tisk                    | `atoms/button`                  | `<Button size="sm" theme="borderless" variant="secondary" onClick={share}>Sdílet</Button>` a stejná varianta pro „Tisk“                                                                                                                                                                                              | Doplnit odpovídající ikonové aliasy aplikace; neponechat obálku jako univerzální ikonu sdílení                |

### Proč tyto komponenty

- **Dialog**: vhodný pro soustředěný výběr více položek s potvrzením. Zůstane jeden
  typ okna a jeden draft i při změně velikosti viewportu. Na desktopu návrhová šířka
  přibližně 880–960 px; na mobilu okno využije dostupnou šířku a výšku přes tokeny
  a app kompozici. Nejde o požadavek měnit šířku celého storefrontu.
- **DataTable**: stabilní ID, buňky, hlavičky, dostupné stavy a rozšiřitelné sloupce.
  Má i vestavěný vícenásobný výběr (`enableRowSelection`, `selectionMode`,
  `rowSelection`, `onRowSelectionChange`, `getRowLabel`), filtraci a virtualizaci.
  Pro navržený tok však vlastní checkboxový sloupec přes `columns` a externí
  filtrovaná data řeší přesně české popisky a rozsah hromadného výběru bez úprav kitu.
- **Table + Checkbox** je jednodušší alternativa pro malý, trvale neměnný seznam,
  ale vyžaduje vlastní správu všech buněk a stavů. Není nutné vytvářet novou tabulku,
  když už aplikace používá DataTable a potřebuje stejné typování buněk.
- **Drawer** má veřejné `Header`, `Body`, `Footer`, `CloseTrigger` a je použitelný
  pro mobilní variantu. Nedoporučuji přepínat Dialog ↔ Drawer hned v první verzi:
  přidává další správu fokusu a resize scénáře. Případné gesto zavírání navíc
  musí respektovat posouvání dlouhého seznamu a rozepsaný výběr.
- **Popover / Menu** použít případně pro krátké možnosti sdílení. Pro seznam
  stovek variant s potvrzením doporučuji samostatný modal.

### Konkrétní mezery v balíčku

1. `Dialog` je v této verzi jedna komponenta, nikoli API `Dialog.Root/Body/Footer`.
   Má `title`, `description`, `children`, `actions`, ale nemá body/footer slot props.
   Záhlaví, jedinou posuvnou oblast a stále dostupné potvrzení je nutné složit
   aplikačně; nevymýšlet neexistující složené API.
2. Zavírací `ActionIcon` má napevno `aria-label="Close dialog"`. Pro češtinu lze
   využít podporované `hideCloseButton` a vlastní kitový ActionIcon + Zrušit.
3. Automatické řádkové checkboxy DataTable mají napevno předponu `Select`.
   `translations.selectAllLabel` upravuje hlavičku, `getRowLabel` popis řádku,
   ale předponu nepřekládá. Doporučený vlastní výběrový sloupec tento detail řeší.
4. Responzivní karty nejsou hotový prop DataTable. Na malém displeji je potřeba
   app kompozice řádku: checkbox, název a SKU, pod nimi dostupnost a konkrétní cena.
   Stejná data a draft se nemají duplikovat do dvou nezávislých seznamů.
5. `SearchForm.Input` má výchozí `aria-label="Search"`, který přebije viditelný
   český label. Implementace proto předává také `aria-label="Hledat variantu"`.

## Pravidla výběru a stavů

- Do úložiště ukládat reference konkrétní prodejné položky, nikoli celý objekt
  produktu s historickou cenou. SKU se zobrazuje, identitu nese `productId` a
  `variantId`; pořadí řádku ani aktuální filtr nejsou identifikátor.
- Výběr žije mimo tabulku v draftu podle ID. Filtrování, řazení a scroll jej nemění.
  „Vybrat všechny výsledky“ mění jen právě odpovídající varianty; dříve zaškrtnuté
  varianty mimo filtr zůstávají vybrané. Počet mimo filtr je viditelný.
- Při zrušení se nic neukládá. Uložení mění pouze konkrétní produkt a zachovává
  oblíbené ostatních produktů. Odebrání všech původně uložených variant je platná
  změna; tlačítko nelze zakázat pouze proto, že výsledný počet je nula.
- Při nulové změně lze potvrzení zakázat. Při chybě zápisu zůstane dialog otevřený
  a nabídne opakování; nezobrazovat falešné „Uloženo“.
- Lze uložit i variantu, která není skladem. Oblíbené nesmí fungovat jako košík
  a nedostupná položka nemusí být zakázaná pro uložení.
- Původní záznam oblíbeného kontejneru nelze automaticky převést na všechny jeho
  varianty; nabídnout znovuvýběr konkrétních položek.
- Úložiště zůstává v rozsahu tohoto standalone dema lokální. Nezavádět kvůli tomu
  reálnou autentizaci, serverové účty ani předstíranou synchronizaci zařízení.
- Souhrnné srdíčko otevírá dialog, není samo toggle celé skupiny. Přístupný název
  například „Vybrat oblíbené varianty …, 3 uložené“, `aria-haspopup="dialog"`;
  počet a vyplnění znamenají, že má produkt uložené varianty, nikoli všechny.
  Srdíčko v hlavičce dál otevírá globální stránku oblíbených.
- U konkrétní prodejné varianty (včetně detailu s jedinou variantou a samostatné
  položky) se používá přímé přepnutí se zpětnou vazbou přes existující kitový toast.
- Dialog na kartě načte jen varianty otevřeného produktu, ideálně až po otevření.
  Znovu použít aktuální veřejný katalog; konkrétní datové rozhraní ověřit před
  implementací. Nepřipojovat celé katalogové JSON do každé klientské karty.

## Desktop, mobil a přístupnost

Hlavička a potvrzení zůstávají dostupné, posouvá se jen seznam. SKU zůstane celé
a kopírovatelné; na mobilu se sloupce skládají do řádkových karet. Checkbox má
velkou klikací oblast s textem a při jeho stisku nevznikne druhé přepnutí přes
bublání události na celý řádek. Cílová dotyková plocha je alespoň 44 px.

V aktuálním katalogu mají největší skupiny až 386 variant. Doporučuji nejprve
zobrazit všechny v omezené posuvné oblasti, bez stránkování po pěti; jednoduchý
výběrový řádek má podstatně méně ovladačů než současný nákupní řádek. Virtualizaci
přidat pouze po měření, s ověřenou klávesnicí a čtečkou. DataTable ji má, vyžaduje
`maxHeight`; není důvod automaticky zapínat všechny jeho funkce.

Při otevření dlouhého tabulkového dialogu doporučuji fokus na záhlaví / úvodní
statický prvek s `tabIndex=-1`; na mobilu se tím navíc bez záměru neotevře klávesnice.
Tab a Shift+Tab zůstávají v dialogu, Escape zavře, fokus se vrátí na původní srdíčko.
Krátký popis patří do `description`; celou tabulku nepředávat jako dlouhé
`aria-describedby`. Tyto volby odpovídají [doporučení WAI pro modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## Sdílet

V dosavadním řádku akcí přejmenovat „Poslat kamarádovi“ na **„Sdílet“**, doplnit
vhodnou ikonu a nové **„Tisk“** vedle něj. Hlídání a dotaz se v tomto kroku
automaticky neruší; jejich variantní kontext řeší TASK 03/07.

Navržené sdílení:

1. Na přímé kliknutí otevřít nativní nabídku zařízení, pokud ji browser podporuje.
2. Pokud není dostupná nebo skutečně selže, nabídnout „Kopírovat odkaz“ a „E-mail“.
   Kopírování spustí uživatel vlastním tlačítkem; při zamítnutí ukázat odkaz pro
   ruční zkopírování. Při zavření nativní nabídky nic automaticky nekopírovat.
3. V kontejneru sdílet produkt; v detailu konkrétní varianty přesný odkaz včetně
   její identity. Neodesílat náhodnou první variantu ani URL se starým filtrem.
   Dosavadní `?variant=` je hledaný výraz; přesné otevírání vyžaduje sjednocení D2.
4. Nepotvrzovat „Odesláno kamarádovi“: systémová nabídka ani aplikace nezaručují,
   že příjemce sdílení dostal.

Nativní API vyžaduje podporu prohlížeče, zabezpečený kontext a přímé uživatelské
gesto; zrušení se vrací jako `AbortError`. Viz [MDN share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share).
Také zápis do schránky může být odmítnutý; viz [MDN Clipboard.writeText](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText).

## Tisk

Nová akce má otevřít tiskový dialog prohlížeče; není potřeba tiskový widget z kitu
ani nová PDF služba. Připravený tiskový obsah využije současná data a typografii;
skryje navigaci, sidebar, reklamy, doporučení, nákupní ovladače a otevřené dialogy.
Tisk nerozhoduje podle právě zaškrtnutých oblíbených položek.

**Zvolený výchozí obsah:** produktový list bez seznamu variant. Zobrazuje společný
popis, obrázek a parametry; u samostatné prodejné položky také její konkrétní cenu.
Nejde o tisk stovek variant ani pouze pěti vykreslených nákupních řádků. Případný
budoucí tisk všech variant vyžaduje kompletní výpis bez stránkování a virtualizace;
varianta se samostatným listem potřebuje SKU a vlastní parametry.

`window.print()` otevře dialog a `@media print` upraví tiskový výstup; zavření
dialogu neznamená úspěšný tisk. Viz [MDN print](https://developer.mozilla.org/en-US/docs/Web/API/Window/print)
a [MDN tiskové styly](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing).

## Rozsah a ověření před dokončením implementace

Navržené pořadí: reference/úložiště → výběr variant → napojení karet a detailu
→ minimální skutečný výpis oblíbených (část TASK 13) → Sdílet → produktový list pro tisk.
Nové sdílené komponenty kitu ani změna jeho verze nejsou pro základ návrhu nutné.
Změny omezit na `akros-storefront/**`, neimportovat soukromé moduly OntOS.

Ověřit nezávislé varianty stejného produktu, reload, práci s uloženým výběrem,
filtrování bez ztráty výběru, hromadný výběr pouze výsledků, zrušení bez zápisu,
odebrání poslední varianty, poškozené úložiště a selhání zápisu. V browseru také
fokus, Space, Escape, návrat na různé původní spouštěče a mobilní klávesnici.

Zkontrolovat běžné šířky včetně 320 px, dlouhá SKU a největší katalogovou skupinu.
Pro sdílení testovat podporu, nepodporu, odmítnutí, zrušení a ruční kopírování;
pro tisk emulaci print CSS i náhled / uložení do PDF, bez fyzického tiskového úkonu.
Při implementaci se vrátit ke storefront a UI-kit skillům a příslušným referencím.
Finální gate zůstává `npm run check` a relevantní browserové sady.

## Realizovaný výsledek a ověření

Následující záznam zachycuje první dodání TASK 02. Pozdější rozšíření společného
dialogu na ostatní akce, přesné odkazy a oprava základního stínu jsou v
[navazujícím záznamu](akros-task-03-actions-review.md).

- Dialog je dostupný z produktových karet i vícevariantového detailu. Obsahuje hledání,
  české checkboxy, počet výsledků/vybraných položek a potvrzení „Uložit výběr“.
  Zrušení nezapisuje změny. Konkrétní varianta má přímé přepnutí s kitovým toastem.
- Stav je společný pro karty, detail a skutečný seznam na `/oblibene`, obnovuje se po
  reloadu i při změně v jiné záložce. Ukládají se reference, nikoli ceny a stav skladu.
  Samostatná položka bez variant používá `variantId: null`. Staré booleany se neexpandují.
- `src/features/favorites/` vlastní klientskou kompozici a úložiště navazuje na
  `src/mock-storefront/favorites.ts`. Read-only `/api/favorites/catalog/[slug]` načítá
  pouze otevřený produkt z dosavadního veřejného katalogu; neukládá zákaznická data.
- Základní skutečný výpis a odebírání pokrývají část TASK 13. Dosavadní odkaz přes SKU
  filtr zůstává; přesná identita v URL a otevření variantního modalu tím nejsou hotové.
- „Sdílet“ používá kanonický odkaz na produkt, nativní nabídku nebo kopírování/e-mail.
  Zrušení nativní nabídky nic nekopíruje. Při zamítnutí schránky je k dispozici textový odkaz.
- „Tisk“ používá samostatný produktový list. Obrázek sdílí zdroj a velikostní předpis
  hlavní fotografie a načítá se bez čekání na zviditelnění skrytého tiskového obsahu.
- Vzhled patří do `_akros-favorites.css`, rozložení do `styles/favorites.css`.
  Mobil skládá buňky pod sebe, nízké okno zkracuje záhlaví a zachovává seznam i akce.
  Výška seznamu vychází z flex kompozice dialogu, bez dalšího nezávislého limitu `maxHeight`.
  Neprůhledné pozadí Popoveru je mapované tokenem; jeho kompilovaný shadow alias stejně
  jako u mini-košíku vyžaduje podporovanou aplikační utilitu `shadow-md`.
- Tiskové CSS je cílená výjimka pro papír/PDF (`@media print` a `@page`), nikoli
  nový vzhled běžných ovladačů. UI kit zůstává na verzi 0.56.1.

Prošlo `npm run check`: formátování, lint bez nových varování, typy, všech **155 testů
ve 29 souborech** a produkční build. Prošla celá sada `npm run test:browser`, včetně
původního nákupu, účtu, navigace, obsahu, tokenů a typografie; závěrečný audit ověřil
589 layoutů na 31 stránkách.

Nová sada `npm run test:favorites` ověřuje také chybové načtení a opakování, selhání
zápisu, prázdný filtr, hromadné odebrání pouze výsledků, dostupnost checkboxů i mimo
sklad a spuštění z homepage. Dva produkty prošly devíti šířkami 320–1920 px, včetně
největší skupiny 386 variant, navíc třemi nízkými okny. Ověřená je klávesnice, návrat
fokusu, nativní větev sdílení, kopírování i ruční náhrada a skutečný tiskový výstup do PDF.
Screenshoty a PDF jsou lokální artefakty v `test-results/favorites/`.

Při souběžném běhu jednou selhal původní test SKU našeptávače. Samostatný běh prošel
10/10 a závěrečný celý gate bez souběžného browserového běhu prošel 155/155. Našeptávač,
jeho testy ani timeouty nebyly kvůli tomu změněné. Commit ani GitHub issue změna není
součástí této realizace.
