Potvrzené odpovědi odstraňují poslední zásadní nejasnosti. Checkbox je obecná binární property a všechny tasky mají po jejím přidání výchozí hodnotu `false`.

**Readiness score: GOLD**

- Význam property je jednoznačný a oddělený od dokončení tasku.
- Hodnotový model obsahuje pouze `true` a `false`.
- Výchozí chování nových i existujících tasků je potvrzené.
- Hlavní tok, filtrace i důležité hraniční situace jsou testovatelné.

# Checkbox property — finální business specifikace

## A. Executive summary

Checkbox property umožňuje uživateli evidovat na každém tasku jednoduchou podmínku se dvěma možnými hodnotami:

- `true` — podmínka je označena jako splněná,
- `false` — podmínka není označena jako splněná.

Checkbox je obecná uživatelská property. Nemá automatickou vazbu na dokončení tasku, jeho Status ani jiné properties. Konkrétní význam Checkboxu určuje uživatel jeho názvem, například `Schváleno`, `Fakturováno` nebo `Vyžaduje kontrolu`.

---

## B. Business cíl

Umožnit uživatelům přidávat k taskům jednoduché binární příznaky, podle kterých mohou:

- evidovat splnění konkrétní podmínky,
- měnit hodnotu samostatně na jednotlivých taskech,
- filtrovat tasky podle toho, zda je podmínka splněná.

---

## C. Aktéři

### Hlavní aktér

**Uživatel oprávněný spravovat properties a upravovat tasky.**

Detailní permission model není součástí této specifikace.

---

## D. Scope

Součástí specifikace je:

- vytvoření property typu `Checkbox`,
- pojmenování property,
- dostupnost property na taskech,
- výchozí hodnota,
- změna hodnoty `false → true`,
- změna hodnoty `true → false`,
- filtrování tasků podle hodnoty Checkboxu,
- chování při přidání property k existujícím taskům.

---

## E. Mimo scope

Mimo scope je:

- automatická vazba Checkboxu na dokončení tasku,
- automatická změna Status property,
- automatické akce spuštěné změnou Checkboxu,
- historie a audit změn,
- hromadná změna hodnot,
- řazení a seskupování,
- oprávnění,
- formule a odvozené hodnoty,
- API a integrace,
- technická a vizuální implementace ovládacího prvku,
- obecný lifecycle properties, například duplikace nebo odstranění.

---

## F. Business pravidla

### BR-01: Obecná property

Checkbox je obecná uživatelská property.

Jeho změna sama o sobě neznamená dokončení tasku a nemění žádný systémový stav tasku.

### BR-02: Název property

Při vytvoření Checkbox property uživatel určí její název.

Název vyjadřuje podmínku, kterou Checkbox reprezentuje.

### BR-03: Povolené hodnoty

Checkbox může mít právě jednu ze dvou hodnot:

- `true`,
- `false`.

Checkbox nepodporuje hodnotu `Empty`, `null` ani jiný třetí stav.

### BR-04: Výchozí hodnota

Výchozí hodnota Checkbox property je vždy `false`.

To platí pro:

- nový task vytvořený po vzniku property,
- existující task při přidání nové Checkbox property.

### BR-05: Hodnota je samostatná pro každý task

Každý task má vlastní hodnotu Checkbox property.

Změna hodnoty na jednom tasku nesmí změnit hodnotu stejné property na jiném tasku.

### BR-06: Změna hodnoty

Uživatel může změnit hodnotu:

- z `false` na `true`,
- z `true` na `false`.

Opakovaná změna musí být povolena bez omezení.

### BR-07: Bez vedlejších změn

Změna Checkbox property nesmí automaticky změnit:

- Status tasku,
- Title tasku,
- jinou property,
- stav dokončení tasku.

### BR-08: Konfigurace property

Checkbox nemá vlastní seznam možností ani další hodnotovou konfiguraci.

Nepodporuje například:

- uživatelské možnosti,
- vlastní popisky hodnot,
- vlastní barvu jednotlivých hodnot,
- více současně vybraných hodnot.

### BR-09: Filtrování

Tasky lze filtrovat podle podmínky:

- Checkbox je zaškrtnutý — hodnota `true`,
- Checkbox není zaškrtnutý — hodnota `false`.

Výsledek filtru musí vždy vycházet z aktuální hodnoty property na jednotlivých taskech.

---

## G. Klíčové výjimky a hraniční situace

### Přidání property k existujícím taskům

Při přidání nové Checkbox property dostanou všechny existující tasky hodnotu `false`.

Systém nesmí existující tasky ponechat bez hodnoty.

### Nový task

Nový task dostane pro každou existující Checkbox property hodnotu `false`, dokud ji uživatel výslovně nezmění.

### Opakované přepínání

Checkbox lze opakovaně měnit mezi `true` a `false`.

Předchozí změna neomezuje další změny.

### Nezávislost tasků

Změna hodnoty na jednom tasku nesmí ovlivnit jiné tasky.

### Nezávislost properties

Změna jedné Checkbox property nesmí ovlivnit jinou Checkbox property ani property jiného typu.

### Absence třetího stavu

Task nesmí mít Checkbox property ve stavu `Empty`.

Pokud property existuje, musí být její hodnota vždy `true` nebo `false`.

---

## H. Akceptační kritéria

1. Uživatel může vytvořit property typu `Checkbox` a pojmenovat ji.
2. Checkbox property podporuje pouze hodnoty `true` a `false`.
3. Checkbox property nemůže zůstat bez hodnoty.
4. Po vytvoření property mají všechny existující tasky hodnotu `false`.
5. Nově vytvořený task má výchozí hodnotu všech Checkbox properties `false`.
6. Uživatel může změnit hodnotu z `false` na `true`.
7. Uživatel může změnit hodnotu z `true` na `false`.
8. Hodnota se mění pouze na upravovaném tasku.
9. Změna Checkboxu nemění Status ani jiné properties.
10. Tasky lze filtrovat podle hodnoty `true`.
11. Tasky lze filtrovat podle hodnoty `false`.
12. Checkbox nemá žádnou další hodnotovou konfiguraci.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Checkbox property tasku

  Uživatelé potřebují na taskech evidovat jednoduché podmínky,
  které mohou být splněné nebo nesplněné.

  Rule: Checkbox je obecná binární property

    Scenario: Vytvoření Checkbox property
      Given uživatel může spravovat properties tasků
      When vytvoří property s názvem "Schváleno" a typem "Checkbox"
      Then property "Schváleno" je dostupná na taskech
      And její hodnota může být pouze true nebo false
      And property nemá žádné další uživatelsky definované možnosti

    Scenario: Checkbox není stavem dokončení tasku
      Given task má Checkbox property "Schváleno" s hodnotou false
      And task není označen jako dokončený
      When uživatel změní hodnotu "Schváleno" na true
      Then hodnota property "Schváleno" je true
      And stav dokončení tasku zůstane beze změny

  Rule: Výchozí hodnota Checkbox property je false

    Scenario: Výchozí hodnota na novém tasku
      Given existuje Checkbox property "Schváleno"
      When uživatel vytvoří nový task
      Then hodnota property "Schváleno" na novém tasku je false

    Scenario: Přidání Checkbox property k existujícím taskům
      Given v systému existují tasky
      When uživatel vytvoří Checkbox property "Schváleno"
      Then všechny existující tasky mají hodnotu "Schváleno" nastavenou na false
      And žádný existující task nemá hodnotu property "Schváleno" ve stavu Empty

  Rule: Hodnotu Checkboxu lze přepínat

    Scenario: Zaškrtnutí Checkboxu
      Given task má property "Schváleno" s hodnotou false
      When uživatel nastaví property "Schváleno" jako zaškrtnutou
      Then hodnota property "Schváleno" je true

    Scenario: Zrušení zaškrtnutí Checkboxu
      Given task má property "Schváleno" s hodnotou true
      When uživatel nastaví property "Schváleno" jako nezaškrtnutou
      Then hodnota property "Schváleno" je false

    Scenario: Opakované přepnutí Checkboxu
      Given task má property "Schváleno" s hodnotou false
      When uživatel změní hodnotu na true
      And následně ji změní zpět na false
      Then výsledná hodnota property "Schváleno" je false

  Rule: Hodnota Checkboxu je nezávislá pro každý task

    Scenario: Změna Checkboxu na jednom tasku
      Given task "A" má property "Schváleno" s hodnotou false
      And task "B" má property "Schváleno" s hodnotou false
      When uživatel změní hodnotu "Schváleno" na tasku "A" na true
      Then task "A" má hodnotu "Schváleno" true
      And task "B" má hodnotu "Schváleno" false

  Rule: Změna Checkboxu neovlivňuje ostatní properties

    Scenario: Změna Checkboxu při existenci dalších properties
      Given task má property "Schváleno" s hodnotou false
      And task má Status property s hodnotou "In progress"
      And task má Checkbox property "Fakturováno" s hodnotou false
      When uživatel změní hodnotu "Schváleno" na true
      Then hodnota property "Schváleno" je true
      And hodnota Status property zůstane "In progress"
      And hodnota property "Fakturováno" zůstane false

  Rule: Tasky lze filtrovat podle hodnoty Checkboxu

    Scenario: Filtrování zaškrtnutých tasků
      Given task "A" má property "Schváleno" s hodnotou true
      And task "B" má property "Schváleno" s hodnotou false
      When uživatel použije filtr "Schváleno je zaškrtnuto"
      Then systém zobrazí task "A"
      And systém nezobrazí task "B"

    Scenario: Filtrování nezaškrtnutých tasků
      Given task "A" má property "Schváleno" s hodnotou true
      And task "B" má property "Schváleno" s hodnotou false
      When uživatel použije filtr "Schváleno není zaškrtnuto"
      Then systém zobrazí task "B"
      And systém nezobrazí task "A"

    Scenario: Aktualizace výsledku filtru po změně Checkboxu
      Given je aktivní filtr "Schváleno je zaškrtnuto"
      And task má property "Schváleno" s hodnotou false
      When uživatel změní hodnotu "Schváleno" na true
      Then task odpovídá aktivnímu filtru
```

---

## J. Explicitní hypotézy

Všechny hypotézy, které zásadně měnily chování Checkbox property, byly potvrzeny.

Pro navazující specifikace zůstávají mimo tento handoff následující obecná pravidla properties:

- validace názvu property,
- přejmenování property,
- duplikace property,
- odstranění property,
- společné řazení a seskupování,
- hromadná editace hodnot.

Tato témata nemění základní význam ani hodnotový model Checkbox property a mají být řešena jako společné chování všech properties.

Coaching note: Původní brief určoval pouze typ property a inspirační produkt. Potvrzením obecného významu a výchozí hodnoty `false` vzniklo jednoznačné zadání bez třetího stavu a bez skrytých vazeb na dokončení tasku.
