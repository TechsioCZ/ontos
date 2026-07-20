# Date Range property — finální business specifikace

## A. Executive summary

`Date Range` je samostatný typ property pro evidenci období u tasku.

Property je definována ve sdíleném schématu a je dostupná u všech tasků, které toto schéma používají. Hodnota konkrétního tasku může být:

- `Empty`,
- nebo úplný platný rozsah obsahující `Start` a `End`.

`Start` musí být vždy před `End`. Obě data jsou povinná a nesmějí být stejná.

Podpora času je volitelná konfigurace společná pro celé schéma. Pokud je zapnutá, jednotlivé hodnoty mohou mít oba časy `Empty`, nebo musí mít vyplněný `Start time` i `End time`.

Duplikace property vždy kopíruje konfiguraci i hodnoty všech existujících tasků. Po duplikaci jsou obě properties nezávislé.

**Readiness score: GOLD**

---

## B. Business cíl

Umožnit uživatelům evidovat u tasků jednoznačné období se začátkem a koncem.

Samostatná property `Date Range` odděluje rozsah od jednoduché property `Date` a odstraňuje potřebu přepínat mezi jedním datem a rozsahem uvnitř jedné property.

---

## C. Aktéři

### Uživatel upravující schéma

Může:

- vytvořit property,
- změnit její konfiguraci,
- duplikovat ji,
- odstranit ji ze schématu.

### Uživatel upravující task

Může:

- zadat hodnotu rozsahu,
- změnit existující hodnotu,
- vymazat hodnotu.

Oprávnění a přístupová pravidla nejsou součástí této specifikace.

---

## D. Scope

- vytvoření `Date Range` property ve sdíleném schématu,
- propagace property do všech tasků používajících schéma,
- stav `Empty`,
- zadání `Start` a `End`,
- validace pořadí a úplnosti rozsahu,
- volitelná podpora času,
- úprava a vymazání hodnoty,
- odstranění property ze schématu,
- zobrazení počtu hodnot `Is not empty` před odstraněním,
- duplikace property včetně konfigurace a hodnot,
- nezávislost properties po duplikaci.

---

## E. Mimo scope

- samostatná property `Date`,
- rozsah v rámci jednoho kalendářního dne,
- filtrování a řazení,
- kalendářový nebo timeline pohled,
- výpočet délky rozsahu,
- reminders a notifikace navázané na datum,
- opakované rozsahy,
- oprávnění,
- technická architektura,
- API a datová reprezentace,
- verzování schématu.

---

## F. Business pravidla

### F1. Sdílené schéma

1. `Date Range` property je součástí sdíleného schématu tasků.
2. Po vytvoření je property dostupná u všech tasků používajících dané schéma.
3. U všech existujících tasků vznikne nová property ve stavu `Empty`.
4. Nové tasky vytvořené podle schématu obsahují property také ve stavu `Empty`.
5. Konfigurace property je společná pro všechny tasky používající schéma.
6. Hodnota property je samostatná pro každý task.

### F2. Stavy hodnoty

Hodnota property může být pouze:

- `Empty`,
- `Complete Date Range without time`,
- `Complete Date Range with time`, pokud schéma podporuje čas.

Částečně uložená hodnota není platným stavem.

### F3. Povinná data

1. Vyplněná hodnota musí obsahovat `Start date` i `End date`.
2. `Start date` musí být před `End date`.
3. `Start date` a `End date` nesmějí být stejné.
4. Stejné datum není povoleno ani tehdy, pokud jsou časy rozdílné.
5. `Start date` nesmí být po `End date`.
6. Systém neplatná data automaticky neprohodí ani neposune.

### F4. Error notifikace

Při pokusu uložit neplatnou hodnotu:

- systém hodnotu neuloží,
- zachová editovaný stav pro opravu,
- zobrazí error notifikaci vysvětlující důvod.

Minimálně jsou rozlišeny tyto případy:

- chybí `Start`,
- chybí `End`,
- `Start` a `End` mají stejné datum,
- `Start` je po `End`,
- je vyplněn pouze jeden čas.

Pro obrácené pořadí notifikace vysvětlí:

> Start nemůže být po End.

### F5. Podpora času

1. Podpora času je volitelná konfigurace property.
2. Konfigurace času platí pro celé sdílené schéma.
3. Pokud je čas vypnutý, uživatel zadává pouze `Start date` a `End date`.
4. Pokud je čas zapnutý, uživatel může k hodnotě zadat také `Start time` a `End time`.
5. Zapnutí času neznamená, že čas musí být vyplněn u každého tasku.
6. U jedné hodnoty jsou povoleny pouze dvě varianty:
   - oba časy jsou `Empty`,
   - oba časy jsou vyplněné.
7. Hodnota obsahující pouze `Start time` nebo pouze `End time` není platná.
8. Rozdílné časy nepovolují rozsah se stejným `Start date` a `End date`.
9. Zapnutí času nemění data existujících hodnot.
10. Existující hodnoty mají po zapnutí času oba časy `Empty`.

### F6. Vymazání hodnoty

1. Vymazání hodnoty se týká celého rozsahu.
2. Po vymazání jsou `Start date`, `End date`, `Start time` a `End time` prázdné.
3. Property přejde do stavu `Empty`.
4. Vymazání hodnoty jednoho tasku neovlivní hodnoty ostatních tasků.

### F7. Odstranění property

1. Odstranění property z jednoho tasku znamená odstranění property ze sdíleného schématu.
2. Property je odstraněna ze všech tasků používajících dané schéma.
3. Před odstraněním se vždy zobrazí potvrzovací dialog.
4. Dialog vysvětlí dopad na celé schéma.
5. Dialog zobrazí počet tasků, u kterých je property `Is not empty`.
6. Pokud žádný task nemá hodnotu, dialog zobrazí počet `0`.
7. Do počtu se nezahrnují tasky s hodnotou `Empty`.
8. Po potvrzení jsou odstraněny:
   - definice property,
   - všechny její hodnoty ve všech tascích.
9. Po zrušení dialogu se nic nezmění.

### F8. Duplikace property

1. Duplikací vznikne nová samostatná property ve stejném schématu.
2. Duplikace vždy kopíruje hodnoty.
3. Uživatel nevybírá mezi duplikací s hodnotami a bez hodnot.
4. Duplikát převezme celou aktuální konfiguraci původní property.
5. Duplikát převezme hodnotu původní property u každého existujícího tasku.
6. Pokud je původní hodnota `Empty`, je `Empty` také duplikát.
7. Pokud původní hodnota obsahuje data, duplikát obsahuje stejná data.
8. Pokud původní hodnota obsahuje časy, duplikát obsahuje také stejné časy.
9. Po dokončení duplikace jsou původní property a duplikát nezávislé.
10. Pozdější změny konfigurace ani hodnot se mezi properties nepropagují.

---

## G. Klíčové výjimky a hraniční situace

### Prázdná property

Property může zůstat `Empty`. Povinnost zadat `Start` a `End` vzniká až při ukládání neprázdné hodnoty.

### Pouze jeden konec rozsahu

Hodnota obsahující pouze `Start` nebo pouze `End` není platná a nelze ji uložit.

### Stejné datum

Rozsah od jednoho data do stejného data není podporován.

To platí také například pro:

- `12. 7. 2026 09:00`,
- `12. 7. 2026 17:00`.

Přestože jsou časy rozdílné, data jsou stejná, a hodnota je proto neplatná.

### Obrácený rozsah

Pokud je `Start` po `End`, systém:

- hodnotu neuloží,
- data neprohodí,
- neposune automaticky žádný konec,
- zobrazí error notifikaci.

### Částečně vyplněné časy

Pokud je podpora času zapnutá, hodnota nemůže obsahovat pouze jeden čas.

Povolené:

- oba časy `Empty`,
- oba časy vyplněné.

Zakázané:

- vyplněný pouze `Start time`,
- vyplněný pouze `End time`.

### Duplikace prázdných hodnot

Hodnota `Empty` se nekonvertuje na nový výchozí rozsah. V duplikátu zůstane `Empty`.

### Odstranění property bez hodnot

Potvrzovací dialog se zobrazí vždy, i když je property u všech tasků `Empty`.

---

## H. Akceptační kritéria

1. Vytvořená `Date Range` property se zobrazí u všech tasků používajících schéma.
2. U existujících tasků je nová property `Empty`.
3. Task lze uložit s property ve stavu `Empty`.
4. Neprázdnou hodnotu lze uložit pouze s vyplněným `Start` i `End`.
5. `Start` musí být před `End`.
6. Stejné datum pro `Start` a `End` nelze uložit.
7. Obrácený rozsah nelze uložit a systém zobrazí error notifikaci.
8. Neplatná data systém automaticky neupravuje.
9. Zapnutí podpory času ovlivní celé schéma.
10. Při zapnuté podpoře času mohou být u hodnoty oba časy `Empty`.
11. Při zadání času musí být vyplněny oba časy.
12. Rozsah se stejnými daty nelze uložit ani s různými časy.
13. Vymazání hodnoty nastaví property na `Empty`.
14. Odstranění property vždy vyžaduje potvrzení.
15. Potvrzovací dialog zobrazuje počet tasků s hodnotou `Is not empty`.
16. Potvrzení odstraní property a všechny její hodnoty z celého schématu.
17. Duplikace vždy kopíruje konfiguraci i hodnoty.
18. Po duplikaci jsou obě properties nezávislé.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Date Range property ve sdíleném schématu tasků
  Uživatel potřebuje evidovat časové období,
  které má povinný začátek a konec na rozdílných datech.

  Rule: Date Range property je součástí sdíleného schématu

    Scenario: Přidání property do existujícího schématu
      Given sdílené schéma používá 100 existujících tasků
      When uživatel přidá property typu "Date Range"
      Then property je dostupná u všech 100 tasků
      And u každého existujícího tasku je její hodnota "Empty"

    Scenario: Vytvoření nového tasku podle schématu
      Given schéma obsahuje property "Plánované období" typu "Date Range"
      When uživatel vytvoří nový task používající schéma
      Then task obsahuje property "Plánované období"
      And její hodnota je "Empty"

  Rule: Date Range může být Empty nebo obsahovat úplný rozsah

    Scenario: Uložení tasku s prázdnou hodnotou
      Given task obsahuje Date Range property
      And její hodnota je "Empty"
      When uživatel uloží task
      Then task se úspěšně uloží
      And hodnota property zůstane "Empty"

    Scenario: Uložení platného rozsahu
      Given task obsahuje Date Range property
      When uživatel nastaví Start date na "2026-07-12"
      And nastaví End date na "2026-07-15"
      And potvrdí změnu
      Then property obsahuje rozsah od "2026-07-12" do "2026-07-15"
      And property je "Is not empty"

    Scenario: Pokus uložit pouze Start
      Given task obsahuje Date Range property
      When uživatel nastaví Start date na "2026-07-12"
      But ponechá End date "Empty"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And zobrazí error notifikaci vysvětlující, že End je povinný

    Scenario: Pokus uložit pouze End
      Given task obsahuje Date Range property
      When uživatel ponechá Start date "Empty"
      And nastaví End date na "2026-07-15"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And zobrazí error notifikaci vysvětlující, že Start je povinný

  Rule: Start musí být před End a data musí být rozdílná

    Scenario: Start je před End
      Given uživatel zadává hodnotu Date Range
      When nastaví Start date na "2026-07-12"
      And nastaví End date na "2026-07-15"
      Then rozsah je platný

    Scenario: Start a End jsou stejné datum
      Given uživatel zadává hodnotu Date Range
      When nastaví Start date na "2026-07-12"
      And nastaví End date na "2026-07-12"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And zobrazí error notifikaci
      And notifikace vysvětlí, že Start a End nemohou být stejné datum

    Scenario: Start je po End
      Given uživatel zadává hodnotu Date Range
      When nastaví Start date na "2026-07-15"
      And nastaví End date na "2026-07-12"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And systém data automaticky neprohodí
      And systém automaticky neposune žádný konec
      And zobrazí error notifikaci
      And notifikace vysvětlí, že Start nemůže být po End

  Rule: Podpora času je konfigurována pro celé schéma

    Scenario: Property bez podpory času
      Given je podpora času vypnutá
      When uživatel upravuje Date Range hodnotu
      Then může zadat Start date a End date
      But nemůže zadat Start time ani End time

    Scenario: Zapnutí podpory času
      Given Date Range property nepodporuje čas
      And existující task obsahuje rozsah od "2026-07-12" do "2026-07-15"
      When uživatel zapne podporu času
      Then podpora času je dostupná u všech tasků používajících schéma
      And existující Start date zůstane "2026-07-12"
      And existující End date zůstane "2026-07-15"
      And Start time je "Empty"
      And End time je "Empty"

    Scenario: Uložení rozsahu bez časů při zapnuté podpoře času
      Given je podpora času zapnutá
      When uživatel nastaví Start date na "2026-07-12"
      And nastaví End date na "2026-07-15"
      And ponechá Start time "Empty"
      And ponechá End time "Empty"
      And potvrdí změnu
      Then systém uloží platný rozsah bez časů

    Scenario: Uložení rozsahu s oběma časy
      Given je podpora času zapnutá
      When uživatel nastaví Start na "2026-07-12 09:00"
      And nastaví End na "2026-07-15 17:00"
      And potvrdí změnu
      Then systém uloží rozsah včetně obou časů

    Scenario: Pokus uložit pouze Start time
      Given je podpora času zapnutá
      When uživatel nastaví Start date na "2026-07-12"
      And nastaví End date na "2026-07-15"
      And nastaví Start time na "09:00"
      But ponechá End time "Empty"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And zobrazí error notifikaci vysvětlující, že oba časy musí být vyplněné společně

    Scenario: Pokus uložit pouze End time
      Given je podpora času zapnutá
      When uživatel nastaví Start date na "2026-07-12"
      And nastaví End date na "2026-07-15"
      And ponechá Start time "Empty"
      But nastaví End time na "17:00"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And zobrazí error notifikaci vysvětlující, že oba časy musí být vyplněné společně

    Scenario: Rozdílné časy na stejném datu
      Given je podpora času zapnutá
      When uživatel nastaví Start na "2026-07-12 09:00"
      And nastaví End na "2026-07-12 17:00"
      And pokusí se hodnotu uložit
      Then systém hodnotu neuloží
      And zobrazí error notifikaci
      And notifikace vysvětlí, že Start a End nemohou být stejné datum

  Rule: Vymazání hodnoty odstraní celý rozsah

    Scenario: Vymazání rozsahu bez časů
      Given property obsahuje rozsah od "2026-07-12" do "2026-07-15"
      When uživatel hodnotu vymaže
      Then Start date je "Empty"
      And End date je "Empty"
      And property je "Empty"

    Scenario: Vymazání rozsahu s časy
      Given property obsahuje rozsah od "2026-07-12 09:00" do "2026-07-15 17:00"
      When uživatel hodnotu vymaže
      Then Start date je "Empty"
      And End date je "Empty"
      And Start time je "Empty"
      And End time je "Empty"
      And property je "Empty"

  Rule: Odstranění property ovlivní celé sdílené schéma

    Scenario: Zobrazení počtu neprázdných hodnot
      Given property je součástí sdíleného schématu
      And schéma používá 100 tasků
      And u 24 tasků je property "Is not empty"
      When uživatel zvolí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog vysvětlí, že property bude odstraněna ze všech tasků
      And dialog zobrazí počet "24" tasků s neprázdnou hodnotou

    Scenario: Odstranění property bez neprázdných hodnot
      Given property je u všech tasků "Empty"
      When uživatel zvolí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog zobrazí počet "0" tasků s neprázdnou hodnotou

    Scenario: Potvrzení odstranění property
      Given systém zobrazuje potvrzovací dialog
      When uživatel odstranění potvrdí
      Then property je odstraněna ze sdíleného schématu
      And property je odstraněna ze všech tasků používajících schéma
      And všechny její hodnoty jsou odstraněny

    Scenario: Zrušení odstranění property
      Given systém zobrazuje potvrzovací dialog
      When uživatel odstranění zruší
      Then property zůstane součástí schématu
      And žádná hodnota property se nezmění

  Rule: Duplikace vždy kopíruje konfiguraci i hodnoty

    Scenario: Duplikace Date Range property
      Given schéma obsahuje Date Range property
      When uživatel property duplikuje
      Then ve schématu vznikne nová samostatná Date Range property
      And duplikát převezme konfiguraci původní property
      And duplikát převezme hodnoty ze všech existujících tasků
      And systém nenabídne možnost duplikace bez hodnot

    Scenario: Kopírování vyplněných a prázdných hodnot
      Given první task obsahuje rozsah od "2026-07-12" do "2026-07-15"
      And druhý task má původní property "Empty"
      When uživatel property duplikuje
      Then duplikát na prvním tasku obsahuje rozsah od "2026-07-12" do "2026-07-15"
      And duplikát na druhém tasku je "Empty"

    Scenario: Kopírování hodnot s časy
      Given původní property podporuje čas
      And task obsahuje rozsah od "2026-07-12 09:00" do "2026-07-15 17:00"
      When uživatel property duplikuje
      Then duplikát podporuje čas
      And duplikát obsahuje stejná data i časy

    Scenario: Nezávislost hodnot po duplikaci
      Given Date Range property má vytvořený duplikát
      When uživatel změní hodnotu původní property
      Then hodnota duplikátu se nezmění

    Scenario: Nezávislost konfigurace po duplikaci
      Given Date Range property má vytvořený duplikát
      When uživatel změní konfiguraci původní property
      Then konfigurace duplikátu se nezmění

    Scenario: Změna duplikátu neovlivní původní property
      Given Date Range property má vytvořený duplikát
      When uživatel změní konfiguraci nebo hodnotu duplikátu
      Then konfigurace ani hodnoty původní property se nezmění
```

---

## J. Explicitní hypotézy

### H1. Vypnutí podpory času

Chování při vypnutí podpory času u property, která již obsahuje vyplněné časové hodnoty, nebylo potvrzeno.

Pracovní hypotéza:

- systém před vypnutím zobrazí potvrzení s počtem dotčených tasků,
- po potvrzení odstraní `Start time` a `End time`,
- `Start date` a `End date` zůstanou zachovány.

### H2. Výchozí název duplikátu

Způsob automatického pojmenování duplikátu nebyl specifikován.

Pracovní hypotéza:

- systém vytvoří unikátní název odvozený od původní property,
- například `Plánované období copy`.

Přesná konvence názvu nemění business chování hodnoty Date Range.
