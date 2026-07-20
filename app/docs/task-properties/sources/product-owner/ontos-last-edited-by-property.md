# Last edited by — finální business specifikace

## Readiness score: GOLD

- Je přesně určeno, které změny aktualizují posledního editora.
- Je definováno chování uživatelských i automatických změn.
- Hodnota je systémová, jednoznačná a testovatelná.
- Scope, výjimky i akceptační kritéria jsou připravené pro coding agents.

# A. Executive summary

Property `Last edited by` zobrazuje aktéra, který provedl poslední úspěšně uloženou změnu tasku.

Za editaci se považuje změna:

- `Title`,
- hodnoty libovolné property,
- obsahu kanvasu.

Za editaci se nepovažuje:

- pouhé otevření nebo zobrazení tasku,
- rozepsaná, zrušená nebo neúspěšně uložená změna,
- přidání, úprava nebo odstranění komentáře,
- změna osobního zobrazení uživatele.

Hodnota je spravována systémem a uživatel ji nemůže ručně změnit.

Pokud změnu provede automatizace, zobrazí se uživatel, který automatickou změnu inicioval. Není-li konkrétní iniciátor známý, zobrazí se aktér `System`.

# B. Business cíl

Umožnit uživateli rychle zjistit, kdo provedl poslední relevantní změnu tasku, bez nutnosti otevírat historii změn.

Property neposkytuje auditní historii. Zobrazuje pouze jednoho aktuálního posledního editora.

# C. Aktéři

## Uživatel

Osoba, která vytváří, upravuje nebo prohlíží task.

## Iniciátor automatizace

Uživatel, jehož akce způsobila automatickou změnu tasku.

## System

Systémový aktér používaný pro automatické změny, u kterých nelze určit konkrétního uživatelského iniciátora.

# D. Scope

- Property typu `Last edited by`.
- Automatické určení posledního editora tasku.
- Aktualizace při změně `Title`.
- Aktualizace při změně hodnoty jiné property.
- Aktualizace při změně obsahu kanvasu.
- Zpracování změn provedených automatizací.
- Počáteční hodnota při vytvoření tasku.
- Zobrazení hodnoty u existujícího tasku.
- Chování při odstranění a opětovném přidání property.
- Zachování identity deaktivovaného nebo odstraněného uživatele.

# E. Mimo scope

- Historie všech editorů.
- Datum nebo čas poslední změny.
- Porovnání verzí tasku.
- Auditní log.
- Komentáře a jejich autoři.
- Notifikace editorům.
- Technický způsob ukládání identity.
- Oprávnění k úpravě samotného tasku.
- Filtry, řazení a seskupování podle property.
- Detailní návrh zobrazení property v UI.

# F. Business pravidla

## BR-01 — Systémová hodnota

`Last edited by` je systémově spravovaná property.

Uživatel nemůže její hodnotu:

- ručně zadat,
- změnit,
- vymazat,
- nahradit jiným uživatelem.

## BR-02 — Jedna hodnota

Property obsahuje právě jednoho posledního editora.

Nová relevantní změna nahradí předchozí hodnotu.

## BR-03 — Vytvoření tasku

Po úspěšném vytvoření tasku je jeho tvůrce uložen jako `Last edited by`.

## BR-04 — Relevantní editace

Hodnota se aktualizuje po úspěšném uložení alespoň jedné z následujících změn:

- změna `Title`,
- změna hodnoty libovolné property,
- změna obsahu kanvasu.

## BR-05 — Akce bez aktualizace hodnoty

Hodnota se neaktualizuje při:

- otevření tasku,
- prohlížení tasku,
- opuštění tasku bez uložené změny,
- zrušení rozepsané změny,
- neúspěšném uložení,
- přidání, úpravě nebo odstranění komentáře,
- změně osobního zobrazení, která nemění samotný task.

## BR-06 — Čas rozhodnutí

Hodnota se změní až ve chvíli, kdy je relevantní změna úspěšně uložena.

Samotné zahájení editace hodnotu nemění.

## BR-07 — Více změn

Pokud task postupně změní více aktérů, property obsahuje aktéra poslední úspěšně uložené relevantní změny.

Pořadí se určuje podle pořadí úspěšného uložení, nikoliv podle okamžiku zahájení editace.

## BR-08 — Automatizace s iniciátorem

Pokud automatickou změnu vyvolal identifikovatelný uživatel, `Last edited by` se nastaví na tohoto uživatele.

Příklad: uživatel změní status a tím spustí pravidlo, které automaticky doplní další property.

## BR-09 — Automatizace bez iniciátora

Pokud automatická změna nemá identifikovatelného uživatelského iniciátora, `Last edited by` se nastaví na `System`.

## BR-10 — Existence údaje

Údaj o posledním editorovi je součástí systémových údajů tasku nezávisle na tom, zda je property `Last edited by` aktuálně zobrazena.

Přidání property pouze zpřístupní existující hodnotu.

## BR-11 — Odstranění property

Odstranění property nesmaže systémový údaj o posledním editorovi tasku.

Pokud je property později znovu přidána, zobrazí aktuálního posledního editora.

## BR-12 — Deaktivovaný uživatel

Pokud je poslední editor později deaktivován, odstraněn z workspace nebo ztratí přístup k tasku, jeho historická identita zůstane v property zachována.

## BR-13 — Přejmenování property

Uživatel může změnit zobrazovaný název property.

Přejmenování nemění její typ ani business chování.

Přejmenování samotné property je změnou schématu, nikoliv změnou konkrétního tasku, a neaktualizuje `Last edited by` jednotlivých tasků.

# G. Klíčové výjimky a hraniční situace

## Souběžná editace

Pokud dva uživatelé upravují task současně, posledním editorem je aktér změny, která byla úspěšně uložena jako poslední.

## Neúspěšné uložení

Pokud změnu nelze uložit, hodnota se nezmění.

## Změna vracející původní hodnotu

Pokud uživatel uloží změnu a následně uloží další změnu, která vrátí původní business hodnotu, stále se jedná o novou editaci. `Last edited by` se aktualizuje na autora posledního uložení.

## Více změn v jednom uložení

Pokud jedno uložení obsahuje více relevantních změn, například změnu `Title` a hodnoty property, `Last edited by` se aktualizuje pouze jednou na aktéra daného uložení.

## Řetězec automatizací

Pokud uživatelská změna spustí jednu nebo více navazujících automatizací a systém stále zná původního iniciátora, zůstává posledním editorem tento uživatel.

Pokud samostatná pozdější automatizace proběhne bez identifikovatelného iniciátora, posledním editorem se stane `System`.

# H. Akceptační kritéria

1. Nově vytvořený task obsahuje jako posledního editora svého tvůrce.
2. Úspěšná změna `Title` aktualizuje posledního editora.
3. Úspěšná změna hodnoty jiné property aktualizuje posledního editora.
4. Úspěšná změna obsahu kanvasu aktualizuje posledního editora.
5. Pouhé zobrazení tasku posledního editora nemění.
6. Komentář posledního editora tasku nemění.
7. Neuložená, zrušená nebo neúspěšná změna posledního editora nemění.
8. Hodnotu nelze ručně přepsat ani vymazat.
9. Při více editacích se zobrazuje aktér posledního úspěšného uložení.
10. Automatická změna s identifikovatelným iniciátorem zobrazuje iniciátora.
11. Automatická změna bez identifikovatelného iniciátora zobrazuje `System`.
12. Přidání property k existujícímu tasku zobrazí již evidovaného posledního editora.
13. Odstranění a opětovné přidání property nezpůsobí ztrátu hodnoty.
14. Deaktivace uživatele neodstraní jeho identitu z historické hodnoty.
15. Přejmenování property nemění její typ ani hodnoty tasků.

# I. BDD scénáře v Gherkinu

Feature: Evidence posledního editora tasku

Jako uživatel task systému

chci vidět aktéra poslední relevantní změny tasku

abych mohl rychle zjistit, kdo task naposledy upravil

Rule: Property Last edited by je spravována systémem

```
Scenario: Tvůrce je prvním posledním editorem
  Given uživatel "Jana Nováková" vytváří nový task
  When je task úspěšně vytvořen
  Then hodnota "Last edited by" je "Jana Nováková"

Scenario: Hodnotu nelze ručně změnit
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel zobrazí property "Last edited by"
  Then nemůže ručně vybrat jiného editora
  And nemůže hodnotu vymazat
```

Rule: Změna Title aktualizuje posledního editora

```
Scenario: Uživatel změní Title
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" úspěšně uloží změnu Title
  Then hodnota "Last edited by" je "Petr Svoboda"
```

Rule: Změna property aktualizuje posledního editora

```
Scenario: Uživatel změní hodnotu property
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" úspěšně uloží změnu jiné property
  Then hodnota "Last edited by" je "Petr Svoboda"
```

Rule: Změna kanvasu aktualizuje posledního editora

```
Scenario: Uživatel změní obsah kanvasu
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" úspěšně uloží změnu obsahu kanvasu
  Then hodnota "Last edited by" je "Petr Svoboda"
```

Rule: Hodnotu mění pouze úspěšně uložená relevantní změna

```
Scenario: Uživatel změnu zruší
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" začne upravovat task
  But změnu zruší bez uložení
  Then hodnota "Last edited by" zůstává "Jana Nováková"

Scenario: Uložení změny selže
  Given hodnota "Last edited by" je "Jana Nováková"
  When se uživatel "Petr Svoboda" pokusí uložit relevantní změnu
  But změna není úspěšně uložena
  Then hodnota "Last edited by" zůstává "Jana Nováková"

Scenario: Uživatel pouze zobrazí task
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" otevře task
  And neuloží žádnou relevantní změnu
  Then hodnota "Last edited by" zůstává "Jana Nováková"
```

Rule: Komentáře nejsou editací tasku

```
Scenario: Uživatel přidá komentář
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" přidá komentář k tasku
  Then hodnota "Last edited by" zůstává "Jana Nováková"

Scenario: Uživatel upraví existující komentář
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" upraví svůj komentář
  Then hodnota "Last edited by" zůstává "Jana Nováková"

Scenario: Uživatel odstraní komentář
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" odstraní komentář
  Then hodnota "Last edited by" zůstává "Jana Nováková"
```

Rule: Rozhoduje poslední úspěšně uložená změna

```
Scenario: Task postupně upraví více uživatelů
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" úspěšně uloží změnu tasku
  And následně uživatel "Eva Malá" úspěšně uloží další změnu tasku
  Then hodnota "Last edited by" je "Eva Malá"

Scenario: Souběžně zahájené změny se uloží v opačném pořadí
  Given uživatelé "Petr Svoboda" a "Eva Malá" současně upravují task
  When uživatel "Eva Malá" uloží změnu jako první
  And uživatel "Petr Svoboda" uloží změnu jako poslední
  Then hodnota "Last edited by" je "Petr Svoboda"

Scenario: Jedno uložení obsahuje více změn
  Given hodnota "Last edited by" je "Jana Nováková"
  When uživatel "Petr Svoboda" v jednom uložení změní Title a jinou property
  Then hodnota "Last edited by" je "Petr Svoboda"
```

Rule: Automatická změna přebírá známého iniciátora

```
Scenario: Automatickou změnu vyvolal konkrétní uživatel
  Given uživatel "Petr Svoboda" provede akci, která spustí automatizaci
  When automatizace úspěšně změní task
  Then hodnota "Last edited by" je "Petr Svoboda"

Scenario: Uživatelská akce spustí řetězec automatizací
  Given uživatel "Petr Svoboda" provede akci, která spustí více navazujících automatizací
  And systém u všech změn zná původního iniciátora
  When automatizace úspěšně změní task
  Then hodnota "Last edited by" je "Petr Svoboda"
```

Rule: Automatická změna bez známého iniciátora používá System

```
Scenario: Plánovaná automatizace změní task
  Given automatizace nemá identifikovatelného uživatelského iniciátora
  When automatizace úspěšně změní task
  Then hodnota "Last edited by" je "System"

Scenario: Systémová změna následuje po starší uživatelské změně
  Given hodnota "Last edited by" je "Petr Svoboda"
  And pozdější automatizace nemá identifikovatelného uživatelského iniciátora
  When automatizace úspěšně změní task
  Then hodnota "Last edited by" je "System"
```

Rule: Údaj existuje nezávisle na zobrazení property

```
Scenario: Property je přidána k existujícímu tasku
  Given posledním editorem tasku je "Jana Nováková"
  And task aktuálně nezobrazuje property "Last edited by"
  When je property "Last edited by" přidána
  Then property zobrazuje "Jana Nováková"

Scenario: Property je odstraněna a znovu přidána
  Given posledním editorem tasku je "Jana Nováková"
  And property "Last edited by" je odstraněna
  When je property znovu přidána bez další změny tasku
  Then property zobrazuje "Jana Nováková"
```

Rule: Historická identita posledního editora zůstává zachována

```
Scenario: Poslední editor je deaktivován
  Given hodnota "Last edited by" je "Jana Nováková"
  When je uživatel "Jana Nováková" deaktivován
  Then property stále identifikuje "Janu Novákovou" jako posledního editora
```

Rule: Konfigurace property nemění hodnoty tasků

```
Scenario: Property je přejmenována
  Given hodnota "Last edited by" tasku je "Jana Nováková"
  When uživatel přejmenuje property na "Naposledy upravil"
  Then typ property zůstává "Last edited by"
  And hodnota tasku zůstává "Jana Nováková"
  And přejmenování neaktualizuje posledního editora tasku
```

# J. Explicitní hypotézy

Žádné otevřené business hypotézy, které by blokovaly implementaci.

Následující rozhodnutí jsou považována za potvrzenou součást specifikace:

- komentáře neaktualizují `Last edited by`,
- automatizace používá původního uživatelského iniciátora, pokud je známý,
- automatizace bez známého iniciátora používá `System`,
- údaj existuje nezávisle na viditelnosti property,
- deaktivace uživatele nesmaže jeho historickou identitu.

Původně neurčitý pojem „poslední editace“ je nyní vymezen konkrétními změnami a okamžikem úspěšného uložení. Tím se odstranily nejasnosti kolem komentářů, souběžných změn a automatizací.
