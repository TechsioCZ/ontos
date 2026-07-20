# Readiness score: GOLD

- Rozsah MVP, hlavní aktér i sdílené schéma jsou potvrzené.
- Jsou definované podporované hodnoty, formáty, filtry, řazení i duplikace.
- Klíčové situace jsou konkrétní a testovatelné.
- Zbývají pouze drobné prezentační hypotézy bez zásadního dopadu na business tok.

# A. Executive summary

Property **Number** umožňuje ukládat jednu číselnou hodnotu ke každému tasku ve sdíleném schématu.

Podporuje:

- celá, desetinná, nulová a záporná čísla,
- formáty `Number`, `Number with separators` a `Percent`,
- číselné filtrování,
- vzestupné a sestupné řazení,
- duplikaci property s povinnou volbou, zda zkopírovat také hodnoty existujících tasků.

Nepovolené znaky nelze vložit do hodnoty.

# B. Business cíl

Umožnit uživatelům ukládat strukturované číselné údaje k taskům a následně podle nich tasky zobrazovat, filtrovat a řadit.

Typické použití:

- odhad pracnosti,
- počet kusů,
- priorita vyjádřená číslem,
- body,
- procento dokončení.

# C. Aktéři

## Správce schématu tasků

Může:

- vytvořit Number property,
- přejmenovat ji,
- změnit její formát,
- duplikovat ji,
- odstranit ji.

## Uživatel tasku

Může:

- zadat hodnotu,
- změnit hodnotu,
- odstranit hodnotu,
- filtrovat a řadit tasky podle Number property.

# D. Scope

- vytvoření Number property ve sdíleném schématu,
- pojmenování a přejmenování property,
- zadání jedné hodnoty na task,
- celá, desetinná, nulová a záporná čísla,
- odstranění hodnoty,
- formáty:
  - `Number`,
  - `Number with separators`,
  - `Percent`,
- změna formátu existující property,
- filtrování:
  - `=`,
  - `≠`,
  - `>`,
  - `<`,
  - `≥`,
  - `≤`,
  - `Is empty`,
  - `Is not empty`,
- vzestupné a sestupné řazení,
- duplikace property,
- dotaz při duplikaci na kopírování hodnot.

# E. Mimo scope

- měnové formáty,
- vlastní jednotky,
- formule a automatické výpočty,
- agregace hodnot přes více tasků,
- progress bar a progress ring,
- uživatelsky nastavitelné minimum a maximum,
- automatická konverze hodnot při změně formátu,
- více hodnot v jedné Number property,
- povinné vyplnění hodnoty.

# F. Business pravidla

## Definice property

1. Number property je součástí sdíleného schématu tasků.
2. Po vytvoření je dostupná u všech tasků používajících dané schéma.
3. Existující tasky mají novou property ve stavu `Empty`.
4. Každý task může mít v jedné Number property nejvýše jednu hodnotu.
5. Výchozí formát nové property je `Number`.

## Povolené hodnoty

1. Property podporuje:
   - kladná čísla,
   - záporná čísla,
   - nulu,
   - celá čísla,
   - desetinná čísla.
2. Prázdná hodnota je platný stav.
3. Prázdná hodnota a `0` jsou odlišné stavy.
4. Nepovolené znaky nelze zadat ani vložit jako součást hodnoty.
5. Záporné číslo může obsahovat jedno znaménko minus pouze před číselnou částí.
6. Číslo může obsahovat nejvýše jeden desetinný oddělovač.
7. Neúplná nebo neplatná hodnota se neuloží.

## Formátování

1. Formát ovlivňuje pouze zobrazení hodnoty.
2. Změna formátu nemění uložené číslo.
3. `Number` zobrazí číslo bez skupinových oddělovačů.
4. `Number with separators` zobrazí skupinové oddělovače tisíců.
5. `Percent` interpretuje zadanou hodnotu přímo jako procento.
6. Hodnota `25` se ve formátu `Percent` zobrazí jako `25 %`.
7. Změna formátu se projeví u všech tasků používajících danou property.

## Duplikace

1. Při duplikaci vznikne nová samostatná Number property.
2. Nová property převezme konfiguraci původní property.
3. Při každé duplikaci se systém zeptá, zda chce uživatel zkopírovat také hodnoty.
4. Pokud uživatel zvolí kopírování hodnot, hodnoty se zkopírují pro všechny existující tasky.
5. Pokud uživatel kopírování hodnot odmítne, nová property zůstane u všech tasků prázdná.
6. Pozdější změna původní property neovlivní její duplikát a naopak.

## Filtrování

1. Operátory `=`, `≠`, `>`, `<`, `≥` a `≤` porovnávají skutečnou číselnou hodnotu.
2. Formát zobrazení nemění výsledek filtrování.
3. `Is empty` vrací pouze tasky bez hodnoty.
4. `Is not empty` vrací všechny tasky s hodnotou včetně `0`.
5. Tasky s prázdnou hodnotou nejsou zahrnuty do číselných porovnání.
6. Výjimkou je operátor `≠`, který rovněž porovnává pouze vyplněné hodnoty; prázdné hodnoty se řeší samostatně pomocí `Is empty`.

## Řazení

1. Vzestupné řazení seřadí vyplněné hodnoty od nejmenší po největší.
2. Sestupné řazení seřadí vyplněné hodnoty od největší po nejmenší.
3. Záporná čísla se řadí podle své skutečné číselné hodnoty.
4. Prázdné hodnoty jsou řazeny za vyplněnými hodnotami v obou směrech.

# G. Klíčové výjimky a hraniční situace

- `0` není prázdná hodnota.
- `5` je menší než `0`.
- Hodnota `5.5` je číslo, nikoliv text.
- Více desetinných oddělovačů není povoleno.
- Minus uprostřed nebo na konci hodnoty není povoleno.
- Změna formátu z `Number` na `Percent` nezmění hodnotu `25` na `0,25`.
- Duplikace bez kopírování hodnot nesmí ovlivnit původní hodnoty.
- Kopírování hodnot proběhne podle stavu tasků v okamžiku duplikace.
- Pozdější změny hodnot se mezi původní a duplikovanou property nesynchronizují.
- Prázdná hodnota nesmí odpovídat filtru `≠ 5`; pro prázdné hodnoty slouží explicitní operátor.

# H. Akceptační kritéria

1. Uživatel může vytvořit Number property ve sdíleném schématu.
2. Nová property používá výchozí formát `Number`.
3. Uživatel může uložit celé, desetinné, záporné i nulové číslo.
4. Nepovolené znaky se nestanou součástí uložené hodnoty.
5. Uživatel může hodnotu odstranit a nastavit property do stavu `Empty`.
6. Systém rozlišuje `0` a prázdnou hodnotu.
7. Uživatel může zvolit jeden ze tří podporovaných formátů.
8. Změna formátu nezmění uložené číslo.
9. Hodnota `25` se ve formátu `Percent` zobrazí jako `25 %`.
10. Uživatel může použít všechny potvrzené operátory filtrování.
11. Číselné porovnání nezahrnuje prázdné hodnoty.
12. Uživatel může tasky řadit vzestupně a sestupně.
13. Prázdné hodnoty jsou při řazení vždy na konci.
14. Při duplikaci se systém vždy zeptá na kopírování hodnot.
15. Volba kopírování hodnot vytvoří nový nezávislý snapshot hodnot.
16. Odmítnutí kopírování vytvoří prázdnou duplikovanou property.

# I. BDD scénáře v Gherkinu

```gherkin
Feature: Number property
  Jako uživatel task systému
  chci ukládat a používat číselné hodnoty
  abych mohl tasky porovnávat, filtrovat a řadit

  Rule: Number property je definována ve sdíleném schématu

    Scenario: Vytvoření Number property
      Given uživatel může upravovat schéma tasků
      When vytvoří property typu Number s názvem "Estimate"
      Then property "Estimate" je dostupná u všech tasků daného schématu
      And výchozí formát property je "Number"
      And hodnota property je u existujících tasků prázdná

  Rule: Number property přijímá platná čísla

    Scenario Outline: Uložení platné hodnoty
      Given task obsahuje editovatelnou Number property
      When uživatel zadá hodnotu <hodnota>
      Then systém uloží číselnou hodnotu <hodnota>

      Examples:
        | hodnota |
        | 0       |
        | 15      |
        | -4      |
        | 12.5    |
        | -3.75   |

    Scenario: Odmítnutí písmen
      Given Number property je prázdná
      When se uživatel pokusí zadat hodnotu "abc"
      Then písmena se nestanou součástí hodnoty
      And property zůstane prázdná

    Scenario: Odmítnutí nepovoleného symbolu
      Given Number property obsahuje hodnotu 10
      When se uživatel pokusí přidat nepovolený symbol
      Then nepovolený symbol se nestane součástí hodnoty
      And hodnota zůstane 10

    Scenario: Odmítnutí více desetinných oddělovačů
      Given Number property je prázdná
      When se uživatel pokusí zadat číslo se dvěma desetinnými oddělovači
      Then systém neuloží neplatnou hodnotu

    Scenario: Odmítnutí minus mimo začátek čísla
      Given Number property je prázdná
      When se uživatel pokusí zadat hodnotu "12-5"
      Then systém neuloží neplatnou hodnotu

    Scenario: Odstranění hodnoty
      Given Number property obsahuje hodnotu 0
      When uživatel hodnotu odstraní
      Then property je prázdná
      And property neobsahuje hodnotu 0

  Rule: Formát mění pouze prezentaci hodnoty

    Scenario: Zobrazení běžného čísla
      Given Number property obsahuje hodnotu 12500
      And používá formát "Number"
      Then systém zobrazí hodnotu bez skupinových oddělovačů

    Scenario: Zobrazení čísla s oddělovači
      Given Number property obsahuje hodnotu 12500
      And používá formát "Number with separators"
      Then systém zobrazí hodnotu se skupinovými oddělovači
      And uložená hodnota zůstane 12500

    Scenario: Zobrazení procentní hodnoty
      Given Number property používá formát "Percent"
      When uživatel uloží hodnotu 25
      Then systém zobrazí hodnotu jako 25 %
      And uložená hodnota zůstane 25

    Scenario: Změna formátu existující property
      Given Number property obsahuje hodnoty u více tasků
      When uživatel změní její formát
      Then systém zobrazí všechny hodnoty v novém formátu
      And žádnou uloženou číselnou hodnotu nezmění

  Rule: Property lze duplikovat s volitelným kopírováním hodnot

    Scenario: Systém se při duplikaci zeptá na kopírování hodnot
      Given Number property existuje ve schématu
      When uživatel spustí její duplikaci
      Then systém požádá uživatele o rozhodnutí, zda zkopírovat hodnoty
      And duplikaci nedokončí bez tohoto rozhodnutí

    Scenario: Duplikace bez kopírování hodnot
      Given property "Estimate" obsahuje hodnoty u existujících tasků
      When uživatel property duplikuje
      And odmítne kopírování hodnot
      Then vznikne nová Number property se stejnou konfigurací
      And její hodnoty jsou u všech tasků prázdné
      And původní hodnoty zůstanou nezměněné

    Scenario: Duplikace včetně hodnot
      Given property "Estimate" obsahuje hodnotu 8 u tasku A
      And obsahuje hodnotu 13 u tasku B
      When uživatel property duplikuje
      And potvrdí kopírování hodnot
      Then nová property obsahuje hodnotu 8 u tasku A
      And nová property obsahuje hodnotu 13 u tasku B
      And původní hodnoty zůstanou nezměněné

    Scenario: Hodnoty duplikovaných properties jsou nezávislé
      Given byla property duplikována včetně hodnot
      When uživatel změní hodnotu v původní property
      Then hodnota v duplikované property se nezmění

  Rule: Number property podporuje číselné filtrování

    Scenario Outline: Filtrování podle číselné hodnoty
      Given task A obsahuje hodnotu 4
      And task B obsahuje hodnotu 5
      And task C obsahuje hodnotu 8
      When uživatel použije filtr "<operátor>" s hodnotou 5
      Then systém zobrazí tasky "<výsledek>"

      Examples:
        | operátor | výsledek |
        | =        | B        |
        | ≠        | A, C     |
        | >        | C        |
        | <        | A        |
        | ≥        | B, C     |
        | ≤        | A, B     |

    Scenario: Filtr Is empty rozlišuje prázdnou hodnotu a nulu
      Given task A má Number property prázdnou
      And task B obsahuje hodnotu 0
      When uživatel použije filtr "Is empty"
      Then systém zobrazí task A
      And nezobrazí task B

    Scenario: Filtr Is not empty zahrnuje nulu
      Given task A má Number property prázdnou
      And task B obsahuje hodnotu 0
      When uživatel použije filtr "Is not empty"
      Then systém zobrazí task B
      And nezobrazí task A

    Scenario: Číselný filtr ignoruje prázdnou hodnotu
      Given task A má Number property prázdnou
      And task B obsahuje hodnotu 5
      When uživatel použije filtr "≠ 5"
      Then systém nezobrazí task A
      And nezobrazí task B

    Scenario: Formát nemění výsledek filtrování
      Given Number property obsahuje hodnotu 25
      And používá formát "Percent"
      When uživatel použije filtr "= 25"
      Then systém zobrazí task s hodnotou 25

  Rule: Number property podporuje číselné řazení

    Scenario: Vzestupné řazení
      Given task A obsahuje hodnotu 20
      And task B obsahuje hodnotu 5
      And task C obsahuje hodnotu 12
      When uživatel seřadí tasky vzestupně
      Then pořadí tasků je B, C, A

    Scenario: Sestupné řazení
      Given task A obsahuje hodnotu 20
      And task B obsahuje hodnotu 5
      And task C obsahuje hodnotu 12
      When uživatel seřadí tasky sestupně
      Then pořadí tasků je A, C, B

    Scenario: Řazení záporných hodnot
      Given task A obsahuje hodnotu -10
      And task B obsahuje hodnotu 0
      And task C obsahuje hodnotu -2
      When uživatel seřadí tasky vzestupně
      Then pořadí tasků je A, C, B

    Scenario Outline: Prázdné hodnoty jsou při řazení na konci
      Given task A má Number property prázdnou
      And task B obsahuje hodnotu 5
      When uživatel použije <směr> řazení
      Then task B je před taskem A

      Examples:
        | směr       |
        | vzestupné  |
        | sestupné   |
```

# J. Explicitní hypotézy

1. Desetinný oddělovač se zadává a zobrazuje podle aktivního locale uživatele.
2. Interně je hodnota uložena nezávisle na locale.
3. `Number with separators` používá oddělovače tisíců podle aktivního locale.
4. Duplikovaná property získá automaticky odlišitelný název od původní property.
5. Prázdné hodnoty jsou při vzestupném i sestupném řazení vždy na konci.
6. Operátor `≠` nezahrnuje prázdné hodnoty; ty se filtrují pouze pomocí `Is empty`.
