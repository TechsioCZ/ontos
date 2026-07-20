**Readiness: GOLD.** Volby **1A** a **2A** uzavírají poslední zásadní nejasnosti: každá task kolekce má vlastní číselnou řadu a existující tasky se očíslují od nejstaršího podle `Created time`.

# Property ID — finální business specifikace

## A. Executive summary

Property `ID` poskytuje každému tasku v rámci jedné task kolekce automaticky generovaný, unikátní a neměnný identifikátor.

Identifikátor se skládá z:

- automaticky přidělené číselné části,
- volitelného prefixu společného pro celou property,
- zobrazované hodnoty ve formátu `PREFIX-123` nebo pouze `123`.

Z Notion přebíráme automatické očíslování existujících i nových položek, číslování od `1`, neměnnost čísla, zákaz ruční editace a pravidlo, že čísla smazaných položek se znovu nepoužívají. Notion rovněž umožňuje měnit společný prefix property. (Notion)

Projektové rozhodnutí oproti obecné inspiraci:

- každá task kolekce má vlastní číselnou řadu,
- existující tasky se při přidání property očíslují vzestupně podle času vytvoření.

---

## B. Business cíl

Zajistit, aby bylo možné každý task jednoznačně, stručně a trvale identifikovat například v komunikaci, požadavcích nebo návazných procesech.

ID musí zůstat stabilní i při změně názvu, obsahu nebo ostatních properties tasku.

---

## C. Aktéři

### Správce schématu task kolekce

- přidává property typu `ID`,
- nastavuje nebo mění její název,
- nastavuje nebo mění volitelný prefix.

### Uživatel task systému

- vidí a používá výsledné ID,
- nemůže měnit číselnou část ID,
- nemůže odstranit hodnotu ID konkrétního tasku.

Oprávnění určující, kdo smí měnit schéma, jsou mimo scope této specifikace.

---

## D. Scope

- přidání property typu `ID` do task kolekce,
- automatické přidělení ID existujícím taskům,
- automatické přidělení ID novým taskům,
- samostatná číselná řada pro každou task kolekci,
- stabilní pořadí při prvotním očíslování,
- volitelný prefix,
- změna prefixu,
- zobrazení ID s prefixem nebo bez něj,
- neměnnost přiděleného čísla,
- zákaz ruční editace hodnoty,
- zachování spotřebovaných čísel po smazání tasku,
- zachování unikátnosti při vytvoření více tasků ve stejném čase.

---

## E. Mimo scope

- speciální URL založené na ID,
- vyhledávání, filtrování nebo řazení podle ID,
- integrace s GitHubem nebo jinými systémy,
- import a export ID,
- přesun tasku mezi task kolekcemi,
- slučování nebo rozdělování task kolekcí,
- oprávnění ke změně schématu,
- technický způsob generování čísel,
- generické chování pro přejmenování, skrytí, řazení, duplikaci nebo odstranění properties.

---

## F. Business pravidla

### BR-01: Rozsah unikátnosti

Každá task kolekce má vlastní nezávislou číselnou řadu.

Dvě různé kolekce proto mohou obsahovat stejné číselné ID:

- kolekce A: `TASK-1`,
- kolekce B: `BUG-1`.

V rámci jedné task kolekce nesmí být stejné číslo přiděleno více taskům.

### BR-02: Začátek číselné řady

První přidělená číselná hodnota v task kolekci je `1`.

Každá další nová hodnota je o `1` vyšší než nejvyšší hodnota, která kdy byla v dané řadě přidělena.

### BR-03: Přidání property do existující kolekce

Po přidání property `ID` systém automaticky přidělí čísla všem existujícím taskům.

Tasky se očíslují vzestupně podle `Created time`:

- nejstarší task dostane `1`,
- další task dostane `2`,
- nejnovější task dostane nejvyšší číslo.

### BR-04: Shodný čas vytvoření

Pokud má více tasků stejný `Created time`, systém použije deterministické a stabilní pořadí odpovídající pořadí, v němž byly tasky systémem evidovány.

Jednou přidělené výsledky se již nesmí změnit.

### BR-05: Nové tasky

Každý nový task vytvořený po přidání property dostane ID automaticky.

Uživatel nemusí hodnotu vyplňovat a task nesmí zůstat bez ID.

### BR-06: Neměnnost číselné části

Číselná část ID se po přidělení nikdy nemění, a to ani při:

- změně title,
- změně jiné property,
- změně prefixu,
- změně pořadí tasku,
- změně obsahu tasku.

### BR-07: Hodnota je read-only

Uživatel nemůže:

- zadat vlastní číslo,
- přepsat přidělené číslo,
- vymazat číslo,
- kopírováním jiného tasku vynutit stejné číslo.

### BR-08: Smazání tasku

Smazáním tasku se jeho číslo neuvolní.

Pokud bylo nejvyšší přidělené číslo `42`, následující nový task dostane `43`, i když byl task `42` smazán. Toto odpovídá chování popsanému v Notion dokumentaci. (Notion)

### BR-09: Obnovení smazaného tasku

Obnovený task si zachová původní přidělené číslo.

Obnovení nesmí ovlivnit aktuální pokračování číselné řady.

### BR-10: Souběžné vytvoření tasků

I když je vytvořeno více tasků prakticky ve stejném čase, každý musí dostat právě jedno rozdílné číslo.

Žádný task nesmí dostat duplicitní ID ani zůstat bez ID.

### BR-11: Prefix

Prefix je volitelná konfigurace celé ID property, nikoli hodnota jednotlivého tasku.

Příklady:

- prefix `TASK` a číslo `123` → `TASK-123`,
- prázdný prefix a číslo `123` → `123`.

### BR-12: Změna prefixu

Změna prefixu aktualizuje zobrazovanou hodnotu všech ID v dané task kolekci.

Nemění však:

- číselné části,
- pořadí číselné řady,
- identitu tasků,
- příští číslo řady.

Příklad:

- před změnou: `TASK-18`,
- po změně prefixu na `ISSUE`: `ISSUE-18`.

### BR-13: Normalizace prefixu

Při uložení se odstraní počáteční a koncové mezery.

Systém automaticky nemění velikost písmen.

Pokud je prefix po odstranění mezer prázdný, ID se zobrazuje bez prefixu a bez oddělovací pomlčky.

### BR-14: Počet ID properties

V jedné task kolekci může existovat nejvýše jedna property typu `ID`.

Pokus o přidání další ID property nebude dokončen a uživatel dostane vysvětlení, že kolekce již ID property obsahuje.

---

## G. Klíčové výjimky a hraniční situace

1. **Prázdná kolekce**

   Přidání property nevytváří žádné hodnoty. První následně vytvořený task dostane `1`.

2. **Shodný Created time**

   Tasky dostanou rozdílná čísla ve stabilním pořadí.

3. **Smazání nejvyššího ID**

   Číselná řada pokračuje dál a smazané číslo se znovu nepoužije.

4. **Obnovení staršího tasku**

   Obnovený task si zachová původní ID; nové tasky pokračují v aktuální řadě.

5. **Prázdný prefix**

   Zobrazuje se pouze číslo bez pomlčky.

6. **Prefix obsahující pouze mezery**

   Je považován za prázdný prefix.

7. **Více současně vytvořených tasků**

   Všechny dostanou unikátní hodnoty bez mezer způsobených neúspěšným ručním zadáním.

8. **Pokus o ruční změnu ID**

   Hodnota zůstane beze změny.

---

## H. Akceptační kritéria

- Po přidání ID property má každý existující task právě jedno ID.
- Existující tasky jsou očíslovány od `1` podle vzestupného `Created time`.
- Každý nový task dostane další dosud nepoužité číslo.
- Žádná dvě ID v jedné task kolekci nemají stejnou číselnou část.
- Stejná čísla mohou existovat v různých task kolekcích.
- Číselnou část nelze ručně vytvořit, změnit ani odstranit.
- Změna tasku nezmění jeho číselnou část.
- Smazané číslo se nikdy nepoužije pro jiný task.
- Obnovený task má stejné číslo jako před smazáním.
- Prefix se uplatňuje na všechna ID dané property.
- Změna prefixu nemění číselné části ID.
- Prázdný prefix nezobrazuje oddělovací pomlčku.
- V jedné task kolekci nelze vytvořit druhou ID property.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Automatická ID property tasků

  Property ID poskytuje taskům v jedné task kolekci
  unikátní, automaticky generovaný a neměnný identifikátor.

  Rule: Každá task kolekce má vlastní číselnou řadu

    Scenario: První task v prázdné kolekci dostane číslo 1
      Given prázdná task kolekce obsahuje property typu ID
      When uživatel vytvoří první task
      Then číselná hodnota ID tasku je 1

    Scenario: Různé kolekce mohou používat stejné číslo
      Given kolekce "Vývoj" obsahuje property typu ID
      And kolekce "Marketing" obsahuje property typu ID
      And v žádné z kolekcí dosud nebylo přiděleno číslo
      When uživatel vytvoří jeden task v každé kolekci
      Then task v kolekci "Vývoj" má číselnou hodnotu 1
      And task v kolekci "Marketing" má číselnou hodnotu 1

  Rule: Existující tasky se očíslují podle času vytvoření

    Scenario: Přidání ID property do kolekce s existujícími tasky
      Given kolekce obsahuje task A vytvořený 1. července 2026 v 09:00
      And kolekce obsahuje task B vytvořený 2. července 2026 v 09:00
      And kolekce obsahuje task C vytvořený 3. července 2026 v 09:00
      And kolekce neobsahuje property typu ID
      When správce přidá property typu ID
      Then task A dostane číselnou hodnotu 1
      And task B dostane číselnou hodnotu 2
      And task C dostane číselnou hodnotu 3

    Scenario: Nový task pokračuje po očíslování existujících tasků
      Given existujícím taskům byly přiděleny hodnoty 1 až 3
      When uživatel vytvoří nový task
      Then nový task dostane číselnou hodnotu 4

    Scenario: Tasky se stejným časem vytvoření dostanou stabilní rozdílná čísla
      Given task A a task B mají stejný Created time
      And systém evidoval task A před taskem B
      When správce přidá property typu ID
      Then task A dostane nižší číslo než task B
      And obě čísla zůstanou po přidělení neměnná

  Rule: Novým taskům se ID přiděluje automaticky

    Scenario: Vytvoření nového tasku
      Given nejvyšší dosud přidělená číselná hodnota v kolekci je 24
      When uživatel vytvoří nový task
      Then nový task dostane číselnou hodnotu 25
      And task nezůstane bez ID

    Scenario: Souběžně vytvořené tasky dostanou unikátní čísla
      Given nejvyšší dosud přidělená číselná hodnota v kolekci je 24
      When jsou vytvořeny dva nové tasky ve stejném čase
      Then jeden nový task dostane číselnou hodnotu 25
      And druhý nový task dostane číselnou hodnotu 26
      And žádné číslo není přiděleno oběma taskům

  Rule: Číselná část ID je neměnná a pouze pro čtení

    Scenario: Změna tasku nezmění jeho ID
      Given task má číselnou hodnotu 42
      When uživatel změní title, obsah a ostatní properties tasku
      Then číselná hodnota ID zůstane 42

    Scenario: Uživatel nemůže přepsat číselnou hodnotu
      Given task má číselnou hodnotu 42
      When se uživatel pokusí nastavit číselnou hodnotu na 10
      Then změna není provedena
      And číselná hodnota zůstane 42

    Scenario: Uživatel nemůže odstranit číselnou hodnotu
      Given task má číselnou hodnotu 42
      When se uživatel pokusí hodnotu ID vymazat
      Then změna není provedena
      And číselná hodnota zůstane 42

  Rule: Přidělená čísla se znovu nepoužívají

    Scenario: Smazané číslo není přiděleno novému tasku
      Given nejvyšší přidělená číselná hodnota je 42
      And task s číselnou hodnotou 42 byl smazán
      When uživatel vytvoří nový task
      Then nový task dostane číselnou hodnotu 43
      And číselná hodnota 42 není znovu použita

    Scenario: Obnovený task si zachová původní ID
      Given task s číselnou hodnotou 42 byl smazán
      And další nový task dostal číselnou hodnotu 43
      When uživatel obnoví smazaný task
      Then obnovený task má číselnou hodnotu 42
      And druhý task má nadále číselnou hodnotu 43
      And následující nový task dostane číselnou hodnotu 44

  Rule: Prefix je společnou konfigurací ID property

    Scenario: Zobrazení ID s prefixem
      Given ID property má prefix "TASK"
      And task má číselnou hodnotu 123
      When systém zobrazí ID
      Then zobrazovaná hodnota je "TASK-123"

    Scenario: Zobrazení ID bez prefixu
      Given ID property nemá prefix
      And task má číselnou hodnotu 123
      When systém zobrazí ID
      Then zobrazovaná hodnota je "123"

    Scenario: Prefix tvořený mezerami je považován za prázdný
      Given správce zadal prefix tvořený pouze mezerami
      And task má číselnou hodnotu 123
      When správce uloží konfiguraci property
      Then prefix je uložen jako prázdný
      And zobrazovaná hodnota tasku je "123"

    Scenario: Změna prefixu aktualizuje zobrazení všech tasků
      Given ID property má prefix "TASK"
      And task A má číselnou hodnotu 12
      And task B má číselnou hodnotu 13
      When správce změní prefix na "ISSUE"
      Then zobrazovaná hodnota tasku A je "ISSUE-12"
      And zobrazovaná hodnota tasku B je "ISSUE-13"
      And číselné hodnoty tasků zůstávají 12 a 13

  Rule: Kolekce může mít pouze jednu ID property

    Scenario: Pokus o přidání druhé ID property
      Given task kolekce již obsahuje property typu ID
      When se správce pokusí přidat další property typu ID
      Then nová property není vytvořena
      And správce dostane informaci, že kolekce již ID property obsahuje
```

---

## J. Explicitní hypotézy

### H1: Jedna ID property na kolekci

V jedné task kolekci může existovat nejvýše jedna property typu `ID`.

Důvod: více nezávislých identifikátorů stejného typu by nebylo jednoznačné pro uživatele ani návazné procesy.

### H2: Stabilní pořadí při shodném Created time

Při shodném `Created time` rozhoduje stabilní pořadí, v němž byly tasky systémem evidovány.

Důvod: všechny existující tasky musí dostat deterministické a reprodukovatelné hodnoty.

### H3: Obnovení zachovává ID

Obnovený task si zachovává původní číslo.

Důvod: ID představuje trvalou identitu tasku a podle inspirace z Notion se jednou přidělená čísla nemění ani u smazaných položek. (Notion)

### H4: Normalizace prefixu

Prefix se ořízne o počáteční a koncové mezery, ale systém nemění velikost písmen.

Důvod: zabrání se neviditelným rozdílům bez zbytečné změny uživatelem zadané hodnoty.

### H5: Generický životní cyklus property

Přejmenování, skrytí, změna pořadí, duplikace a odstranění property se řídí společnou specifikací properties a nejsou touto specifikací ID měněny.

Původní brief určoval pouze inspiraci Notionem, ale neříkal, kde má unikátnost platit ani jak nevratně očíslovat existující tasky. Rozhodnutí **1A a 2A** z něj udělala deterministické zadání, podle kterého lze implementovat i automaticky testovat konkrétní hodnoty.
