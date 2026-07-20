Potvrzené varianty uzavírají dvě zásadní nejasnosti: autor se eviduje vždy od vzniku tasku a při každém vytvoření se zaznamenává skutečný aktér dané operace.

# Created by property — finální business specifikace

## Readiness score: GOLD

- Význam property, okamžik vzniku hodnoty a její neměnnost jsou jednoznačné.
- Je definováno chování pro existující tasky i nepřímé způsoby vytvoření.
- Hlavní pravidla, výjimky a hranice scope jsou testovatelné.
- Specifikace je připravena pro předání coding agents.

---

## A. Executive summary

Property `Created by` zobrazuje identitu aktéra, který vytvořil konkrétní task.

Jde o automaticky spravovanou a neměnnou systémovou hodnotu. Uživatel ji nevyplňuje, nemůže ji změnit ani odstranit z konkrétního tasku.

Informace o autorovi se eviduje při vytvoření každého tasku bez ohledu na to, zda je property `Created by` aktuálně součástí zobrazeného schématu. Pokud je property přidána později, zobrazí skutečné autory existujících tasků.

Autorem může být uživatel nebo pojmenovaná systémová identita, například automatizace či importní proces.

---

## B. Business cíl

Umožnit uživatelům spolehlivě zjistit, kdo nebo co vytvořilo konkrétní task.

Property podporuje:

- dohledatelnost původu tasku,
- rozlišení ručně a automaticky vytvořených tasků,
- filtrování tasků podle jejich původního autora.

Property neslouží k určení aktuálního vlastníka, řešitele ani posledního editora tasku.

---

## C. Aktéři

### Uživatel

Přihlášená osoba, která vytvoří nový task ručně, duplikací nebo jinou uživatelskou akcí.

### Systémový aktér

Pojmenovaná systémová identita, která vytvoří task bez přímého ručního vytvoření uživatelem.

Příklady:

- automatizace,
- importní proces,
- externí nebo interní systémová operace.

### Uživatel zobrazující tasky

Uživatel, který zobrazuje, vyhledává nebo filtruje tasky podle hodnoty `Created by`.

---

## D. Scope

Součástí řešení je:

1. automatická evidence autora při vytvoření každého tasku,
2. zobrazení jednoho původního autora,
3. podpora uživatelských i systémových identit,
4. neměnnost hodnoty,
5. zobrazení hodnoty u existujících tasků po přidání property,
6. zachování hodnoty při úpravách tasku,
7. správné určení autora při duplikaci,
8. správné určení autora při automatizovaném vytvoření,
9. filtrování tasků podle hodnoty `Created by`,
10. zachování informace při skrytí, odstranění nebo opětovném přidání property do schématu.

---

## E. Mimo scope

Mimo scope je:

- aktuální vlastník tasku,
- řešitel nebo assignee,
- poslední editor tasku,
- úplná historie změn,
- auditní log všech operací,
- notifikace autora,
- oprávnění ke čtení nebo editaci tasku,
- reporting výkonu uživatelů,
- slučování více autorů,
- ruční oprava nebo přepis autora,
- technická implementace ukládání identity,
- migrace tasků, u kterých autor historicky nebyl evidován.

---

## F. Business pravidla

### BR-01: Automatické určení autora

Při vytvoření tasku systém automaticky zaznamená aktéra, který task vytvořil.

Hodnota nevyžaduje žádnou uživatelskou akci ani ruční vyplnění.

### BR-02: Evidence nezávislá na zobrazení property

Autor se eviduje při vytvoření každého tasku, i když property `Created by` není aktuálně přidána nebo zobrazena ve schématu.

### BR-03: Jeden autor

Každý task má právě jednoho původního autora.

Property nepodporuje více hodnot.

### BR-04: Neměnná hodnota

Po vytvoření tasku nelze hodnotu `Created by`:

- ručně změnit,
- ručně vymazat,
- nahradit jinou identitou.

### BR-05: Změny tasku nemění autora

Úprava názvu, obsahu nebo jiné property tasku nemění hodnotu `Created by`.

Hodnotu nemění ani změna:

- řešitele,
- vlastníka,
- statusu,
- priority,
- termínu,
- jiných business properties.

### BR-06: Ruční vytvoření

Pokud task vytvoří přihlášený uživatel, hodnota `Created by` odpovídá identitě tohoto uživatele.

### BR-07: Duplikace

Duplikovaný task je nový samostatný task.

Jeho autorem je uživatel, který duplikaci provedl. Autor původního tasku se do nového tasku nepřebírá.

### BR-08: Automatizované vytvoření

Pokud task vytvoří automatizace nebo jiný systémový proces, hodnotou `Created by` je pojmenovaná identita tohoto systémového aktéra.

Systém nesmí jako autora automaticky uvést administrátora workspace ani autora šablony, pokud task fakticky vytvořila automatizace.

### BR-09: Import

Pokud import vytváří nové tasky, autorem je aktér provádějící vytvoření:

- uživatel provádějící import, pokud jsou tasky vytvářeny jeho jménem,
- pojmenovaný importní proces, pokud tasky vytváří samostatná systémová identita.

Autor původního záznamu z externího systému se automaticky nepřebírá do `Created by`.

### BR-10: Přidání property k existujícím taskům

Pokud je `Created by` přidána do schématu až po vytvoření tasků, systém zobrazí skutečné původní autory všech existujících tasků.

Hodnota se neurčuje podle uživatele, který property přidal.

### BR-11: Skrytí nebo odstranění property

Skrytí nebo odstranění property ze schématu neodstraní evidovanou informaci o autorovi.

Při opětovném přidání property se zobrazí původní hodnota.

### BR-12: Filtrování

Tasky lze filtrovat podle konkrétní hodnoty `Created by`.

Výsledek obsahuje pouze tasky vytvořené vybranou identitou.

### BR-13: Přejmenování property

Uživatel může změnit zobrazovaný název property, pokud systém obecně umožňuje přejmenování properties.

Přejmenování nemění její typ, význam ani hodnoty.

---

## G. Klíčové výjimky a hraniční situace

### Deaktivovaný nebo odebraný uživatel

Pokud původní autor později ztratí přístup nebo je jeho účet deaktivován, task si zachová historickou identitu autora.

Systém může autora označit jako neaktivního, ale nesmí jej nahradit jiným uživatelem.

### Odstranění zdrojového tasku

Odstranění původního tasku nemění autora jeho již existujících duplikátů.

Každý duplikát má vlastního autora podle aktéra, který duplikaci provedl.

### Úprava systémovou automatizací

Pokud automatizace pouze upraví existující task, hodnota `Created by` se nemění.

Automatizace je autorem pouze tehdy, když vytvoří nový task.

### Selhání určení identity

Pokud systém nedokáže určit platnou identitu vytvářejícího aktéra, nesmí přiřadit náhodného uživatele ani administrátora.

Takový případ musí skončit kontrolovaným neúspěchem vytvoření nebo použitím předem definované systémové identity.

### Kopírování obsahu

Převzetí obsahu, šablony nebo properties z jiného tasku nemění pravidlo určení autora.

Autorem je aktér vytvářející nový task, nikoliv autor zdrojového obsahu.

---

## H. Akceptační kritéria

1. Každý nově vytvořený task má právě jednu hodnotu `Created by`.
2. Hodnota vznikne automaticky při vytvoření tasku.
3. U ručně vytvořeného tasku odpovídá hodnota přihlášenému uživateli.
4. U tasku vytvořeného automatizací odpovídá hodnota identitě automatizace.
5. Hodnotu nelze ručně změnit ani vymazat.
6. Pozdější úpravy tasku hodnotu nemění.
7. Duplikovaný task má jako autora uživatele provádějícího duplikaci.
8. Autor původního tasku zůstává po duplikaci beze změny.
9. Po přidání property do schématu se zobrazí skuteční autoři existujících tasků.
10. Skrytí nebo odstranění property nezpůsobí ztrátu evidovaných hodnot.
11. Po opětovném přidání property se zobrazí původní hodnoty.
12. Filtrování podle autora vrací pouze tasky vytvořené vybranou identitou.
13. Deaktivace autora nezmění historickou hodnotu tasku.
14. Úprava tasku automatizací nepřepíše jeho původního autora.
15. Import nebo jiný nepřímý způsob vytvoření použije skutečného aktéra vytvářejícího nový task.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Created by property
  Jako uživatel task systému
  chci vidět původního autora každého tasku
  abych mohl dohledat jeho původ a filtrovat podle něj tasky

  Rule: Autor je automaticky zaznamenán při vytvoření tasku

    Scenario: Přihlášený uživatel vytvoří nový task
      Given uživatel "Jan Novák" je přihlášený
      When vytvoří nový task
      Then task má právě jednu hodnotu "Created by"
      And hodnota "Created by" je "Jan Novák"
      And uživatel nemusel hodnotu ručně vyplnit

    Scenario: Property není při vytvoření tasku zobrazena
      Given uživatel "Jan Novák" vytvořil task
      And property "Created by" nebyla v době vytvoření zobrazena ve schématu
      When je property "Created by" později přidána do schématu
      Then hodnota u existujícího tasku je "Jan Novák"

  Rule: Created by je neměnná systémová hodnota

    Scenario: Uživatel upravuje properties tasku
      Given task vytvořil uživatel "Jan Novák"
      When uživatel otevře úpravu properties tasku
      Then nemůže změnit hodnotu "Created by"
      And hodnota zůstane "Jan Novák"

    Scenario: Uživatel se pokusí odstranit hodnotu autora
      Given task má hodnotu "Created by" nastavenou na "Jan Novák"
      When uživatel upravuje task
      Then nemůže hodnotu "Created by" vymazat
      And task si zachová autora "Jan Novák"

  Rule: Pozdější změny tasku nemění původního autora

    Scenario: Jiný uživatel změní obsah tasku
      Given task vytvořil uživatel "Jan Novák"
      When uživatel "Petra Malá" změní název nebo obsah tasku
      Then hodnota "Created by" zůstane "Jan Novák"

    Scenario: Změní se řešitel tasku
      Given task vytvořil uživatel "Jan Novák"
      And řešitelem tasku je "Petra Malá"
      When je task přiřazen uživateli "Karel Dvořák"
      Then hodnota "Created by" zůstane "Jan Novák"

    Scenario: Automatizace upraví existující task
      Given task vytvořil uživatel "Jan Novák"
      When automatizace změní status tasku
      Then hodnota "Created by" zůstane "Jan Novák"

  Rule: Každý nový task eviduje skutečného aktéra vytvoření

    Scenario: Uživatel duplikuje task jiného autora
      Given původní task vytvořil uživatel "Jan Novák"
      When uživatel "Petra Malá" duplikuje původní task
      Then nový task má hodnotu "Created by" nastavenou na "Petra Malá"
      And původní task má hodnotu "Created by" nastavenou na "Jan Novák"

    Scenario: Automatizace vytvoří nový task
      Given automatizace má identitu "Task Automation"
      When automatizace vytvoří nový task
      Then task má hodnotu "Created by" nastavenou na "Task Automation"

    Scenario: Uživatel provede import nových tasků
      Given import probíhá jménem uživatele "Jan Novák"
      When import vytvoří nový task
      Then hodnota "Created by" je "Jan Novák"

    Scenario: Samostatný importní proces vytvoří nový task
      Given importní proces má identitu "Data Import"
      When importní proces vytvoří nový task
      Then hodnota "Created by" je "Data Import"

  Rule: Změna dostupnosti property nezpůsobí ztrátu autora

    Scenario: Property je skryta a později znovu zobrazena
      Given task vytvořil uživatel "Jan Novák"
      And property "Created by" byla skryta
      When uživatel property znovu zobrazí
      Then hodnota "Created by" je stále "Jan Novák"

    Scenario: Property je odstraněna a později znovu přidána
      Given task vytvořil uživatel "Jan Novák"
      And property "Created by" byla odstraněna ze schématu
      When je property "Created by" znovu přidána
      Then hodnota u existujícího tasku je "Jan Novák"

  Rule: Tasky lze filtrovat podle původního autora

    Scenario: Filtrování tasků podle uživatele
      Given existují tasky vytvořené uživateli "Jan Novák" a "Petra Malá"
      When uživatel nastaví filtr "Created by je Jan Novák"
      Then systém zobrazí pouze tasky vytvořené uživatelem "Jan Novák"

    Scenario: Filtrování tasků vytvořených automatizací
      Given existují ručně vytvořené tasky
      And existují tasky vytvořené identitou "Task Automation"
      When uživatel nastaví filtr "Created by je Task Automation"
      Then systém zobrazí pouze tasky vytvořené identitou "Task Automation"

  Rule: Historická identita autora je zachována

    Scenario: Původní autor je deaktivován
      Given task vytvořil uživatel "Jan Novák"
      When je účet uživatele "Jan Novák" deaktivován
      Then task si zachová historickou identitu "Jan Novák"
      And autor není nahrazen jiným uživatelem

  Rule: Systém nesmí přiřadit nesprávného autora

    Scenario: Při vytvoření tasku nelze určit identitu aktéra
      Given systém nedokáže určit platnou identitu vytvářejícího aktéra
      When se pokusí vytvořit nový task
      Then systém nepřiřadí jako autora náhodného uživatele
      And systém nepřiřadí jako autora administrátora workspace
      And vytvoření skončí kontrolovaným neúspěchem nebo použije předem definovanou systémovou identitu
```

---

## J. Explicitní hypotézy

Následující hypotézy jsou neblokující a nemění základní business význam property:

### H1: Zobrazení deaktivovaného autora

Deaktivovaný uživatel zůstane zobrazen pod původním jménem a může být označen jako neaktivní.

### H2: Přejmenování property

Property lze přejmenovat stejně jako ostatní properties, ale její systémový typ a chování nelze změnit.

### H3: Neznámý systémový aktér

Pro případy, kdy nelze určit konkrétního aktéra, bude existovat jedna předem definovaná systémová identita. Nesmí být použit náhodný uživatel ani administrátor.

### H4: Odstranění ze schématu

Odstranění `Created by` ze schématu odstraní pouze její dostupnost nebo zobrazení, nikoliv interně evidovanou historickou informaci o autorovi.

Coaching note: Původní brief pojmenoval property, ale neurčoval, zda jde o editovatelnou osobu, auditní údaj nebo řešitele tasku. Potvrzení evidence od vzniku tasku a skutečného aktéra vytvoření z něj udělalo jednoznačné a testovatelné zadání.
