# Readiness score: **GOLD**

- Kardinalita je konfigurovatelná: `1 Person` nebo `No limit`.
- Je určeno, které identity lze vybírat: aktivní členové a hosté workspace.
- Jsou popsány změny limitu, filtrování, duplikace i odstranění property.
- Specifikace je testovatelná a připravená pro handoff coding agents.

## A. Executive summary

Property `Person` umožňuje ukládat k tasku jednu nebo více osob z workspace. Správce property nastaví limit:

- `1 Person` – task může mít nejvýše jednu osobu,
- `No limit` – task může mít libovolný počet osob.

Vybírat lze aktivní členy a hosty workspace. Skupiny ani externí kontakty nejsou podporovány.

Property je součástí sdíleného schématu tasků. Její konfigurace platí pro všechny tasky používající dané schéma.

---

## B. Business cíl

Umožnit evidovat osoby, které mají k tasku konkrétní business vztah, například:

- Assignee,
- Owner,
- Reviewer,
- Participants,
- Approved by.

Typ `Person` neurčuje význam vztahu. Význam určuje název konkrétní property.

---

## C. Aktéři

### Editor tasku

Uživatel oprávněný měnit hodnoty properties na tasku.

### Správce schématu

Uživatel oprávněný:

- vytvořit property,
- změnit její název a limit,
- duplikovat property,
- odstranit property ze sdíleného schématu.

### Způsobilá osoba

Aktivní člen nebo host aktuálního workspace, kterého lze uložit jako hodnotu Person property.

---

## D. Scope

- vytvoření property typu `Person`,
- pojmenování a přejmenování property,
- limit `1 Person`,
- limit `No limit`,
- změna limitu,
- vyhledání členů a hostů workspace,
- přiřazení jedné nebo více osob,
- nahrazení osoby při limitu `1 Person`,
- odebrání jedné osoby,
- vymazání celé hodnoty,
- ochrana proti duplicitám,
- filtrování podle osoby,
- filtrování prázdných a neprázdných hodnot,
- duplikace property s volbou kopírování hodnot,
- odstranění property ze sdíleného schématu,
- zachování historického přiřazení deaktivovaného uživatele.

---

## E. Mimo scope

- skupiny uživatelů,
- externí kontakty bez účtu ve workspace,
- automatické přiřazování osob,
- notifikace při změně hodnoty,
- změna přístupových oprávnění podle přiřazené osoby,
- automatické sdílení tasku,
- kapacitní plánování a workload,
- pracovní role uživatelů,
- integrace s externím adresářem,
- automatizace reagující na změnu property,
- změna typu existující property.

---

## F. Business pravidla

### F1. Sdílené schéma

1. Person property je součástí sdíleného schématu tasků.
2. Po vytvoření je property dostupná u všech tasků používajících dané schéma.
3. Existující tasky získají novou property s hodnotou `Empty`.
4. Nově vytvořené tasky mají property rovněž ve stavu `Empty`.
5. Přejmenování property platí pro všechny tasky ve schématu.
6. Přejmenování nemění uložené hodnoty.

### F2. Hodnota property

1. Hodnota obsahuje reference na uživatelské identity, nikoliv volný text.
2. Property může být prázdná.
3. Vybranou osobu lze odebrat.
4. Všechny osoby lze odebrat a vrátit property do stavu `Empty`.
5. Stejná osoba nesmí být v jedné property uvedena vícekrát.
6. Pořadí vybraných osob nemá business význam.

### F3. Způsobilé identity

1. Vybrat lze aktivního člena workspace.
2. Vybrat lze aktivního hosta workspace.
3. Uživatelské skupiny nelze vybrat.
4. Externí osobu bez účtu ve workspace nelze vybrat.
5. Deaktivovaného uživatele nelze nově přiřadit.
6. Historické přiřazení později deaktivovaného uživatele zůstane zachováno.
7. Deaktivovaný uživatel musí být v uložené hodnotě rozpoznatelný jako neaktivní.

### F4. Limit property

Property podporuje dvě konfigurace:

#### `1 Person`

- Task může obsahovat nula nebo jednu osobu.
- Výběr nové osoby při již vyplněné hodnotě nahradí původní osobu.
- Do hodnoty nelze uložit více než jednu osobu.

#### `No limit`

- Task může obsahovat nula až více osob.
- Nově vybraná osoba se přidá k existujícím osobám.
- Stejná osoba se znovu nepřidá.

### F5. Výchozí limit

Nově vytvořená Person property má výchozí limit `No limit`.

### F6. Změna limitu

#### Z `1 Person` na `No limit`

- Změna je vždy povolena.
- Existující hodnoty zůstávají zachovány.

#### Z `No limit` na `1 Person`

- Změna je povolena pouze tehdy, když žádný task neobsahuje více než jednu osobu.
- Pokud alespoň jeden task obsahuje více osob, systém změnu neprovede.
- Systém zobrazí počet tasků, které limit porušují.
- Systém nesmí osoby automaticky odstranit ani vybrat jednu z nich.

### F7. Filtrování

Person property podporuje minimálně tyto podmínky:

- `Contains [Person]`,
- `Does not contain [Person]`,
- `Is empty`,
- `Is not empty`.

U vícehodnotové property:

- `Contains` odpovídá tasku, pokud je osoba mezi vybranými hodnotami.
- `Does not contain` odpovídá tasku, pokud osoba mezi vybranými hodnotami není.
- `Is empty` odpovídá pouze hodnotě bez osob.
- `Is not empty` odpovídá hodnotě s alespoň jednou osobou.

### F8. Duplikace property

1. Duplikací vznikne nová samostatná property.
2. Nová property převezme:
   - název odvozený od původní property,
   - typ `Person`,
   - nastavený limit.
3. Systém se při každé duplikaci zeptá, zda se mají zkopírovat také hodnoty.
4. Při kopírování hodnot se hodnoty zkopírují pro všechny existující tasky.
5. Bez kopírování hodnot bude nová property na všech taskech `Empty`.
6. Pozdější změny konfigurace nebo hodnot jedné property neovlivňují druhou property.

### F9. Odstranění property

1. Odstranění property vždy zobrazí potvrzovací dialog.
2. Dialog zobrazí počet tasků, ve kterých je property `Is not empty`.
3. Zrušení dialogu nezmění schéma ani hodnoty.
4. Potvrzení odstraní property ze sdíleného schématu.
5. Property a její hodnoty následně zmizí ze všech tasků používajících schéma.

### F10. Notifikace

Změna hodnoty Person property sama o sobě nevytváří notifikaci. Případné notifikační chování je samostatná funkcionalita mimo scope této property.

---

## G. Klíčové výjimky a hraniční situace

1. **Opakovaný výběr stejné osoby**

   Osoba zůstane v hodnotě pouze jednou.

2. **Výběr druhé osoby při limitu `1 Person`**

   Nová osoba nahradí původní hodnotu.

3. **Změna limitu na `1 Person` při existujících vícehodnotových datech**

   Změna se zablokuje bez ztráty dat.

4. **Deaktivace přiřazeného uživatele**

   Historická hodnota zůstane zachována, ale uživatele nelze nově vybrat.

5. **Prázdné výsledky vyhledávání**

   Uživatel nemůže vytvořit novou osobu zadáním volného textu.

6. **Duplikace s historicky deaktivovaným uživatelem**

   Při zvoleném kopírování hodnot se historická reference zkopíruje stejně jako ostatní hodnoty.

7. **Odstranění property bez vyplněných hodnot**

   Potvrzovací dialog se zobrazí také a uvede počet `Is not empty` jako `0`.

---

## H. Akceptační kritéria

1. Správce může vytvořit property typu `Person`.
2. Nová property je dostupná na všech taskech daného schématu.
3. Výchozí hodnota na existujících taskech je `Empty`.
4. Výchozí limit nové property je `No limit`.
5. Limit lze změnit na `1 Person` nebo `No limit`.
6. Editor může vybírat aktivní členy a hosty workspace.
7. Editor nemůže vybírat skupiny, externí kontakty ani deaktivované uživatele.
8. Při limitu `1 Person` lze uložit nejvýše jednu osobu.
9. Výběr nové osoby při limitu `1 Person` nahradí původní osobu.
10. Při limitu `No limit` lze přidat více různých osob.
11. Stejnou osobu nelze přidat dvakrát.
12. Změna z `No limit` na `1 Person` je zablokována, pokud některý task obsahuje více osob.
13. Zablokovaná změna zobrazí počet nevyhovujících tasků.
14. Filtrování podporuje konkrétní osobu, prázdnou a neprázdnou hodnotu.
15. Duplikace kopíruje konfiguraci a nabízí samostatnou volbu kopírování hodnot.
16. Odstranění vždy vyžaduje potvrzení a zobrazuje počet `Is not empty`.
17. Změna hodnoty sama o sobě neposílá notifikaci.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Person property
  Person property umožňuje evidovat jednu nebo více osob,
  které mají k tasku definovaný business vztah.

  Rule: Person property je součástí sdíleného schématu

    Scenario: Vytvoření Person property
      Given schéma používá několik existujících tasků
      When správce vytvoří property "Assignee" typu "Person"
      Then property "Assignee" je dostupná na všech taskech používajících schéma
      And hodnota property je na všech existujících taskech Empty
      And limit property je nastaven na "No limit"

    Scenario: Přejmenování Person property
      Given schéma obsahuje Person property "Assignee"
      And tasky obsahují uložené hodnoty této property
      When správce přejmenuje property na "Owner"
      Then property se na všech taskech jmenuje "Owner"
      And uložené osoby zůstanou zachovány

  Rule: Vybírat lze aktivní členy a hosty workspace

    Scenario Outline: Přiřazení způsobilé osoby
      Given Person property "Participants" je Empty
      And "<osoba>" je aktivní <typ_identity> workspace
      When editor vybere osobu "<osoba>"
      Then property "Participants" obsahuje osobu "<osoba>"

      Examples:
        | osoba          | typ_identity |
        | Anna Nováková  | člen         |
        | Jan Dvořák     | host         |

    Scenario: Externí kontakt nelze přiřadit
      Given osoba "Eva Malá" nemá účet v aktuálním workspace
      When editor hledá osobu "Eva Malá" v Person property
      Then systém neumožní osobu "Eva Malá" přiřadit
      And systém nevytvoří novou osobu z volného textu

    Scenario: Skupinu nelze přiřadit
      Given workspace obsahuje skupinu "Finance"
      When editor hledá skupinu "Finance" v Person property
      Then systém neumožní skupinu "Finance" přiřadit

  Rule: Limit 1 Person povoluje nejvýše jednu osobu

    Scenario: Přiřazení osoby do prázdné property
      Given Person property "Assignee" má limit "1 Person"
      And její hodnota je Empty
      When editor vybere osobu "Anna Nováková"
      Then property obsahuje pouze osobu "Anna Nováková"

    Scenario: Nahrazení osoby při limitu 1 Person
      Given Person property "Assignee" má limit "1 Person"
      And obsahuje osobu "Anna Nováková"
      When editor vybere osobu "Jan Dvořák"
      Then property obsahuje pouze osobu "Jan Dvořák"
      And property již neobsahuje osobu "Anna Nováková"

  Rule: Limit No limit povoluje více osob

    Scenario: Přidání více osob
      Given Person property "Reviewers" má limit "No limit"
      And obsahuje osobu "Anna Nováková"
      When editor přidá osobu "Jan Dvořák"
      Then property obsahuje osobu "Anna Nováková"
      And property obsahuje osobu "Jan Dvořák"

    Scenario: Opakované přidání stejné osoby
      Given Person property "Reviewers" obsahuje osobu "Anna Nováková"
      When editor se pokusí znovu přidat osobu "Anna Nováková"
      Then property obsahuje osobu "Anna Nováková" pouze jednou

    Scenario: Odebrání jedné osoby
      Given Person property "Reviewers" obsahuje osoby:
        | Anna Nováková |
        | Jan Dvořák    |
      When editor odebere osobu "Anna Nováková"
      Then property neobsahuje osobu "Anna Nováková"
      And property stále obsahuje osobu "Jan Dvořák"

    Scenario: Vymazání všech osob
      Given Person property obsahuje alespoň jednu osobu
      When editor odebere všechny osoby
      Then hodnota property je Empty

  Rule: Změna limitu nesmí způsobit ztrátu hodnot

    Scenario: Změna limitu z 1 Person na No limit
      Given Person property má limit "1 Person"
      And některé tasky obsahují jednu osobu
      When správce změní limit na "No limit"
      Then změna limitu je provedena
      And všechny existující hodnoty zůstanou zachovány

    Scenario: Změna limitu na 1 Person bez konfliktních hodnot
      Given Person property má limit "No limit"
      And žádný task neobsahuje více než jednu osobu
      When správce změní limit na "1 Person"
      Then změna limitu je provedena
      And všechny existující hodnoty zůstanou zachovány

    Scenario: Změna limitu na 1 Person s konfliktními hodnotami
      Given Person property má limit "No limit"
      And 4 tasky obsahují více než jednu osobu
      When správce změní limit na "1 Person"
      Then změna limitu není provedena
      And systém oznámí, že 4 tasky porušují nový limit
      And žádná uložená osoba není odstraněna

  Rule: Historické přiřazení deaktivované osoby se zachová

    Scenario: Deaktivace již přiřazeného uživatele
      Given Person property obsahuje osobu "Anna Nováková"
      When je osoba "Anna Nováková" ve workspace deaktivována
      Then property nadále obsahuje historické přiřazení osoby "Anna Nováková"
      And osoba je označena jako neaktivní

    Scenario: Deaktivovaného uživatele nelze nově přiřadit
      Given osoba "Anna Nováková" je deaktivovaná
      When editor hledá osobu "Anna Nováková" pro nové přiřazení
      Then systém neumožní osobu "Anna Nováková" přidat

  Rule: Tasky lze filtrovat podle Person property

    Scenario: Filtrování podle konkrétní osoby
      Given tasky obsahují různé hodnoty property "Assignee"
      When uživatel nastaví filtr "Assignee Contains Anna Nováková"
      Then systém zobrazí pouze tasky obsahující osobu "Anna Nováková"

    Scenario: Vyloučení tasků obsahujících konkrétní osobu
      Given tasky obsahují různé hodnoty property "Assignee"
      When uživatel nastaví filtr "Assignee Does not contain Anna Nováková"
      Then systém zobrazí pouze tasky, které osobu "Anna Nováková" neobsahují

    Scenario: Filtrování prázdných hodnot
      Given některé tasky mají property "Assignee" Empty
      And jiné tasky mají property "Assignee" vyplněnou
      When uživatel nastaví filtr "Assignee Is empty"
      Then systém zobrazí pouze tasky s hodnotou Empty

    Scenario: Filtrování neprázdných hodnot
      Given některé tasky mají property "Assignee" Empty
      And jiné tasky mají property "Assignee" vyplněnou
      When uživatel nastaví filtr "Assignee Is not empty"
      Then systém zobrazí pouze tasky s alespoň jednou osobou

  Rule: Person property lze duplikovat

    Scenario: Duplikace s kopírováním hodnot
      Given Person property "Reviewers" má limit "No limit"
      And obsahuje hodnoty na existujících taskech
      When správce duplikuje property
      And zvolí kopírování hodnot
      Then vznikne nová samostatná Person property
      And nová property má limit "No limit"
      And hodnoty jsou zkopírovány pro všechny existující tasky

    Scenario: Duplikace bez kopírování hodnot
      Given Person property "Assignee" má limit "1 Person"
      And obsahuje hodnoty na existujících taskech
      When správce duplikuje property
      And odmítne kopírování hodnot
      Then vznikne nová samostatná Person property
      And nová property má limit "1 Person"
      And její hodnota je na všech existujících taskech Empty

    Scenario: Změna duplikované property
      Given Person property byla duplikována
      When správce změní limit duplikované property
      Then limit původní property se nezmění

  Rule: Odstranění property vyžaduje potvrzení

    Scenario: Zahájení odstranění používané property
      Given Person property je vyplněná na 12 taskech
      When správce zvolí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog zobrazí "Is not empty: 12"

    Scenario: Zrušení odstranění property
      Given je zobrazen potvrzovací dialog odstranění
      When správce odstranění zruší
      Then property zůstane součástí schématu
      And všechny hodnoty zůstanou zachovány

    Scenario: Potvrzení odstranění property
      Given je zobrazen potvrzovací dialog odstranění
      When správce odstranění potvrdí
      Then property je odstraněna ze sdíleného schématu
      And property již není dostupná na žádném tasku tohoto schématu

  Rule: Změna hodnoty sama neposílá notifikaci

    Scenario: Přiřazení osoby bez notifikace
      Given task obsahuje Person property "Assignee"
      When editor přiřadí osobu "Anna Nováková"
      Then hodnota property je aktualizována
      And samotná změna Person property nevytvoří notifikaci
```

---

## J. Explicitní hypotézy

Následující rozhodnutí nebyla výslovně uvedena v odpovědi, ale jsou použita jako výchozí business pravidla:

1. Výchozí nastavení nové property je `No limit`, podle dodaného návrhu.
2. Při limitu `1 Person` výběr nové osoby automaticky nahradí původní osobu.
3. Přechod z `No limit` na `1 Person` se při konfliktních hodnotách zablokuje; systém nesmí hodnoty automaticky mazat.
4. Historicky přiřazený deaktivovaný uživatel zůstane uložený a bude označen jako neaktivní.
5. Samotná změna Person property neposílá notifikace.
