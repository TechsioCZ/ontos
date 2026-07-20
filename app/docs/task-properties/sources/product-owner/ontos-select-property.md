# Readiness score

## GOLD

- Sdílené schéma, vznik, duplikace i odstranění property mají jednoznačný dopad na všechny tasky.
- Je určeno chování jedné hodnoty, prázdného stavu a vytváření nových možností.
- Je vyřešeno odstranění používané možnosti včetně upozornění na počet dotčených tasků.
- Obrázky doplňují podporované způsoby řazení možností.

# A. Executive summary

`Select` je property sdíleného schématu tasků. Každý task může mít v této property nejvýše jednu hodnotu z nakonfigurovaného seznamu možností, případně stav `Empty`.

Konfigurace property, seznam možností a způsob jejich řazení jsou společné pro všechny tasky používající dané schéma. Konkrétní vybraná hodnota je samostatná pro každý task.

Uživatel může:

- vybírat existující možnost,
- vytvořit novou možnost přímo při nastavování hodnoty,
- spravovat možnosti property,
- řadit možnosti manuálně nebo abecedně,
- duplikovat property s volitelným kopírováním hodnot,
- odstranit možnost nebo celou property po potvrzení dopadu.

# B. Business cíl

Umožnit konzistentní kategorizaci tasků pomocí jedné hodnoty z řízeného seznamu, která může být následně využita pro filtrování, řazení a seskupování tasků.

# C. Aktéři

## Uživatel upravující task

- nastavuje hodnotu Select property,
- mění hodnotu,
- odstraňuje hodnotu,
- může vytvořit novou možnost přímo během výběru.

## Uživatel spravující property

- přidává, přejmenovává, přebarvuje, řadí a odstraňuje možnosti,
- duplikuje property,
- odstraňuje property ze schématu.

Konkrétní oprávnění jednotlivých rolí jsou mimo scope.

# D. Scope

- vytvoření Select property ve sdíleném schématu,
- zpřístupnění property na všech taskech schématu,
- stav `Empty`,
- výběr právě jedné možnosti,
- změna a odstranění hodnoty,
- vytvoření možnosti během výběru,
- správa názvu, barvy a pořadí možností,
- manuální a abecední řazení možností,
- odstranění používané možnosti,
- duplikace property,
- volitelné kopírování hodnot při duplikaci,
- odstranění property ze schématu,
- základní filtrační podmínky.

# E. Mimo scope

- oprávnění ke správě properties a možností,
- Multi-select,
- Status property,
- převod Select property na jiný typ,
- výchozí hodnota,
- povinné vyplnění,
- automatizace,
- auditní historie,
- obnova smazané property nebo možnosti,
- technická architektura a výkon hromadných změn.

# F. Business pravidla

## F1. Property ve sdíleném schématu

1. Select property je součástí jednoho sdíleného schématu tasků.
2. Po vytvoření je property dostupná u všech tasků používajících toto schéma.
3. U všech existujících tasků má nová property hodnotu `Empty`.
4. Nově vytvořený task obsahuje všechny properties svého schématu.
5. Nová Select property má na novém tasku hodnotu `Empty`, dokud není zvolena možnost.
6. Konfigurace property je společná pro všechny tasky schématu.
7. Hodnota property je samostatná pro každý task.
8. Změna hodnoty jednoho tasku neovlivní hodnoty ostatních tasků.

## F2. Hodnota Select property

1. Hodnota může být:
   - `Empty`, nebo
   - právě jedna Select možnost.
2. Současný výběr více možností není podporován.
3. Výběr nové možnosti nahradí původní hodnotu.
4. Odstranění hodnoty vrátí property daného tasku do stavu `Empty`.
5. Odstranění hodnoty z tasku neodstraní property ze schématu.

## F3. Select možnosti

Každá možnost obsahuje:

- název,
- barvu,
- pozici použitou při manuálním řazení.

Pravidla:

1. Název možnosti nesmí být prázdný.
2. Název je před uložením vyhodnocen bez mezer na začátku a konci.
3. V rámci jedné property nelze vytvořit dvě možnosti se stejným názvem bez ohledu na velikost písmen.
4. Stejný název lze použít v jiné Select property.
5. Změna názvu nebo barvy se projeví u všech tasků používajících danou možnost.
6. Přejmenování možnosti nezpůsobí ztrátu hodnoty tasků.
7. Barva je vizuální atribut a nemění business význam možnosti.

## F4. Vytvoření možnosti během výběru

1. Uživatel může při nastavování hodnoty vyhledat možnost podle názvu.
2. Pokud odpovídající možnost neexistuje, může ji přímo vytvořit.
3. Nově vytvořená možnost:
   - je přidána do konfigurace sdílené property,
   - je dostupná také na ostatních taskech stejného schématu,
   - je zároveň vybrána jako hodnota aktuálního tasku.
4. Nelze tímto způsobem vytvořit prázdnou nebo duplicitní možnost.

## F5. Řazení možností

Property podporuje tři režimy:

### Manual

- možnosti se zobrazují v ručně nastaveném pořadí,
- uživatel může pořadí změnit,
- přejmenování možnosti samo o sobě její pozici nemění.

### Alphabetical

- možnosti se zobrazují vzestupně podle názvu,
- pořadí se automaticky přepočítá po vytvoření nebo přejmenování možnosti,
- ruční změna pořadí není v tomto režimu rozhodující.

### Reverse alphabetical

- možnosti se zobrazují sestupně podle názvu,
- pořadí se automaticky přepočítá po vytvoření nebo přejmenování možnosti,
- ruční změna pořadí není v tomto režimu rozhodující.

Zvolený režim řazení je součástí sdílené konfigurace property.

## F6. Odstranění Select možnosti

1. Pokud možnost není použita na žádném tasku, může být po potvrzení odstraněna.
2. Pokud je možnost použita, potvrzovací dialog musí uvést celkový počet tasků, které tuto možnost aktuálně používají.
3. Uživatel nemusí vybírat náhradní možnost.
4. Pokud uživatel odstranění potvrdí:
   - možnost se odstraní z konfigurace property,
   - všechny tasky, které ji používaly, přejdou u této property do stavu `Empty`,
   - ostatní hodnoty a možnosti zůstanou beze změny.
5. Pokud uživatel akci zruší, možnost ani hodnoty tasků se nezmění.

## F7. Duplikace property

1. Duplikací vznikne nová samostatná property ve stejném schématu.
2. Duplikát převezme konfiguraci původní property:
   - typ `Select`,
   - možnosti,
   - názvy možností,
   - barvy,
   - manuální pořadí,
   - režim řazení.
3. Možnosti duplikátu jsou nové nezávislé možnosti.
4. Při každé duplikaci se systém zeptá, zda mají být zkopírovány také hodnoty.
5. Pokud uživatel kopírování hodnot potvrdí:
   - hodnoty se zkopírují pro všechny existující tasky schématu,
   - vybraná možnost se namapuje na odpovídající možnost duplikátu,
   - `Empty` zůstane `Empty`.
6. Pokud uživatel kopírování odmítne, nová property bude u všech existujících tasků `Empty`.
7. Pozdější změna původní property neovlivní duplikát.
8. Pozdější změna duplikátu neovlivní původní property.

## F8. Odstranění celé property

1. Property nelze odstranit pouze z jednoho tasku.
2. Odstranění zahájené v kontextu tasku znamená odstranění property ze sdíleného schématu.
3. Před odstraněním se zobrazí potvrzovací dialog.
4. Dialog musí upozornit, že:
   - property bude odstraněna ze všech tasků schématu,
   - všechny uložené hodnoty této property budou odstraněny.
5. Po potvrzení:
   - property zmizí ze schématu,
   - property zmizí ze všech tasků schématu,
   - všechny její hodnoty se odstraní.
6. Po zrušení se nic nezmění.

## F9. Filtrování

Select property podporuje minimálně podmínky:

- `is` – hodnota odpovídá konkrétní možnosti,
- `is not` – hodnota neodpovídá konkrétní možnosti,
- `is empty` – property je ve stavu `Empty`,
- `is not empty` – property obsahuje libovolnou možnost.

# G. Klíčové výjimky a hraniční situace

1. Vytvoření možnosti se stejným názvem, ale jinou velikostí písmen, je odmítnuto.
2. Název obsahující pouze mezery je považován za prázdný.
3. Přejmenování možnosti na již existující název je odmítnuto.
4. Odstranění používané možnosti může ovlivnit jeden i mnoho tasků; dialog vždy používá aktuální celkový počet.
5. Task s hodnotou `Empty` zůstane při duplikaci s kopírováním hodnot `Empty`.
6. Zrušení dialogu duplikace nebo odstranění nesmí provést částečnou změnu.
7. Přechod z abecedního řazení na manuální zachová aktuálně zobrazené pořadí jako výchozí manuální pořadí.
8. Vytvoření nové možnosti v manuálním režimu ji zařadí na konec seznamu.
9. Vytvoření nové možnosti v abecedním režimu ji zařadí podle jejího názvu.

# H. Akceptační kritéria

- Select property se po vytvoření objeví na všech taskech daného schématu.
- Existující tasky mají novou property ve stavu `Empty`.
- Na jednom tasku nelze vybrat více než jednu možnost.
- Nová hodnota nahradí původní hodnotu.
- Uživatel může vrátit hodnotu do stavu `Empty`.
- Novou možnost lze vytvořit přímo při nastavování hodnoty.
- Nová možnost je následně dostupná na všech taskech schématu.
- Možnosti lze řadit manuálně, abecedně a obráceně abecedně.
- Odstranění používané možnosti zobrazí počet dotčených tasků.
- Potvrzené odstranění možnosti nastaví dotčené tasky na `Empty`.
- Duplikát převezme konfiguraci, ale je dále nezávislý.
- Při každé duplikaci je vyžádáno rozhodnutí o kopírování hodnot.
- Odstranění property vyžaduje potvrzení dopadu na všechny tasky.
- Vymazání hodnoty jednoho tasku nesmí odstranit property ze schématu.

# I. BDD scénáře v Gherkinu

```gherkin
Feature: Select property ve sdíleném schématu tasků
  Select property umožňuje každému tasku přiřadit nejvýše jednu hodnotu
  ze sdíleně konfigurovaného seznamu možností.

  Rule: Select property je součástí sdíleného schématu

    Scenario: Přidání Select property do schématu s existujícími tasky
      Given schéma používají tasky "Task A" a "Task B"
      When uživatel přidá Select property "Priorita"
      Then property "Priorita" je dostupná na obou tascích
      And hodnota property "Priorita" je na obou tascích Empty

    Scenario: Nový task převezme Select property ze schématu
      Given schéma obsahuje Select property "Priorita"
      When je podle schématu vytvořen nový task
      Then nový task obsahuje property "Priorita"
      And hodnota property je Empty

    Scenario: Hodnota je samostatná pro každý task
      Given tasky "Task A" a "Task B" používají stejné schéma
      And oba obsahují Select property "Priorita"
      When uživatel nastaví na tasku "Task A" hodnotu "Vysoká"
      Then task "Task A" má hodnotu "Vysoká"
      And task "Task B" zůstane Empty

  Rule: Select property obsahuje nejvýše jednu hodnotu

    Scenario: Nastavení hodnoty prázdné property
      Given task má Select property "Priorita" ve stavu Empty
      And property obsahuje možnost "Vysoká"
      When uživatel vybere možnost "Vysoká"
      Then hodnota property je "Vysoká"

    Scenario: Nová hodnota nahradí původní
      Given task má v property "Priorita" hodnotu "Nízká"
      When uživatel vybere možnost "Vysoká"
      Then hodnota property je "Vysoká"
      And možnost "Nízká" již není vybrána

    Scenario: Odstranění hodnoty z jednoho tasku
      Given task má v property "Priorita" hodnotu "Vysoká"
      When uživatel odstraní hodnotu
      Then hodnota property na tasku je Empty
      And property "Priorita" zůstane součástí schématu

  Rule: Možnost lze vytvořit během výběru hodnoty

    Scenario: Vytvoření a výběr nové možnosti
      Given Select property "Stav klienta" neobsahuje možnost "Čeká na odpověď"
      When uživatel zadá "Čeká na odpověď"
      And potvrdí vytvoření nové možnosti
      Then možnost "Čeká na odpověď" je přidána do property
      And aktuální task má hodnotu "Čeká na odpověď"
      And možnost je dostupná na všech ostatních tascích stejného schématu

    Scenario: Nelze vytvořit duplicitní možnost
      Given Select property již obsahuje možnost "Vysoká"
      When uživatel zkusí vytvořit možnost "vysoká"
      Then nová možnost není vytvořena
      And původní možnost zůstane beze změny

    Scenario: Nelze vytvořit možnost bez názvu
      Given uživatel vytváří novou Select možnost
      When zadá pouze prázdné znaky
      Then nová možnost není vytvořena

  Rule: Konfigurace možnosti je sdílená

    Scenario: Přejmenování používané možnosti
      Given možnost "Urgentní" je vybrána na několika tascích
      When uživatel přejmenuje možnost na "Kritická"
      Then všechny dotčené tasky zobrazují hodnotu "Kritická"
      And žádný dotčený task nepřejde do stavu Empty

    Scenario: Změna barvy možnosti
      Given možnost "Vysoká" má barvu "oranžová"
      When uživatel změní její barvu na "červená"
      Then se možnost na všech tascích zobrazuje červeně
      And její název a význam zůstávají beze změny

  Rule: Možnosti lze řadit podporovanými režimy

    Scenario: Manuální pořadí možností
      Given režim řazení property je "Manual"
      And možnosti jsou v pořadí "Nízká", "Střední", "Vysoká"
      When uživatel přesune možnost "Vysoká" na první pozici
      Then pořadí je "Vysoká", "Nízká", "Střední"

    Scenario: Abecední řazení možností
      Given property obsahuje možnosti "Střední", "Vysoká" a "Nízká"
      When uživatel nastaví řazení "Alphabetical"
      Then možnosti jsou zobrazeny v pořadí "Nízká", "Střední", "Vysoká"

    Scenario: Obrácené abecední řazení
      Given property obsahuje možnosti "Střední", "Vysoká" a "Nízká"
      When uživatel nastaví řazení "Reverse alphabetical"
      Then možnosti jsou zobrazeny v pořadí "Vysoká", "Střední", "Nízká"

    Scenario: Přejmenování možnosti aktualizuje abecední pořadí
      Given režim řazení property je "Alphabetical"
      And property obsahuje možnosti "Beta" a "Gamma"
      When uživatel přejmenuje možnost "Gamma" na "Alfa"
      Then možnosti jsou zobrazeny v pořadí "Alfa", "Beta"

    Scenario: Nová možnost je v manuálním režimu přidána na konec
      Given režim řazení property je "Manual"
      And property obsahuje možnosti "Nízká" a "Střední"
      When uživatel vytvoří možnost "Vysoká"
      Then pořadí je "Nízká", "Střední", "Vysoká"

  Rule: Odstranění možnosti informuje o dopadu

    Scenario: Odstranění nepoužívané možnosti
      Given možnost "Nízká" není vybrána na žádném tasku
      When uživatel zahájí její odstranění
      Then systém zobrazí potvrzovací dialog
      And dialog uvede, že možnost používá 0 tasků

    Scenario: Dialog uvede počet tasků používajících možnost
      Given možnost "Vysoká" používá celkem 12 tasků
      When uživatel zahájí její odstranění
      Then systém zobrazí potvrzovací dialog
      And dialog uvede, že možnost používá 12 tasků

    Scenario: Potvrzené odstranění používané možnosti
      Given možnost "Vysoká" používá celkem 12 tasků
      And je zobrazen potvrzovací dialog
      When uživatel odstranění potvrdí
      Then možnost "Vysoká" je odstraněna z property
      And všech 12 dotčených tasků má property ve stavu Empty
      And uživatel nemusí vybírat náhradní možnost

    Scenario: Zrušení odstranění používané možnosti
      Given možnost "Vysoká" používají existující tasky
      And je zobrazen potvrzovací dialog
      When uživatel odstranění zruší
      Then možnost "Vysoká" zůstane dostupná
      And hodnoty všech tasků zůstanou zachovány

  Rule: Duplikací vzniká samostatná property

    Scenario: Duplikace převezme konfiguraci
      Given Select property "Priorita" obsahuje možnosti:
        | název  | barva   |
        | Nízká  | zelená  |
        | Vysoká | červená |
      And režim řazení je "Manual"
      When uživatel property duplikuje
      Then vznikne nová samostatná Select property
      And nová property obsahuje kopie obou možností
      And zachová jejich názvy, barvy, pořadí a režim řazení

    Scenario: Duplikace vždy vyžádá rozhodnutí o hodnotách
      Given schéma obsahuje existující tasky
      When uživatel zahájí duplikaci Select property
      Then systém se zeptá, zda mají být zkopírovány také hodnoty
      And bez rozhodnutí duplikaci nedokončí

    Scenario: Duplikace se zkopírováním hodnot
      Given task "Task A" má hodnotu "Vysoká"
      And task "Task B" má hodnotu Empty
      When uživatel duplikuje property
      And zvolí zkopírování hodnot
      Then task "Task A" má v duplikátu odpovídající hodnotu "Vysoká"
      And task "Task B" má v duplikátu hodnotu Empty

    Scenario: Duplikace bez kopírování hodnot
      Given existující tasky mají v původní property různé hodnoty
      When uživatel duplikuje property
      And odmítne zkopírování hodnot
      Then nová property je na všech existujících tascích Empty

    Scenario: Změna původní property neovlivní duplikát
      Given property "Priorita kopie" vznikla duplikací property "Priorita"
      When uživatel přidá do property "Priorita" možnost "Kritická"
      Then možnost "Kritická" není přidána do property "Priorita kopie"

    Scenario: Změna duplikátu neovlivní původní property
      Given property "Priorita kopie" vznikla duplikací property "Priorita"
      When uživatel přejmenuje možnost v property "Priorita kopie"
      Then odpovídající možnost v property "Priorita" se nezmění

  Rule: Odstranění property ovlivní celé schéma

    Scenario: Zahájení odstranění property
      Given Select property "Priorita" je součástí sdíleného schématu
      When uživatel zvolí "Delete property"
      Then systém zobrazí potvrzovací dialog
      And dialog uvede, že property bude odstraněna ze všech tasků schématu
      And dialog upozorní na odstranění uložených hodnot

    Scenario: Zrušení odstranění property
      Given je zobrazen potvrzovací dialog odstranění property
      When uživatel odstranění zruší
      Then property zůstane součástí schématu
      And všechny hodnoty zůstanou zachovány

    Scenario: Potvrzení odstranění property
      Given Select property "Priorita" je dostupná na několika tascích
      And je zobrazen potvrzovací dialog
      When uživatel odstranění potvrdí
      Then property je odstraněna ze sdíleného schématu
      And property již není dostupná na žádném tasku tohoto schématu
      And všechny její hodnoty jsou odstraněny

  Rule: Select property podporuje filtrování podle hodnoty

    Scenario: Filtrování podle konkrétní možnosti
      Given některé tasky mají hodnotu "Vysoká"
      And ostatní tasky mají jinou hodnotu nebo Empty
      When uživatel použije podmínku "Priorita is Vysoká"
      Then výsledek obsahuje pouze tasky s hodnotou "Vysoká"

    Scenario: Filtrování prázdných hodnot
      Given některé tasky mají property "Priorita" ve stavu Empty
      When uživatel použije podmínku "Priorita is empty"
      Then výsledek obsahuje pouze tasky s hodnotou Empty
```

# J. Explicitní hypotézy

1. Potvrzené odstranění používané možnosti nastaví hodnotu dotčených tasků na `Empty`.
2. Přechod z automatického řazení na `Manual` zachová aktuálně zobrazené pořadí.
3. Nová možnost se v režimu `Manual` přidá na konec.
4. Abecední porovnání používá běžná pravidla jazyka rozhraní.
5. Název duplikované property bude systémem automaticky odlišen; přesný formát názvu není součástí této specifikace.

Původní formulace neřešila rozdíl mezi hodnotou tasku, možností a celou property. Po doplnění sdíleného schématu, dialogů s dopadem, duplikace a řazení je chování dostatečně konkrétní pro implementaci i akceptační testy.
