Potvrzené volby uzavírají význam editace, historické hodnoty i lokalizaci času. Specifikace je připravena pro handoff.

# Last edited time — finální business specifikace

## Readiness score: GOLD

- Je jednoznačně určeno, které změny aktualizují hodnotu.
- Je definováno chování pro nové i existující tasky.
- Hodnota je systémová, automatická a uživatelsky needitovatelná.
- Je určeno zobrazení podle lokálního času a formátu každého uživatele.
- Hlavní toky a důležité výjimky jsou pokryty testovatelnými scénáři.

---

## A. Executive summary

Property `Last edited time` zobrazuje datum a čas poslední úspěšně uložené změny vlastního stavu tasku.

Hodnotu automaticky spravuje systém. Uživatel ji nemůže ručně nastavit, změnit ani vymazat.

Stejný okamžik se jednotlivým uživatelům zobrazuje:

- v jejich lokální časové zóně,
- v jejich lokálním formátu data a času.

Pouhé otevření tasku, komentáře, reakce nebo změny zobrazení seznamu tasků se za editaci tasku nepovažují.

---

## B. Business cíl

Umožnit uživateli rychle zjistit, kdy byl task naposledy věcně změněn, aby mohl posoudit aktuálnost jeho obsahu a stavu.

Property lze zároveň používat jako časový údaj pro podporované operace, například řazení a filtrování tasků.

---

## C. Aktéři

### Uživatel

- prohlíží hodnotu poslední editace,
- může property přidat, přejmenovat nebo odstranit,
- nemůže ručně měnit její hodnotu.

### Měnící aktér

Aktér, jehož úspěšná změna může aktualizovat čas poslední editace:

- uživatel,
- automatizace,
- jiná systémová akce, která mění vlastní stav tasku.

### Systém

- eviduje okamžik poslední editace,
- automaticky aktualizuje hodnotu,
- lokalizuje její zobrazení pro konkrétního uživatele.

---

## D. Scope

Součástí specifikace je:

- přidání property typu `Last edited time`,
- automatické vytvoření hodnoty u nového tasku,
- zobrazení historické hodnoty u existujícího tasku,
- aktualizace po úspěšné změně tasku,
- rozlišení změn, které se počítají a nepočítají jako editace,
- zákaz ruční editace hodnoty,
- lokalizované zobrazení data a času,
- přejmenování a odstranění property,
- opětovné přidání property,
- více properties stejného typu,
- použití hodnoty pro podporované operace s datem a časem.

---

## E. Mimo scope

- `Last edited by`,
- historie jednotlivých změn,
- audit log,
- verzování tasku,
- porovnávání nebo obnovování verzí,
- komentáře a reakce jako součást času poslední editace,
- notifikace při změně,
- technický způsob ukládání času,
- konfigurace vlastního formátu přímo na property,
- čas vytvoření jako samostatná property `Created time`.

---

## F. Business pravidla

### BR-01 — systémová hodnota

`Last edited time` je systémově spravovaná property.

Uživatel nemůže její hodnotu:

- ručně zadat,
- upravit,
- vymazat,
- nahradit jiným datem nebo časem.

### BR-02 — počáteční hodnota nového tasku

Při úspěšném vytvoření nového tasku se jeho čas poslední editace nastaví na okamžik vytvoření.

Dokud nedojde k další editaci, je čas poslední editace shodný s časem vytvoření.

### BR-03 — změny aktualizující hodnotu

Hodnota se aktualizuje po každé úspěšně uložené změně vlastního stavu tasku.

Patří sem zejména:

- změna `Title`,
- změna obsahu kanvasu,
- změna hodnoty kterékoliv editovatelné property,
- nastavení nebo vymazání hodnoty property,
- archivace tasku,
- obnovení archivovaného tasku,
- změna provedená uživatelem,
- změna provedená automatizací nebo systémovou akcí.

### BR-04 — změny neaktualizující hodnotu

Hodnota se neaktualizuje při události, která nemění vlastní stav tasku.

Patří sem zejména:

- otevření tasku,
- přečtení tasku,
- zavření tasku bez změny,
- přidání, změna nebo odstranění komentáře,
- přidání nebo odstranění reakce,
- změna řazení seznamu tasků,
- změna filtru,
- změna seskupení,
- změna zobrazení nebo jeho konfigurace,
- neúspěšný pokus o změnu,
- změna, která nebyla uložena,
- zrušení rozpracované změny.

### BR-05 — okamžik aktualizace

Hodnota se změní až po úspěšném uložení změny.

Pokud změna selže nebo není uložena, předchozí hodnota zůstává zachována.

### BR-06 — existující tasky

Po přidání property k existujícím taskům se zobrazí jejich skutečný evidovaný čas poslední editace.

Čas se nenastavuje na okamžik přidání property.

Pokud existující task nebyl od svého vytvoření změněn, zobrazí se čas jeho vytvoření.

### BR-07 — nezávislost evidence na property

Systém eviduje čas poslední editace nezávisle na tom, zda je property aktuálně zobrazena.

Odstranění property:

- nemaže evidovaný čas poslední editace,
- neresetuje jej,
- nemění jej na čas odstranění property.

Po opětovném přidání se zobrazí aktuálně evidovaná hodnota.

### BR-08 — přejmenování property

Property může být přejmenována.

Přejmenování:

- nemění její typ,
- nemění její hodnotu,
- nepovažuje se za editaci vlastního stavu jednotlivých tasků.

### BR-09 — více properties stejného typu

Pokud schéma umožňuje více properties typu `Last edited time`, všechny u stejného tasku zobrazují stejný evidovaný okamžik.

Jednotlivé properties mohou mít rozdílné názvy, ale nesmějí mít rozdílné hodnoty.

### BR-10 — lokální časová zóna

Hodnota se každému uživateli zobrazuje v jeho lokální časové zóně.

Dva uživatelé v různých časových zónách mohou vidět rozdílný místní čas, ale obě hodnoty reprezentují stejný okamžik editace.

### BR-11 — lokální formát

Datum a čas se zobrazují podle lokálního formátu uživatele.

Lokalizace může ovlivnit například:

- pořadí dne, měsíce a roku,
- oddělovače data,
- 12hodinový nebo 24hodinový formát,
- lokalizované označení data a času.

Property nemá vlastní uživatelsky nastavitelný formát nezávislý na uživatelském locale.

### BR-12 — změna locale nebo časové zóny

Změna locale nebo časové zóny uživatele změní pouze prezentaci hodnoty.

Nemění evidovaný okamžik poslední editace a sama o sobě neaktualizuje `Last edited time`.

### BR-13 — letní a zimní čas

Při zobrazení se použijí pravidla časové zóny platná pro evidovaný okamžik, včetně případného letního času.

Změna mezi letním a zimním časem nemění evidovaný okamžik editace.

### BR-14 — řazení a filtrování

Pokud task systém podporuje řazení nebo filtrování podle data a času, lze `Last edited time` použít stejně jako jiné systémové časové hodnoty.

Porovnává se skutečný okamžik editace, nikoli lokalizovaný text zobrazený uživateli.

---

## G. Klíčové výjimky a hraniční situace

### Neúspěšná změna

Pokud se změnu nepodaří uložit, hodnota zůstává beze změny.

### Otevření bez editace

Pouhé otevření nebo přečtení tasku nesmí způsobit aktualizaci.

### Změna vrácená před uložením

Pokud uživatel provede změnu a před uložením ji vrátí, hodnota se neaktualizuje.

### Uložení stejné hodnoty

Pokud operace nevytvoří skutečnou změnu stavu tasku, `Last edited time` se neaktualizuje.

Příklad: nastavení Title na stejnou hodnotu, kterou již task obsahuje.

### Více změn

Každá samostatně úspěšně uložená změna může nastavit nový čas poslední editace.

Výsledná hodnota vždy odpovídá nejpozdější úspěšné změně.

### Změny ve stejném okamžiku

Pokud systém rozlišuje dvě změny se stejným zobrazovaným časem pouze s vyšší přesností, za poslední editaci se považuje pozdější z těchto změn.

Uživatelské zobrazení nemusí tuto vyšší přesnost zobrazovat.

### Různí uživatelé

Různí uživatelé mohou stejnou hodnotu vidět v jiném formátu nebo místním čase. Nejde o rozdílné editace.

### Přidání property do existujícího schématu

Přidání property samo o sobě nepřepisuje časy poslední editace existujících tasků.

Každý task zobrazí svůj vlastní skutečný historický čas.

---

## H. Akceptační kritéria

1. Nový task má po vytvoření vyplněný `Last edited time`.
2. Po úspěšné změně vlastního stavu tasku hodnota odpovídá času této změny.
3. Změna Title aktualizuje hodnotu.
4. Změna obsahu kanvasu aktualizuje hodnotu.
5. Změna hodnoty jiné property aktualizuje hodnotu.
6. Archivace nebo obnovení tasku aktualizuje hodnotu.
7. Změna provedená automatizací aktualizuje hodnotu.
8. Pouhé otevření nebo přečtení tasku hodnotu nemění.
9. Komentáře a reakce hodnotu nemění.
10. Změny filtrů, řazení a zobrazení hodnotu nemění.
11. Neúspěšná nebo neuložená změna hodnotu nemění.
12. Uživatel nemůže hodnotu ručně upravit ani vymazat.
13. Existující task po přidání property zobrazí svůj skutečný historický čas poslední editace.
14. Odstranění a opětovné přidání property hodnotu neresetuje.
15. Všechny properties typu `Last edited time` u jednoho tasku zobrazují stejný okamžik.
16. Hodnota se zobrazuje v lokální časové zóně aktuálního uživatele.
17. Hodnota se zobrazuje v lokálním formátu aktuálního uživatele.
18. Změna locale nebo časové zóny mění pouze zobrazení, nikoli evidovaný okamžik.
19. Řazení a filtrování pracuje se skutečným okamžikem, nikoli s lokalizovaným textem.
20. Uložení stejné hodnoty bez skutečné změny stavu tasku neaktualizuje čas.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Last edited time property

  As a task system user
  I want to see when a task was last meaningfully edited
  So that I can assess whether its content and state are current

  Rule: A new task receives an initial last edited time

    Scenario: Creating a task initializes Last edited time
      Given a new task is successfully created at instant "T1"
      When the task becomes available to users
      Then its Last edited time represents instant "T1"

  Rule: Successful changes to task state update Last edited time

    Scenario: Changing the task title updates Last edited time
      Given the task's Last edited time represents instant "T1"
      When an actor successfully changes the task Title at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: Changing the canvas content updates Last edited time
      Given the task's Last edited time represents instant "T1"
      When an actor successfully changes the canvas content at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: Changing a property value updates Last edited time
      Given the task's Last edited time represents instant "T1"
      When an actor successfully changes an editable property value at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: Clearing a property value updates Last edited time
      Given a task property contains a value
      And the task's Last edited time represents instant "T1"
      When an actor successfully clears the property value at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: Archiving a task updates Last edited time
      Given the task is active
      And its Last edited time represents instant "T1"
      When an actor successfully archives the task at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: Restoring a task updates Last edited time
      Given the task is archived
      And its Last edited time represents instant "T1"
      When an actor successfully restores the task at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: A change performed by automation updates Last edited time
      Given the task's Last edited time represents instant "T1"
      When an automation successfully changes the task state at instant "T2"
      Then the task's Last edited time represents instant "T2"

    Scenario: The latest successful edit replaces the previous value
      Given the task was successfully edited at instant "T1"
      And it was later successfully edited at instant "T2"
      When the task is displayed
      Then its Last edited time represents instant "T2"

  Rule: Events that do not change task state do not update Last edited time

    Scenario: Opening a task does not update Last edited time
      Given the task's Last edited time represents instant "T1"
      When a user opens and reads the task without changing it
      Then the task's Last edited time still represents instant "T1"

    Scenario: Adding a comment does not update Last edited time
      Given the task's Last edited time represents instant "T1"
      When a user successfully adds a comment at instant "T2"
      Then the task's Last edited time still represents instant "T1"

    Scenario: Adding a reaction does not update Last edited time
      Given the task's Last edited time represents instant "T1"
      When a user adds a reaction at instant "T2"
      Then the task's Last edited time still represents instant "T1"

    Scenario: Changing a task list view does not update Last edited time
      Given the task's Last edited time represents instant "T1"
      When a user changes sorting, filtering, grouping, or view configuration
      Then the task's Last edited time still represents instant "T1"

    Scenario: Saving the same value does not update Last edited time
      Given the task Title is "Prepare proposal"
      And the task's Last edited time represents instant "T1"
      When an actor attempts to set the Title to "Prepare proposal"
      And no actual task state changes
      Then the task's Last edited time still represents instant "T1"

  Rule: Only successfully persisted changes update Last edited time

    Scenario: A failed edit does not update Last edited time
      Given the task's Last edited time represents instant "T1"
      When an attempted task change at instant "T2" is not successfully persisted
      Then the task's Last edited time still represents instant "T1"

    Scenario: A cancelled edit does not update Last edited time
      Given the task's Last edited time represents instant "T1"
      When a user changes a value but cancels the change before it is saved
      Then the task's Last edited time still represents instant "T1"

  Rule: The value is controlled exclusively by the system

    Scenario: User cannot enter a custom value
      Given a task has a Last edited time property
      When the user accesses the property
      Then the user cannot enter a custom date or time

    Scenario: User cannot clear the value
      Given a task has a Last edited time property
      When the user accesses the property
      Then the user cannot clear its value

  Rule: Existing tasks retain their historical last edit time

    Scenario: Adding the property to an edited existing task
      Given an existing task was last edited at instant "T1"
      And the task does not currently display a Last edited time property
      When the property is added
      Then it displays instant "T1"
      And it does not represent the instant when the property was added

    Scenario: Adding the property to a task that was never edited
      Given an existing task was created at instant "T1"
      And the task has not changed since its creation
      When a Last edited time property is added
      Then it represents instant "T1"

  Rule: Removing the property does not remove the historical value

    Scenario: Re-adding a removed property restores the current value
      Given a task was last edited at instant "T1"
      And its Last edited time property was removed
      When a Last edited time property is added again without another task edit
      Then it represents instant "T1"

    Scenario: A task is edited while the property is not displayed
      Given the task does not currently display a Last edited time property
      And the task is successfully edited at instant "T2"
      When a Last edited time property is later added
      Then it represents instant "T2"

  Rule: All Last edited time properties represent the same task value

    Scenario: Multiple properties of the same type are present
      Given a task contains multiple properties of type Last edited time
      When the task is displayed
      Then every Last edited time property represents the same instant

    Scenario: Renaming the property does not change its value
      Given a Last edited time property represents instant "T1"
      When the property is renamed
      Then it still represents instant "T1"

  Rule: The value is localized for the viewing user

    Scenario: Value is displayed in the user's local time zone
      Given a task was last edited at instant "2026-07-14T12:00:00Z"
      And the viewing user's time zone is "Europe/Prague"
      When the user views Last edited time
      Then the displayed value represents "2026-07-14T14:00:00+02:00"

    Scenario: Different time zones display the same instant differently
      Given a task was last edited at instant "T1"
      And user A and user B have different local time zones
      When both users view Last edited time
      Then each user sees the value converted to their own local time zone
      And both displayed values represent instant "T1"

    Scenario: Value uses the user's local date and time format
      Given a task has a Last edited time
      And the viewing user has a configured locale
      When the value is displayed
      Then its date and time formatting follows that locale

    Scenario: Changing the user's time zone changes only the presentation
      Given a task's Last edited time represents instant "T1"
      And the user changes their local time zone
      When the user views the task again
      Then the displayed local date or time may change
      But the value still represents instant "T1"
      And the task's Last edited time is not updated

    Scenario: Changing the user's locale changes only the presentation
      Given a task's Last edited time represents instant "T1"
      And the user changes their locale
      When the user views the task again
      Then the displayed date and time format follows the new locale
      But the value still represents instant "T1"
      And the task's Last edited time is not updated

  Rule: Date operations use the actual edit instant

    Scenario: Tasks are sorted by actual last edit time
      Given task A was last edited at instant "T1"
      And task B was last edited at a later instant "T2"
      When tasks are sorted by Last edited time from newest to oldest
      Then task B appears before task A
      Regardless of the localized text displayed to the user

    Scenario: Tasks are filtered by actual last edit time
      Given a filter includes tasks edited after instant "T1"
      And a task was last edited at instant "T2"
      And instant "T2" is later than instant "T1"
      When the filter is applied
      Then the task is included
      Regardless of the user's local display format
```

---

## J. Explicitní hypotézy

Žádné otevřené hypotézy, které by bránily implementaci nebo testování.

Následující rozhodnutí jsou potvrzená:

1. Za editaci se považuje každá úspěšně uložená změna vlastního stavu tasku.
2. Komentáře, reakce, pouhé čtení a změny view se za editaci nepovažují.
3. Existující tasky zobrazují skutečný historický čas poslední editace.
4. Task bez následné editace používá jako hodnotu čas vytvoření.
5. Hodnota se zobrazuje v lokální časové zóně uživatele.
6. Hodnota se formátuje podle locale uživatele.
7. Lokalizace mění pouze prezentaci, nikoli samotný okamžik poslední editace.

Původní brief určoval pouze název property a inspiraci Notionem. Klíčovým zpřesněním bylo vymezit význam „editace“, chování historických tasků a rozdíl mezi uloženým okamžikem a jeho lokalizovaným zobrazením.
