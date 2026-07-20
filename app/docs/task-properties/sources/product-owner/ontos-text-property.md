# Readiness score: GOLD

- Sdílení property i vlastnictví hodnot je potvrzené.
- Rozsah rich textu je vymezen jako plné inline formátování, nikoliv druhý canvas.
- Mentions a Relations přebírají jednotné chování Core aplikace.
- Duplikace umožňuje uživateli rozhodnout, zda zkopírovat také hodnoty.

# A. Executive summary

`Text` je property společná pro celou kolekci tasků. Každý task má vlastní nezávislou hodnotu, která může být prázdná nebo obsahovat víceřádkový inline rich text.

Property podporuje plné inline formátování ve stylu Notion, včetně odkazů, barev, inline rovnic a prvků `Mention` a `Relation` poskytovaných Core aplikací. Nepodporuje samostatné obsahové bloky, protože ty patří do hlavního canvasu tasku.

Textovou property lze vyhledávat, filtrovat, řadit, přejmenovat, duplikovat a odstranit.

# B. Business cíl

Umožnit uživatelům evidovat u každého tasku samostatný formátovaný textový údaj, který:

- je součástí struktury tasků,
- lze zobrazit v různých pohledech,
- lze samostatně vyhledávat, filtrovat a řadit,
- může odkazovat na entity prostřednictvím Core Mentions a Relations,
- nenahrazuje hlavní obsahový canvas tasku.

# C. Aktéři

**Editor kolekce**

Může přidávat, přejmenovávat, duplikovat a odstraňovat properties společného schématu.

**Editor tasku**

Může upravovat hodnotu Text property u konkrétního tasku.

Jedna osoba může zastávat obě role.

# D. Scope

- vytvoření property typu `Text`,
- společná definice property pro celou kolekci tasků,
- vlastní hodnota pro každý task,
- prázdná výchozí hodnota,
- víceřádkový inline rich text,
- tučné písmo,
- kurzíva,
- podtržení,
- přeškrtnutí,
- inline code,
- textová a podkladová barva,
- hyperlink,
- inline rovnice,
- Core Mentions,
- Core Relations,
- vložení obsahu ze schránky,
- úprava a vymazání hodnoty,
- vyhledávání,
- filtrování,
- řazení,
- přejmenování property,
- duplikace s volbou kopírování hodnot,
- odstranění property.

# E. Mimo scope

- nadpisové, seznamové a jiné samostatné bloky,
- tabulky, obrázky, soubory, callouty a embed prvky,
- vlastní implementace Mentions nebo Relations,
- hlavní canvas tasku,
- změna Text property na jiný typ,
- komentáře k textu nebo jeho části,
- historie verzí,
- AI generování hodnot,
- automatizace a formule,
- detailní oprávnění k odkazovaným entitám,
- technický formát ukládání rich textu.

# F. Business pravidla

## F1. Definice property

1. Text property patří do společného schématu jedné kolekce tasků.
2. Po vytvoření je dostupná u všech existujících i budoucích tasků dané kolekce.
3. Každý task má vlastní nezávislou hodnotu.
4. Výchozí hodnota je prázdná.
5. Property musí mít název splňující společná pravidla Core aplikace pro názvy properties.

## F2. Hodnota

1. Hodnota může být prázdná.
2. Hodnota může obsahovat více řádků.
3. Úprava jednoho tasku nesmí změnit hodnotu jiného tasku.
4. Vymazání hodnoty neodstraní definici property.
5. Hodnota obsahující pouze mezery a prázdné řádky se považuje za prázdnou.
6. Není stanoven samostatný business limit délky specifický pro Text property.

## F3. Rich text

Text property podporuje inline:

- bold,
- italic,
- underline,
- strikethrough,
- inline code,
- textovou barvu,
- podkladovou barvu,
- hyperlink,
- inline equation,
- Core Mention,
- Core Relation.

Jednotlivé úseky jedné hodnoty mohou mít rozdílné formátování.

Text property nepodporuje samostatné blokové elementy. Obsah vložený ze schránky se převede na podporovaný inline obsah; nepodporovaná bloková struktura se nevytvoří jako bloky uvnitř property.

## F4. Mentions a Relations

1. Text property používá společné Mentions a Relations z Core aplikace.
2. Nedefinuje vlastní způsob výběru, zobrazení, oprávnění ani životního cyklu odkazovaných entit.
3. Běžný text, Mention a Relation mohou existovat v jedné hodnotě a v libovolném pořadí.
4. Při kopírování hodnoty se zachová význam Core reference, nikoliv pouze její viditelný název.
5. Nedostupné nebo odstraněné cíle se zobrazují podle pravidel Core aplikace.

## F5. Vyhledávání a filtrování

Vyhledávání pracuje s čitelným textovým obsahem bez ohledu na vizuální formátování.

Podporované filtry:

- obsahuje,
- neobsahuje,
- rovná se,
- nerovná se,
- začíná na,
- končí na,
- je prázdné,
- není prázdné.

Textové porovnávání používá společná pravidla Core aplikace pro velikost písmen, diakritiku a normalizaci.

Core Mentions a Relations se do textového vyhledávání zapojují podle společných pravidel Core vyhledávání.

## F6. Řazení

1. Text property lze řadit vzestupně a sestupně.
2. Porovnání neprázdných hodnot používá společné textové řazení Core aplikace.
3. Vizuální formátování nemění pořadí.
4. Prázdné hodnoty jsou vždy uvedeny za neprázdnými hodnotami.

## F7. Přejmenování

1. Přejmenování změní pouze název property.
2. Typ property zůstává `Text`.
3. Hodnoty všech tasků zůstávají zachovány.
4. Rich text i Core reference zůstávají zachovány.

## F8. Duplikace

Při duplikování uživatel zvolí jednu variantu:

### Duplikovat bez hodnot

- vznikne nová property typu `Text`,
- zachová se konfigurace property,
- všechny tasky mají v nové property prázdnou hodnotu.

### Duplikovat včetně hodnot

- vznikne nová property typu `Text`,
- pro každý task se zkopíruje aktuální hodnota,
- zachová se text, formátování a Core reference,
- původní a nová hodnota jsou po vytvoření nezávislé.

Původní property se duplikací nezmění.

## F9. Odstranění

1. Odstranění property ji odstraní ze společného schématu.
2. Současně odstraní její hodnoty ze všech tasků.
3. Obsahuje-li alespoň jeden task neprázdnou hodnotu, systém před odstraněním vyžaduje potvrzení.
4. Zrušení potvrzení nezmění property ani její hodnoty.

# G. Klíčové výjimky a hraniční situace

- Název property je prázdný nebo neplatný podle Core pravidel.
- Hodnota obsahuje pouze whitespace.
- Uživatel vloží kombinaci podporovaného inline obsahu a nepodporovaných bloků.
- Jeden textový úsek kombinuje více formátování.
- Core Mention nebo Relation odkazuje na později nedostupnou entitu.
- Duplikace probíhá bez hodnot.
- Duplikace probíhá včetně prázdných i neprázdných hodnot.
- Hodnota původní property se po duplikaci změní.
- Odstraňovaná property obsahuje neprázdná data.
- Řazení obsahuje prázdné i neprázdné hodnoty.

# H. Akceptační kritéria

1. Vytvořená Text property se objeví u všech tasků stejné kolekce.
2. Existující i nové tasky mají výchozí prázdnou hodnotu.
3. Změna hodnoty jednoho tasku neovlivní ostatní tasky.
4. Hodnota zachová více řádků a všechna podporovaná inline formátování.
5. Property nepřijme samostatné obsahové bloky.
6. Core Mentions a Relations lze kombinovat s běžným textem.
7. Vyhledávání najde text bez ohledu na jeho formátování.
8. Všechny definované textové filtry vracejí odpovídající tasky.
9. Property lze řadit vzestupně a sestupně.
10. Přejmenování zachová všechny hodnoty.
11. Duplikace bez hodnot vytvoří prázdné hodnoty.
12. Duplikace včetně hodnot zachová obsah, formátování a Core reference.
13. Změny v duplikované property po vytvoření neovlivní originál.
14. Odstranění neprázdné property vyžaduje potvrzení.
15. Potvrzené odstranění odstraní property i všechny její hodnoty.

# I. BDD scénáře v Gherkinu

```gherkin
Feature: Text property tasku

  Text property umožňuje evidovat u každého tasku
  samostatnou víceřádkovou inline rich-text hodnotu.

  Rule: Text property je společná pro kolekci tasků

    Scenario: Vytvoření Text property
      Given uživatel může upravovat schéma kolekce tasků
      When vytvoří property typu "Text" s názvem "Kontext"
      Then kolekce obsahuje property "Kontext" typu "Text"
      And property je dostupná u všech existujících tasků
      And její hodnota je u všech existujících tasků prázdná

    Scenario: Nový task získá existující Text property
      Given kolekce obsahuje Text property "Kontext"
      When je v kolekci vytvořen nový task
      Then nový task obsahuje property "Kontext"
      And její hodnota je prázdná

    Scenario: Vytvoření property s neplatným názvem
      Given uživatel vytváří Text property
      When zadá název, který nesplňuje pravidla Core aplikace
      Then property není vytvořena
      And uživatel je informován, že název musí opravit

  Rule: Každý task má vlastní nezávislou hodnotu

    Scenario: Zadání textové hodnoty
      Given task má prázdnou Text property "Kontext"
      When uživatel zadá "Čekáme na potvrzení klienta"
      Then property obsahuje "Čekáme na potvrzení klienta"

    Scenario: Úprava hodnoty jednoho tasku
      Given task "A" a task "B" mají Text property "Kontext"
      And obě hodnoty jsou prázdné
      When uživatel nastaví u tasku "A" hodnotu "Čekáme na klienta"
      Then task "A" obsahuje hodnotu "Čekáme na klienta"
      And hodnota tasku "B" zůstává prázdná

    Scenario: Vymazání hodnoty
      Given Text property obsahuje neprázdnou hodnotu
      When uživatel odstraní celý její obsah
      Then hodnota property je prázdná
      And samotná property zůstává zachována

    Scenario: Hodnota obsahuje pouze whitespace
      Given task má Text property
      When uživatel zadá pouze mezery a prázdné řádky
      Then hodnota property je považována za prázdnou

  Rule: Hodnota podporuje víceřádkový inline rich text

    Scenario: Uložení víceřádkového textu
      Given uživatel upravuje Text property
      When zadá text obsahující více řádků
      Then systém zachová obsah i zalomení řádků

    Scenario: Formátování části hodnoty
      Given Text property obsahuje text "Urgentní požadavek"
      When uživatel označí slovo "Urgentní" tučně
      Then slovo "Urgentní" je zobrazeno tučně
      And slovo "požadavek" si zachová původní formátování

    Scenario: Kombinace podporovaných formátů
      Given uživatel upravuje Text property
      When vytvoří hodnotu obsahující bold, kurzívu, inline code, barvu a hyperlink
      Then systém zachová všechny použité podporované formáty
      And všechny části zůstanou součástí jedné hodnoty

    Scenario: Vložení podporovaného formátovaného textu
      Given schránka obsahuje podporovaný inline rich text
      When jej uživatel vloží do Text property
      Then systém zachová podporovaný text a formátování

    Scenario: Vložení nepodporovaných bloků
      Given schránka obsahuje nadpis, seznam a formátovaný text
      When uživatel obsah vloží do Text property
      Then nevzniknou samostatné nadpisové ani seznamové bloky
      And podporovaný obsah je vložen jako inline text
      And nepodporovaná bloková struktura je odstraněna

  Rule: Mentions a Relations poskytuje Core aplikace

    Scenario: Vložení Mention do textu
      Given Core aplikace umožňuje zmínit dostupnou entitu
      And uživatel upravuje Text property
      When vloží Core Mention
      Then Mention je součástí textové hodnoty
      And zobrazuje se podle pravidel Core aplikace

    Scenario: Kombinace textu, Mention a Relation
      Given uživatel upravuje Text property
      When zadá běžný text následovaný Core Mention a Core Relation
      Then všechny prvky zůstanou součástí jedné hodnoty
      And zachová se jejich pořadí

    Scenario: Odkazovaná entita přestane být dostupná
      Given Text property obsahuje Core Mention nebo Relation
      When cílová entita přestane být dostupná
      Then ostatní obsah Text property zůstane zachován
      And Core prvek se zobrazí podle pravidel Core aplikace

  Rule: Textové hodnoty lze vyhledávat a filtrovat

    Scenario: Vyhledání podle formátovaného textu
      Given task obsahuje tučně formátovaný text "Migrace API"
      When uživatel vyhledá "Migrace API"
      Then task je zahrnut do výsledků

    Scenario Outline: Filtrování textové hodnoty
      Given task má v Text property hodnotu "<hodnota>"
      When uživatel použije filtr "<filtr>" s argumentem "<argument>"
      Then zahrnutí tasku do výsledku je "<výsledek>"

      Examples:
        | hodnota                | filtr           | argument      | výsledek |
        | Dokončit migraci API   | obsahuje        | API           | ano      |
        | Dokončit migraci API   | neobsahuje      | fakturace     | ano      |
        | Migrace API            | rovná se        | Migrace API   | ano      |
        | Migrace API            | nerovná se      | Fakturace     | ano      |
        | Migrace API            | začíná na       | Migrace       | ano      |
        | Migrace API            | končí na        | API           | ano      |

    Scenario: Filtrování prázdné hodnoty
      Given task "A" má neprázdnou Text property
      And task "B" má prázdnou Text property
      When uživatel použije filtr "je prázdné"
      Then je zahrnut task "B"
      And task "A" není zahrnut

    Scenario: Filtrování neprázdné hodnoty
      Given task "A" má neprázdnou Text property
      And task "B" má prázdnou Text property
      When uživatel použije filtr "není prázdné"
      Then je zahrnut task "A"
      And task "B" není zahrnut

  Rule: Textové hodnoty lze řadit

    Scenario: Vzestupné řazení
      Given task "A" má hodnotu "Beta"
      And task "B" má hodnotu "Alfa"
      When uživatel nastaví vzestupné řazení podle Text property
      Then task "B" je před taskem "A"

    Scenario: Prázdné hodnoty jsou řazeny poslední
      Given task "A" má hodnotu "Alfa"
      And task "B" má prázdnou hodnotu
      When uživatel seřadí tasky podle Text property
      Then task "B" je za taskem "A"

  Rule: Definici Text property lze přejmenovat

    Scenario: Přejmenování Text property
      Given property "Kontext" obsahuje hodnoty u existujících tasků
      When uživatel property přejmenuje na "Shrnutí"
      Then property se jmenuje "Shrnutí"
      And všechny hodnoty zůstávají zachovány
      And jejich formátování a Core reference zůstávají zachovány

  Rule: Při duplikaci uživatel rozhodne o kopírování hodnot

    Scenario: Duplikování bez hodnot
      Given Text property "Kontext" obsahuje hodnoty u tasků
      When uživatel property duplikuje
      And zvolí možnost "Bez hodnot"
      Then vznikne nová Text property
      And původní property zůstane beze změny
      And nová property má u všech tasků prázdnou hodnotu

    Scenario: Duplikování včetně hodnot
      Given Text property "Kontext" obsahuje formátované hodnoty a Core reference
      When uživatel property duplikuje
      And zvolí možnost "Včetně hodnot"
      Then vznikne nová Text property
      And každý task obsahuje kopii své původní hodnoty
      And formátování a Core reference zůstávají zachovány

    Scenario: Hodnoty jsou po duplikaci nezávislé
      Given Text property byla duplikována včetně hodnot
      When uživatel upraví hodnotu v nové property
      Then hodnota původní property zůstane beze změny

  Rule: Text property lze odstranit

    Scenario: Odstranění prázdné Text property
      Given Text property neobsahuje u žádného tasku neprázdnou hodnotu
      When ji uživatel odstraní
      Then property již není součástí kolekce

    Scenario: Požadavek na odstranění neprázdné property
      Given Text property obsahuje alespoň jednu neprázdnou hodnotu
      When uživatel požádá o její odstranění
      Then systém upozorní na odstranění hodnot všech tasků
      And vyžádá potvrzení

    Scenario: Potvrzení odstranění neprázdné property
      Given uživatel byl upozorněn na odstranění hodnot
      When odstranění potvrdí
      Then property již není součástí kolekce
      And její hodnoty již nejsou dostupné u žádného tasku

    Scenario: Zrušení odstranění neprázdné property
      Given uživatel byl upozorněn na odstranění hodnot
      When odstranění zruší
      Then property zůstává zachována
      And všechny její hodnoty zůstávají beze změny
```

# J. Explicitní hypotézy

1. Dialog duplikace má jako bezpečný výchozí stav zvoleno **Bez hodnot**.
2. Duplikovaná property dostane automaticky rozlišitelný pracovní název, který může uživatel upravit.
3. Prázdné hodnoty se při vzestupném i sestupném řazení zobrazují poslední.
4. Pravidla porovnávání textu, práce s diakritikou a velikostí písmen přebírá Text property z Core aplikace.
5. Chování odstraněných nebo nedostupných Mention a Relation cílů je plně definováno Core aplikací.
6. Při vložení nepodporovaných bloků se zachová jejich čitelný text a podporované inline formátování, nikoliv jejich blokový typ.
