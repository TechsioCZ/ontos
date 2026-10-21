---
name: akros-variants
overview: Upravit výpis, filtry, responzivní vzhled a prezentaci cen podle původních TASK 04, 05, 01 a 06.
todos:
  - id: task-04-variant-list
    content: TASK 04 – zobrazit pouze konkrétní varianty bez opakování kontejneru a prověřit úplný výpis bez stránkování.
    status: pending
  - id: task-05-relevant-filters
    content: TASK 05 – odstranit cenu a materiál z filtrace a ověřit automatické použití relevantních parametrů.
    status: pending
  - id: task-01-figma-layout
    content: TASK 01 – po ověření D1 upravit variantní výpis podle Figmy, zmenšit správné tlačítko a zachovat čitelné SKU.
    status: completed
  - id: task-06-concrete-prices
    content: TASK 06 – odstranit zobrazení cen Od na všech plochách a cenu vázat na konkrétní prodejnou položku.
    status: pending
isProject: false
---

# akros-variants

## Execution Notes

Navazuje na `akros-foundation`. Mapování na issues a otevřená rozhodnutí jsou v
[hlavním plánu](../IMPLEMENTATION-PLAN.md). Nepotřebuje čekat na ověření hmotností.

### TASK 04 – výpis variant · #1302

- Odstranit opakovaný název kontejneru z jednotlivých řádků. Zachovat názvy variant,
  SKU, parametry, dostupnost a nákupní ovládání konkrétní položky.
- Cíl je všechny odpovídající varianty bez stránkování po pěti. Změřit největší
  reálné skupiny: výchozí katalog obsahuje až 386 variant v jedné skupině.
- Ověřit dosažitelnost poslední varianty, hledání SKU a ovládání klávesnicí i na
  mobilu. Pokud bude nutná virtualizace nebo postupné načítání, doložit problém
  a potvrdit řešení; nevracet skrytě původní limit pěti položek.

Dokončeno: žádné varianty se neztrácejí, kontejner se neopakuje a zvolený způsob
zobrazení splňuje dohodnutou dostupnost všech výsledků i naměřenou odezvu ovládání.

### TASK 05 – filtrace · #1303

- Odstranit ovládání ceny a materiálu i jejich vliv na výsledky. Starý stav nesmí
  po reloadu nebo příchodu z odkazu dál neviditelně omezovat výpis.
- Ponechat parametry, které konkrétní typ produktu skutečně má. Nenutit všechny
  výrobky do dvojice průměr/délka odvozené jen z názvu.
- Prověřit živou filtraci po změně hodnoty; doporučený výsledek je bez potvrzovacího
  tlačítka. Před odstraněním potvrzení ověřit psaní desetinných čísel, mazání pole,
  slider, případné zpoždění a stabilitu fokusu. Výsledek ověření zapsat.

Dokončeno: změna parametru vrací správné varianty, reset obnoví celý seznam a
prázdný výsledek lze napravit. Nevhodné/chybějící parametry se neprezentují jako filtr.

### TASK 01 – Figma a responzivita · #1298

- Průběžný rozbor současného lokálu a deploye je v
  [TASK 01: rozbor před implementací](akros-task-01-review.md). Uživatel potvrdil
  kompaktní černé „Koupit celé balení“ z Figmy `8:1377`, tlačítko `8:1717`.
  Referenční rozměr na desktopu je 128 × 38 px; dotykové režimy zachovají větší
  ovládací plochu. D1 je pro tento prvek TASK 01 vyjasněné.
- Zmenšit potvrzený prvek přes podporované props a komponentové tokeny kitu.
  Vizuální zmenšení nesmí zničit dosažitelnost ovládání na dotykovém zařízení.
- Upravit tabulku/seznam/karty podle návrhu a skutečné šířky kontejneru. SKU zůstává
  celé dostupné a kopírovatelné, bez ořezu nebo nevhodného dělení jeho významových částí.

Dokončeno: porovnání s konkrétní Figmou a screenshoty na desktopu, notebooku,
tabletu a mobilu; funkční oba režimy nákupu, minimální množství i celé balení.

Ověření TASK 01 je zaznamenané v odkazovaném rozboru. Realizace proběhla jako první
podle následně potvrzeného pořadí uživatele; nevyžadovala změnu identity variant
ze společného základu ani implementaci TASK 04/05.

### TASK 06 – cena konkrétní položky · #1304

- Odstranit „Od“ ze všech cenových ploch: homepage, kategorií, výsledků vyhledávání,
  našeptávače, novinek, doporučení, detailu i oblíbených.
- Nepouze smazat prefix a ponechat nejnižší cenu kontejneru jako zdánlivě přesnou cenu.
  U nevybrané skupiny variant použít dohodnutou výzvu k výběru; konkrétní variantě
  a samostatnému prodejnému SKU zobrazit jejich skutečnou cenu.
- Zachovat přepočet podle množství, cenových pásem a DPH. Číselná data potřebná
  pro jiné funkce neodstraňovat bez ověření jejich spotřebitelů.

Dokončeno: cílený průchod všech cenových ploch nenajde prefix „Od“ ani zavádějící
kontejnerovou cenu; konkrétní nákupní cena a součty zůstávají správné.

## Constraints

Platí pravidla hlavního plánu. Neměnit celkovou šířku storefrontu. Bez ověření D1
netvrdit shodu s Figmou. Zachovat nákupní minima, balení, sklad a přepočet cen.

## Operator Guidance

Hlavní místa: `src/features/cart/product-purchase-form.tsx`, produktová route,
`product-grid.tsx`, vyhledávání a komponentové tokeny. Aktualizovat dosavadní
ověřování stránkování/cenových filtrů podle nových požadavků a projít všechny
cenové plochy. Po výpisu navazuje detail a oblíbené v `akros-detail`.
