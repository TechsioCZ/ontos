# Status property — finální business specifikace

## A. Executive summary

Property **Status** eviduje právě jeden aktuální stav tasku. Je součástí sdíleného schématu, takže její konfigurace je společná pro všechny tasky používající dané schéma.

Statusové možnosti jsou rozdělené do tří pevných skupin:

- `To-do`
- `In progress`
- `Complete`

Property má vždy právě jednu možnost označenou jako `Default`. Nové tasky tuto hodnotu získají automaticky. Existující tasky při přidání property získají hodnotu `Empty`.

---

## B. Business cíl

Umožnit jednotné sledování fáze zpracování tasků a současně ponechat možnost přizpůsobit konkrétní statusové hodnoty potřebám daného taskového schématu.

---

## C. Aktéři

### Uživatel tasku

- nastavuje status tasku,
- mění status tasku,
- může hodnotu statusu vymazat.

### Správce schématu

- přidává Status property,
- spravuje statusové možnosti,
- určuje výchozí možnost,
- duplikuje property,
- odstraňuje property.

---

## D. Scope

- vytvoření Status property,
- sdílení property mezi tasky jednoho schématu,
- tři pevné statusové skupiny,
- správa konkrétních statusových možností,
- nastavení výchozí možnosti,
- nastavení, změna a vymazání hodnoty tasku,
- odstranění statusové možnosti,
- odstranění celé property,
- duplikace property s volitelným kopírováním hodnot,
- zobrazení hodnoty jako `Select`.

---

## E. Mimo scope

- omezení povolených přechodů mezi statusy,
- automatické změny statusů,
- notifikace,
- oprávnění jednotlivých rolí,
- filtrování, řazení a agregace,
- board a další konkrétní pohledy,
- integrace s externími systémy.

---

## F. Business pravidla

### 1. Sdílené schéma

1. Status property je součástí sdíleného schématu tasků.
2. Po vytvoření je dostupná u všech tasků používajících dané schéma.
3. Existující tasky získají novou property s hodnotou `Empty`.
4. Nové tasky automaticky získají aktuální hodnotu `Default`.
5. Změna konfigurace property se projeví u všech tasků používajících dané schéma.

### 2. Statusové skupiny

1. Status property obsahuje právě tři skupiny:
   - `To-do`
   - `In progress`
   - `Complete`
2. Skupiny nelze přejmenovat.
3. Skupiny nelze odstranit.
4. Nelze přidat další skupinu.
5. Každá statusová možnost patří právě do jedné skupiny.

### 3. Výchozí konfigurace

Při vytvoření Status property vznikne následující konfigurace:

| Skupina     | Statusová možnost |
| ----------- | ----------------- |
| To-do       | Not started       |
| In progress | In progress       |
| Complete    | Done              |

Další pravidla:

1. `Not started` je označen jako `Default`.
2. Hodnota property se zobrazuje jako `Select`.

### 4. Statusové možnosti

Každá statusová možnost má:

- název,
- barvu,
- skupinu,
- pořadí.

Statusovou možnost lze:

- vytvořit,
- přejmenovat,
- přebarvit,
- změnit její pořadí,
- přesunout do jiné skupiny,
- odstranit,
- označit jako `Default`.

V rámci jedné Status property nesmí existovat dvě možnosti se stejným názvem.

### 5. Default

1. Status property má vždy právě jednu možnost označenou jako `Default`.
2. Označením nové možnosti jako `Default` přestane být předchozí možnost výchozí.
3. Změna `Default` neovlivní hodnoty existujících tasků.
4. Změna `Default` neovlivní existující hodnoty `Empty`.
5. Nově vytvořené tasky získají aktuální hodnotu `Default`.
6. Hodnota `Default` se použije také jako náhradní hodnota při odstranění používané statusové možnosti.

### 6. Hodnota tasku

1. Task má v jedné Status property nejvýše jednu hodnotu.
2. Nastavení nové hodnoty nahradí předchozí hodnotu.
3. Uživatel může hodnotu vymazat.
4. Vymazaná hodnota má stav `Empty`.
5. Hodnota `Empty` se automaticky nemění na `Default`.
6. Výjimkou je pouze vytvoření nového tasku nebo odstranění používané statusové možnosti.

### 7. Odstranění nepoužívané statusové možnosti

1. Pokud statusovou možnost nepoužívá žádný task, lze ji odstranit.
2. Odstranění neovlivní hodnoty ostatních tasků.
3. Ostatní statusové možnosti zůstanou beze změny.

### 8. Odstranění používané statusové možnosti

1. Pokud statusovou možnost používá alespoň jeden task, systém před odstraněním zobrazí potvrzovací dialog.
2. Dialog zobrazí přesný počet dotčených tasků.
3. Zrušení dialogu neprovede žádnou změnu.
4. Po potvrzení:
   - je statusová možnost odstraněna,
   - všechny dotčené tasky získají aktuální hodnotu `Default`.
5. Tasky používající jiné statusové možnosti zůstanou beze změny.
6. Tasky s hodnotou `Empty` zůstanou `Empty`.

### 9. Odstranění aktuální Default možnosti

1. Status property musí mít vždy právě jednu hodnotu `Default`.
2. Aktuální `Default` možnost nelze odstranit bez určení nové výchozí možnosti.
3. Před odstraněním musí uživatel označit jinou existující možnost jako `Default`.
4. Pokud odstraňovanou možnost používají tasky, po potvrzení získají nově určenou hodnotu `Default`.

### 10. Odstranění celé property

1. Odstranění property z kontextu jednoho tasku znamená odstranění property ze sdíleného schématu.
2. Property se odstraní ze všech tasků používajících dané schéma.
3. Před odstraněním se zobrazí potvrzovací dialog upozorňující na globální dopad.
4. Zrušení dialogu neprovede žádnou změnu.
5. Po potvrzení přestane být property dostupná u všech tasků používajících schéma.

### 11. Duplikace property

1. Duplikací vznikne nová samostatná Status property.
2. Duplikát převezme konfiguraci původní property:
   - tři statusové skupiny,
   - statusové možnosti,
   - názvy,
   - barvy,
   - pořadí,
   - přiřazení do skupin,
   - hodnotu `Default`,
   - způsob zobrazení.
3. Při každé duplikaci se systém zeptá, zda má zkopírovat také hodnoty tasků.
4. Pokud uživatel zvolí kopírování hodnot:
   - hodnoty se zkopírují pro všechny existující tasky,
   - hodnota `Empty` zůstane `Empty`.
5. Pokud uživatel kopírování hodnot odmítne:
   - nová property bude u všech existujících tasků `Empty`.
6. Nové tasky získají hodnotu `Default` každé Status property.
7. Původní property a duplikát jsou po vytvoření nezávislé.
8. Pozdější změna původní property neovlivní duplikát.
9. Pozdější změna duplikátu neovlivní původní property.

---

## G. Klíčové výjimky a hraniční situace

1. Přidání Status property do existujícího schématu nesmí zpětně nastavit taskům hodnotu `Default`.
2. Změna `Default` nesmí přepsat existující hodnoty tasků.
3. Změna `Default` nesmí přepsat existující hodnoty `Empty`.
4. Počet tasků v dialogu pro odstranění možnosti musí odpovídat skutečnému počtu tasků používajících danou možnost v konkrétní property.
5. Odstranění statusové možnosti nesmí ovlivnit jinou Status property ve stejném schématu.
6. Odstranění možnosti nesmí ovlivnit tasky používající jiné hodnoty.
7. Duplikát nesmí po vytvoření reagovat na změny původní property.
8. Při duplikaci s hodnotami se `Empty` kopíruje jako `Empty`.
9. Aktuální `Default` nelze odstranit, dokud není určena jiná výchozí možnost.

---

## H. Akceptační kritéria

1. Status property je dostupná u všech tasků používajících stejné schéma.
2. Existující tasky mají po přidání property hodnotu `Empty`.
3. Nové tasky mají aktuální hodnotu `Default`.
4. Každý task má v jedné Status property nejvýše jednu hodnotu.
5. Existují právě tři neměnné statusové skupiny.
6. Každá statusová možnost patří právě do jedné skupiny.
7. Status property má vždy právě jednu hodnotu `Default`.
8. Změna `Default` neovlivní existující tasky.
9. Odstranění používané možnosti zobrazí počet dotčených tasků.
10. Po potvrzení odstranění získají dotčené tasky hodnotu `Default`.
11. Odstranění celé property vyžaduje potvrzení globálního dopadu.
12. Duplikace vždy vytvoří nezávislou property.
13. Při duplikaci uživatel vždy rozhoduje o kopírování hodnot.
14. Duplikace bez hodnot ponechá novou property u existujících tasků `Empty`.
15. Duplikace s hodnotami zachová odpovídající hodnoty včetně `Empty`.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Status property tasku
  Status property umožňuje evidovat právě jednu aktuální fázi tasku
  pomocí konfigurace sdílené všemi tasky stejného schématu.

  Rule: Status property je součástí sdíleného schématu

    Scenario: Přidání Status property do schématu s existujícími tasky
      Given schéma používá několik existujících tasků
      And schéma neobsahuje Status property
      When správce přidá Status property
      Then Status property je dostupná u všech tasků používajících schéma
      And hodnota Status property je u všech existujících tasků "Empty"

    Scenario: Vytvoření nového tasku
      Given schéma obsahuje Status property
      And status "Not started" je označen jako "Default"
      When uživatel vytvoří nový task
      Then nový task má status "Not started"

  Rule: Status property má tři pevné skupiny

    Scenario: Vytvoření výchozí konfigurace
      When správce vytvoří Status property
      Then property obsahuje skupinu "To-do"
      And property obsahuje skupinu "In progress"
      And property obsahuje skupinu "Complete"
      And skupina "To-do" obsahuje možnost "Not started"
      And skupina "In progress" obsahuje možnost "In progress"
      And skupina "Complete" obsahuje možnost "Done"
      And možnost "Not started" je označena jako "Default"
      And property se zobrazuje jako "Select"

    Scenario: Pokus o vytvoření další skupiny
      Given existuje Status property
      When správce požádá o přidání další statusové skupiny
      Then systém novou skupinu nevytvoří

    Scenario: Pokus o přejmenování pevné skupiny
      Given existuje skupina "Complete"
      When správce požádá o její přejmenování
      Then skupina zůstane beze změny

    Scenario: Pokus o odstranění pevné skupiny
      Given existuje skupina "Complete"
      When správce požádá o její odstranění
      Then skupina zůstane součástí Status property

  Rule: Task má nejvýše jednu hodnotu Status property

    Scenario: Nastavení statusu tasku
      Given task má status "Not started"
      When uživatel nastaví status "In progress"
      Then task má status "In progress"
      And task již nemá status "Not started"

    Scenario: Vymazání statusu tasku
      Given task má status "In progress"
      When uživatel vymaže hodnotu Status property
      Then hodnota Status property je "Empty"

  Rule: Konfigurace možností je sdílená

    Scenario: Přidání nové statusové možnosti
      Given existuje Status property
      When správce přidá možnost "Blocked" do skupiny "In progress"
      Then možnost "Blocked" je dostupná u všech tasků používajících schéma
      And možnost "Blocked" patří právě do skupiny "In progress"

    Scenario: Změna statusové možnosti
      Given existuje možnost "Blocked"
      And některé tasky používají možnost "Blocked"
      When správce změní její název, barvu nebo pořadí
      Then změněná konfigurace je dostupná u všech tasků používajících schéma
      And dotčené tasky zůstávají přiřazené ke stejné možnosti

    Scenario: Přesunutí možnosti do jiné skupiny
      Given možnost "Blocked" patří do skupiny "In progress"
      When správce přesune možnost "Blocked" do skupiny "To-do"
      Then možnost "Blocked" patří právě do skupiny "To-do"
      And tasky se statusem "Blocked" si zachovají svou hodnotu

    Scenario: Odmítnutí duplicitního názvu
      Given existuje možnost "Blocked"
      When správce vytvoří další možnost s názvem "Blocked"
      Then systém novou možnost nevytvoří

  Rule: Status property má právě jednu hodnotu Default

    Scenario: Změna Default možnosti
      Given status "Not started" je označen jako "Default"
      And existující task má status "Not started"
      And jiný existující task má hodnotu "Empty"
      When správce označí status "In progress" jako "Default"
      Then status "In progress" je označen jako "Default"
      And status "Not started" již není označen jako "Default"
      And existující task má nadále status "Not started"
      And jiný existující task má nadále hodnotu "Empty"

    Scenario: Nový task po změně Default
      Given status "In progress" je označen jako "Default"
      When uživatel vytvoří nový task
      Then nový task má status "In progress"

  Rule: Nepoužívanou statusovou možnost lze odstranit

    Scenario: Odstranění nepoužívané možnosti
      Given status "Waiting" nepoužívá žádný task
      When správce odstraní status "Waiting"
      Then status "Waiting" již není dostupný
      And žádná hodnota tasku se nezmění

  Rule: Odstranění používané možnosti nahradí hodnoty hodnotou Default

    Scenario: Zobrazení počtu dotčených tasků
      Given status "Blocked" používá 5 tasků
      When správce požádá o odstranění statusu "Blocked"
      Then potvrzovací dialog zobrazí počet 5 dotčených tasků

    Scenario: Zrušení odstranění používané možnosti
      Given status "Blocked" používá 5 tasků
      And správce požádal o jeho odstranění
      When správce odstranění zruší
      Then status "Blocked" zůstane dostupný
      And hodnoty dotčených tasků zůstanou beze změny

    Scenario: Potvrzení odstranění používané možnosti
      Given status "Blocked" používá 5 tasků
      And status "Not started" je označen jako "Default"
      When správce potvrdí odstranění statusu "Blocked"
      Then status "Blocked" již není dostupný
      And všech 5 dotčených tasků má status "Not started"

    Scenario: Odstranění možnosti neovlivní ostatní hodnoty
      Given status "Blocked" používá 5 tasků
      And jiné tasky používají status "In progress"
      And status "Not started" je označen jako "Default"
      When správce potvrdí odstranění statusu "Blocked"
      Then tasky se statusem "Blocked" mají status "Not started"
      And tasky se statusem "In progress" zůstanou beze změny

  Rule: Default možnost nelze odstranit bez určení nového Default

    Scenario: Pokus o odstranění aktuální Default možnosti
      Given status "Not started" je označen jako "Default"
      When správce požádá o odstranění statusu "Not started"
      Then systém požaduje určení jiné možnosti jako "Default"
      And status "Not started" zatím neodstraní

    Scenario: Odstranění původní Default možnosti po určení nové
      Given status "Not started" je původní "Default"
      And status "In progress" byl označen jako nový "Default"
      And status "Not started" používají existující tasky
      When správce potvrdí odstranění statusu "Not started"
      Then status "Not started" již není dostupný
      And dotčené tasky mají status "In progress"

  Rule: Odstranění property má globální dopad

    Scenario: Zobrazení globálního dopadu odstranění property
      Given Status property používají tasky sdíleného schématu
      When správce požádá o odstranění property
      Then dialog upozorní na odstranění property ze všech tasků schématu

    Scenario: Zrušení odstranění property
      Given správce požádal o odstranění Status property
      When správce odstranění zruší
      Then property zůstane součástí schématu
      And žádná hodnota tasku se nezmění

    Scenario: Potvrzení odstranění property
      Given Status property používají tasky sdíleného schématu
      When správce potvrdí globální odstranění property
      Then property je odstraněna ze schématu
      And property již není dostupná u žádného tasku používajícího schéma

  Rule: Duplikací vzniká nezávislá property

    Scenario: Výzva ke kopírování hodnot
      Given schéma obsahuje Status property
      When správce požádá o její duplikaci
      Then systém požádá o rozhodnutí, zda zkopírovat také hodnoty tasků

    Scenario: Duplikace včetně hodnot
      Given schéma obsahuje nakonfigurovanou Status property
      When správce property duplikuje
      And zvolí kopírování hodnot
      Then vznikne nová samostatná Status property
      And nová property má stejnou konfiguraci jako původní
      And každý existující task má zkopírovanou původní hodnotu
      And původní hodnota "Empty" je zkopírována jako "Empty"

    Scenario: Duplikace bez hodnot
      Given schéma obsahuje nakonfigurovanou Status property
      When správce property duplikuje
      And odmítne kopírování hodnot
      Then vznikne nová samostatná Status property
      And nová property má stejnou konfiguraci jako původní
      And hodnota nové property je u všech existujících tasků "Empty"

    Scenario: Nezávislost duplikátu při změně původní property
      Given Status property byla duplikována
      When správce změní konfiguraci původní property
      Then konfigurace duplikátu se nezmění

    Scenario: Nezávislost původní property při změně duplikátu
      Given Status property byla duplikována
      When správce změní konfiguraci duplikátu
      Then konfigurace původní property se nezmění

    Scenario: Nový task po duplikaci
      Given schéma obsahuje dvě nezávislé Status properties
      And každá property má vlastní hodnotu "Default"
      When uživatel vytvoří nový task
      Then task získá hodnotu "Default" první property
      And task získá hodnotu "Default" druhé property
```

---

## J. Explicitní hypotézy

Žádné otevřené hypotézy. Specifikace je připravena k implementaci a testování.
