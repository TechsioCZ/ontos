# Výběr variant pro akce produktu a sjednocení stínu

Upřesnění uživatele po TASK 02, 21. 10. 2026: stejnou tabulku variant používat pro
hlídání a sdílení, srovnat akce v řádku a zeslabit základní stín. Uživatel výslovně
potvrdil sdílení více vybraných variant jedním odkazem. Rozšíření zahrnuje i dotaz,
aby všechny variantní akce používaly stejný výběr. GitHub issues se tímto nemění.

## Implementace

- `VariantSelectionDialog` je jedna společná kompozice kitového Dialogu, DataTable,
  checkboxů a hledání. Oblíbené, hlídání, dotaz a sdílení předávají jen příslušné
  popisky, počáteční výběr a potvrzovací akci. Filtrování ani zavření nemění uložený stav.
- Hlídání používá samostatné browserové úložiště `akros-demo-watched-variants-v1`.
  Ukládá konkrétní reference `productId` + `variantId`, obnovuje výběr a umožňuje
  odebrat všechny varianty. Nekoliduje s oblíbenými a neslibuje skutečná e-mailová
  upozornění. Stará kontejnerová hodnota se nerozšiřuje na všechny varianty.
- Validace referencí a browserové odběry jsou společné; oblíbené si zachovávají původní
  klíč a veřejné funkce. Dynamický read-only katalog zůstává beze změny.
- Sdílení před nativní nabídkou nebo kopírováním nabídne výběr více variant. URL má
  parametr `variantIds` s jedinečnými ID oddělenými čárkou. Produktová stránka ID
  ověří proti vlastnímu katalogu a ukáže právě tento výběr s odkazem na všechny varianty.
  Neznámý výběr se nenahradí jiným nákupním SKU. Legacy `variant` zůstává volným hledáním.
- Stejný přesný odkaz používají oblíbené. Největší skupina 386 variant se vejde pod
  testovaný rozpočet 7000 znaků URL. Sdílení není navázané na uložené oblíbené či hlídání.
- Dotaz předvyplňuje formulář produktu a vybraných variant, včetně SKU. Formulář
  nadále zpracovává ukázku pouze lokálně. Samostatné otevření kontaktů a FAQ se nemění.
- Náhradní nabídka sdílení se otevírá po uvolnění focus trapu výběrového dialogu,
  aby ji obnovení fokusu neuzavřelo. Zrušení nativního sdílení nic nekopíruje.

## Stín a zarovnání

Vykreslené pravidlo `.shadow-dialog-content` používá `--tw-shadow: var(--shadow-primary)`;
zkrácení aliasu v Tailwindu obchází lokální `--shadow-dialog-content`. Původní základ
skládal tři téměř černé vrstvy (včetně rozostření 20 px), proto vypadal příliš silně.

Nový `_akros-semantic.css` mapuje **`--shadow-primary: var(--shadow-md)`**. Hodnota je
`0 4px 6px rgba(0, 0, 0, 0.1)`, stejná jako u dosavadní hlavní plochy aplikace.
Zmizel neúčinný lokální override i nadbytečný `shadow-md` na nabídce sdílení.
Browserový test mění základní token za běhu a ověřuje skutečný stín dialogu.

Tlačítko sdílení je uvnitř Popover.Anchor. Původně mělo 32 px, zatímco přímé děti
řádku 40 px. Společný token `--height-form-control-sm` nyní přímo přebírá výšku
akcí; nejsou potřeba pomocné utility minimální výšky. Wrapper je inline flex.
Všechny akce mají 40 px na desktopu a 44 px na mobilu a sedí na stejné středové ose.

Oblíbené varianty jsou součástí stejného zalamovacího řádku jako hlídání, dotaz,
sdílení a tisk. Srdíčko i text tvoří jedno borderless tlačítko; uložený výběr doplňuje
počet variant. Původní samostatný řádek a jeho CSS byly odstraněny. U jednoduchého
produktu zůstává ikonové tlačítko u nákupu. Kontrola zarovnání a vodorovného přesahu
zahrnuje všech pět akcí na 14 šířkách 320–1920 px.

Mobilní kompozice zůstává společná. Poznámka o demo hlídání je v caption tabulky;
její mobilní display musí být block, aby se nezalomila do úzkého anonymního sloupce
a nezakryla varianty v nízkém okně.

## Rozsah a ověření

Tento krok nedokončuje samostatný modální detail varianty, obrázkové náhledy,
váhu ani přesun všech akcí do tohoto detailu z TASK 07. Společný plán 03/07
zůstává rozpracovaný. Uživatel následně schválil lokální commit celého bloku;
změny GitHub issues nejsou součástí požadavku.

Provedené cílené kontroly: testy přesných URL a největšího výběru, nezávislé odběry
hlídání/oblíbených, `test:product-actions` a rozšířený `test:favorites`. Browserová
sada akcí kontroluje 14 šířek 320–1920 px, skutečný stín, zrušení/uložení/obnovení
hlídání, odebrání posledních variant, předvyplněný dotaz a správné otevření či chybějící
sdílené varianty. Finální `npm run check` prošel včetně formátování, lintu,
TypeScriptu, 159 testů ve 30 souborech a produkčního buildu. Celé `npm run test:browser`
prošlo včetně závěrečného auditu 589 layoutů na 31 stránkách. Po finálním převedení
výšky akcí na společný token znovu prošel cílený `test:product-actions` i celý check.
Po začlenění oblíbených do společného řádku znovu prošel celý check, `test:product-actions`,
`test:favorites` a `test:theme`; vizuálně byly zkontrolovány screenshoty řádku při
1920, 1024, 390 a 320 px.
