# Email property — finální business specifikace

## Readiness score: GOLD

- Property je definována ve sdíleném schématu tasků.
- Je určena kardinalita hodnoty i povolený prázdný stav.
- Je potvrzeno chování při platném i neplatném vstupu.
- Hlavní operace, výjimky a akceptační scénáře jsou testovatelné.

# A. Executive summary

Property typu `Email` umožňuje evidovat u tasku jednu nepovinnou e-mailovou adresu.

Property je součástí sdíleného schématu tasků. Po jejím vytvoření je dostupná u všech tasků používajících dané schéma. Existující tasky získají property s hodnotou `Empty`.

Uživatel může adresu zadat, změnit, odstranit, vyhledávat podle ní, filtrovat tasky a zahájit vytvoření nové zprávy ve výchozí e-mailové aplikaci.

Syntakticky neplatnou adresu systém neuloží.

# B. Business cíl

Umožnit uživatelům evidovat u tasků konzistentní kontaktní e-mailovou adresu a rychle ji použít pro zahájení komunikace.

Strukturovaná Email property musí současně umožnit spolehlivé vyhledávání, filtrování a řazení tasků.

# C. Aktéři

## Hlavní aktér

Uživatel oprávněný upravovat tasky a jejich properties.

## Vedlejší aktér

Uživatel, který má přístup k tasku pouze pro čtení a může uloženou adresu zobrazit nebo aktivovat, ale nemůže ji měnit.

# D. Scope

- vytvoření property typu `Email`,
- pojmenování property,
- přidání property do sdíleného schématu,
- zobrazení property u všech tasků daného schématu,
- zadání jedné e-mailové adresy,
- validace formátu adresy,
- změna uložené adresy,
- odstranění hodnoty,
- zobrazení stavu `Empty`,
- aktivace adresy pro vytvoření nové e-mailové zprávy,
- vyhledávání podle adresy,
- filtrování podle hodnoty property,
- abecední řazení podle adresy,
- duplikace property,
- odstranění property ze schématu.

# E. Mimo scope

- odesílání e-mailů přímo z task systému,
- ukládání předmětu nebo obsahu zprávy,
- e-mailové šablony,
- historie e-mailové komunikace,
- synchronizace e-mailové schránky,
- ověřování, zda schránka skutečně existuje,
- ověřování doručitelnosti adresy,
- seznam více adres v jedné hodnotě,
- automatické notifikace nebo pozvánky,
- správa kontaktů,
- pokročilé ověřování všech nestandardních RFC variant e-mailových adres.

# F. Business pravidla

## F1. Sdílené schéma

1. Email property je součástí sdíleného schématu tasků.
2. Po vytvoření je property dostupná u všech tasků používajících dané schéma.
3. Existující tasky získají novou property ve stavu `Empty`.
4. Nově vytvořené tasky používající stejné schéma obsahují tuto property také ve stavu `Empty`.
5. Změna názvu property se projeví u všech tasků daného schématu.
6. Hodnota property je uložena samostatně pro každý task.

## F2. Kardinalita a prázdná hodnota

1. Jedna Email property může obsahovat nejvýše jednu e-mailovou adresu.
2. Property je nepovinná.
3. `Empty` je platný stav.
4. Uživatel může existující hodnotu kdykoliv odstranit.
5. Více adres oddělených čárkou, středníkem, mezerou nebo jiným oddělovačem není podporováno.

## F3. Validace adresy

1. Systém před validací odstraní mezery před a za celou hodnotou.
2. Hodnota nesmí obsahovat mezery uvnitř adresy.
3. Hodnota musí obsahovat právě jeden znak `@`.
4. Před znakem `@` musí být neprázdná lokální část.
5. Za znakem `@` musí být neprázdná doménová část.
6. Doménová část musí obsahovat alespoň jednu tečku.
7. Tečka nesmí být prvním ani posledním znakem doménové části.
8. Jednotlivé části domény mezi tečkami nesmí být prázdné.
9. Pokud hodnota pravidla nesplňuje, systém ji neuloží.
10. Při neplatné hodnotě systém zobrazí vysvětlení, že je nutné zadat jednu platnou e-mailovou adresu.
11. Původní platná hodnota zůstane při neúspěšné změně zachována.
12. Systém neověřuje existenci ani doručitelnost schránky.

Příklady platných hodnot:

- `user@example.com`
- `first.last@example.co.uk`
- `user+tag@example.com`

Příklady neplatných hodnot:

- `user`
- `user@`
- `@example.com`
- `user@example`
- `user @example.com`
- `first@example.com,second@example.com`

## F4. Uložení hodnoty

1. Po odstranění okolních mezer systém adresu uloží ve znění zadaném uživatelem.
2. Systém automaticky nemění velikost písmen.
3. Zadání nové platné adresy nahradí původní hodnotu.
4. Neplatný vstup nikdy nenahradí původní platnou hodnotu.

## F5. Aktivace adresy

1. Vyplněná hodnota je aktivovatelná jako e-mailová adresa.
2. Aktivace vyvolá vytvoření nové zprávy ve výchozí e-mailové aplikaci zařízení.
3. Pole příjemce nové zprávy obsahuje uloženou adresu.
4. Task systém zprávu automaticky neodešle.
5. Aktivace adresy nemění data tasku.
6. Prázdná Email property nenabízí akci pro vytvoření zprávy.

## F6. Vyhledávání

1. Task lze vyhledat podle celé uložené adresy.
2. Task lze vyhledat podle části adresy.
3. Vyhledávání se provádí bez rozlišení velikosti písmen.

## F7. Filtrování

Email property podporuje alespoň následující operátory:

- `Is`
- `Is not`
- `Contains`
- `Does not contain`
- `Is empty`
- `Is not empty`

Porovnávání textových hodnot při filtrování nerozlišuje velikost písmen.

## F8. Řazení

1. Tasky lze podle Email property řadit vzestupně a sestupně.
2. Řazení vychází z celé uložené adresy.
3. Porovnávání při řazení nerozlišuje velikost písmen.
4. Tasky s hodnotou `Empty` tvoří samostatnou skupinu.
5. Při vzestupném řazení jsou prázdné hodnoty za vyplněnými hodnotami.
6. Při sestupném řazení jsou prázdné hodnoty také za vyplněnými hodnotami.

## F9. Duplikace property

1. Při duplikaci vznikne nová samostatná Email property.
2. Nová property převezme typ a konfiguraci původní property.
3. Systém se při každé duplikaci zeptá, zda chce uživatel zkopírovat také hodnoty.
4. Pokud uživatel zvolí kopírování hodnot, hodnoty se zkopírují pro všechny existující tasky.
5. Pokud uživatel kopírování hodnot odmítne, nová property bude u všech tasků ve stavu `Empty`.
6. Pozdější změny původní a duplikované property jsou na sobě nezávislé.

## F10. Odstranění property

1. Odstranění property ji odstraní ze sdíleného schématu.
2. Property tím zmizí ze všech tasků používajících dané schéma.
3. Odstranění property vždy vyžaduje potvrzení.
4. Potvrzovací dialog zobrazí počet tasků, ve kterých je hodnota property `Is not empty`.
5. Po potvrzení jsou property i všechny její hodnoty odstraněny.
6. Odstranění property nelze zaměňovat s odstraněním hodnoty na jednom tasku.

# G. Klíčové výjimky a hraniční situace

1. **Pouze mezery**

   Hodnota obsahující pouze mezery se po oříznutí považuje za `Empty`.

2. **Okolní mezery**

   Hodnota `user@example.com` se uloží jako `user@example.com`.

3. **Vnitřní mezera**

   Hodnota `user @example.com` je neplatná.

4. **Více adres**

   Hodnota obsahující více adres je neplatná, i když jsou jednotlivé adresy samostatně validní.

5. **Neplatná změna existující hodnoty**

   Původní platná adresa zůstane zachována.

6. **Neexistující schránka**

   Formátově platná, ale neexistující schránka může být uložena.

7. **Velikost písmen**

   Systém zachová zadaný zápis, ale vyhledávání, filtrování a řazení nerozlišuje velikost písmen.

8. **Prázdná hodnota**

   Prázdná property je platná a neblokuje uložení tasku.

9. **Odstranění hodnoty versus property**

   Vymazání hodnoty ovlivní pouze konkrétní task. Odstranění property ovlivní celé schéma.

# H. Akceptační kritéria

1. Uživatel může vytvořit property typu Email ve sdíleném schématu.
2. Property se po vytvoření zobrazí u všech existujících i nových tasků daného schématu.
3. Existující tasky mají novou property ve stavu `Empty`.
4. Uživatel může uložit jednu platnou e-mailovou adresu.
5. Uživatel nemůže uložit neplatnou adresu.
6. Uživatel nemůže uložit více adres do jedné hodnoty.
7. Neplatná změna nepřepíše původní platnou hodnotu.
8. Uživatel může uloženou adresu změnit.
9. Uživatel může hodnotu odstranit a vrátit property do stavu `Empty`.
10. Aktivace adresy vyvolá vytvoření nové zprávy s předvyplněným příjemcem.
11. Task systém zprávu sám neodešle.
12. Task lze najít podle celé adresy i její části.
13. Email property podporuje definované filtrační operátory.
14. Tasky lze podle adresy řadit vzestupně a sestupně.
15. Property lze duplikovat s hodnotami i bez hodnot.
16. Odstranění property vyžaduje potvrzení a zobrazí počet neprázdných hodnot.
17. Odstranění property odstraní property i její hodnoty ze všech tasků používajících schéma.

# I. BDD scénáře v Gherkinu

```gherkin
Feature: Email property tasku
  Uživatel potřebuje u tasků evidovat jednu kontaktní e-mailovou adresu
  a použít ji pro vyhledávání, filtrování a zahájení komunikace.

  Rule: Email property je součástí sdíleného schématu

    Scenario: Přidání Email property do schématu s existujícími tasky
      Given schéma používá 10 existujících tasků
      When uživatel přidá property typu Email s názvem "Kontaktní e-mail"
      Then property "Kontaktní e-mail" je dostupná u všech 10 tasků
      And její hodnota je u všech tasků Empty

    Scenario: Vytvoření nového tasku po přidání Email property
      Given schéma obsahuje property "Kontaktní e-mail" typu Email
      When uživatel vytvoří nový task používající toto schéma
      Then nový task obsahuje property "Kontaktní e-mail"
      And hodnota property je Empty

    Scenario: Přejmenování Email property
      Given schéma obsahuje property "Kontaktní e-mail"
      When uživatel přejmenuje property na "E-mail zákazníka"
      Then nový název je zobrazen u všech tasků používajících schéma
      And uložené hodnoty zůstanou zachovány

  Rule: Email property obsahuje nejvýše jednu adresu

    Scenario: Uložení platné adresy
      Given task obsahuje prázdnou Email property
      When uživatel zadá "customer@example.com"
      Then systém uloží "customer@example.com"

    Scenario: Uložení adresy s okolními mezerami
      Given task obsahuje prázdnou Email property
      When uživatel zadá "  customer@example.com  "
      Then systém uloží "customer@example.com"

    Scenario: Nahrazení existující adresy
      Given Email property obsahuje "old@example.com"
      When uživatel zadá platnou adresu "new@example.com"
      Then systém uloží "new@example.com"
      And hodnota "old@example.com" již není u tasku evidována

    Scenario: Odstranění existující adresy
      Given Email property obsahuje "customer@example.com"
      When uživatel odstraní hodnotu
      Then Email property je Empty
      And task zůstane platný

    Scenario: Zadání pouze mezer
      Given Email property obsahuje "customer@example.com"
      When uživatel nahradí hodnotu pouze mezerami
      Then Email property je Empty

  Rule: Neplatnou e-mailovou adresu nelze uložit

    Scenario Outline: Odmítnutí neplatného formátu
      Given task obsahuje prázdnou Email property
      When uživatel zadá "<hodnota>"
      Then systém hodnotu neuloží
      And zobrazí informaci, že je nutné zadat jednu platnou e-mailovou adresu

      Examples:
        | hodnota                               |
        | customer                              |
        | customer@                             |
        | @example.com                          |
        | customer@example                      |
        | customer @example.com                 |
        | customer@example..com                 |
        | first@example.com,second@example.com  |

    Scenario: Neplatná změna nepřepíše existující adresu
      Given Email property obsahuje "valid@example.com"
      When uživatel zadá "invalid-address"
      Then systém neplatnou hodnotu neuloží
      And Email property nadále obsahuje "valid@example.com"

    Scenario: Formátově platná neexistující schránka může být uložena
      Given task obsahuje prázdnou Email property
      When uživatel zadá formátově platnou adresu "unknown@example.com"
      Then systém adresu uloží
      And systém neověřuje existenci schránky

  Rule: Z uložené adresy lze zahájit komunikaci

    Scenario: Aktivace vyplněné adresy
      Given Email property obsahuje "customer@example.com"
      When uživatel aktivuje uloženou adresu
      Then systém vyvolá vytvoření nové e-mailové zprávy
      And příjemce zprávy je "customer@example.com"
      And task systém zprávu automaticky neodešle

    Scenario: Aktivace adresy nemění task
      Given Email property obsahuje "customer@example.com"
      When uživatel aktivuje uloženou adresu
      Then hodnota Email property zůstane "customer@example.com"
      And ostatní data tasku zůstanou beze změny

    Scenario: Prázdná property nenabízí vytvoření zprávy
      Given Email property je Empty
      Then z property nelze zahájit vytvoření e-mailové zprávy

  Rule: Tasky lze podle Email property vyhledávat

    Scenario: Vyhledání podle celé adresy
      Given task A obsahuje "customer@example.com"
      And task B obsahuje "supplier@example.com"
      When uživatel vyhledá "customer@example.com"
      Then výsledky obsahují task A
      And výsledky neobsahují task B

    Scenario: Vyhledání podle části adresy
      Given task obsahuje "customer@example.com"
      When uživatel vyhledá "customer"
      Then výsledky obsahují tento task

    Scenario: Vyhledávání nerozlišuje velikost písmen
      Given task obsahuje "Customer@Example.com"
      When uživatel vyhledá "customer@example.com"
      Then výsledky obsahují tento task

  Rule: Tasky lze podle Email property filtrovat

    Scenario: Filtrování tasků s vyplněnou adresou
      Given task A má Email property vyplněnou
      And task B má Email property Empty
      When uživatel použije filtr "Email Is not empty"
      Then systém zobrazí task A
      And systém nezobrazí task B

    Scenario: Filtrování tasků bez adresy
      Given task A má Email property vyplněnou
      And task B má Email property Empty
      When uživatel použije filtr "Email Is empty"
      Then systém zobrazí task B
      And systém nezobrazí task A

    Scenario: Filtrování podle části domény
      Given task A obsahuje "person@example.com"
      And task B obsahuje "person@another.com"
      When uživatel použije filtr "Email Contains example.com"
      Then systém zobrazí task A
      And systém nezobrazí task B

    Scenario: Přesný filtr nerozlišuje velikost písmen
      Given task obsahuje "Customer@Example.com"
      When uživatel použije filtr "Email Is customer@example.com"
      Then systém tento task zobrazí

  Rule: Tasky lze podle Email property řadit

    Scenario: Vzestupné řazení
      Given task A obsahuje "zebra@example.com"
      And task B obsahuje "alpha@example.com"
      And task C má Email property Empty
      When uživatel seřadí tasky podle Email vzestupně
      Then task B je před taskem A
      And task C je za taskem A

    Scenario: Sestupné řazení
      Given task A obsahuje "zebra@example.com"
      And task B obsahuje "alpha@example.com"
      And task C má Email property Empty
      When uživatel seřadí tasky podle Email sestupně
      Then task A je před taskem B
      And task C je za taskem B

  Rule: Email property lze duplikovat

    Scenario: Duplikace včetně hodnot
      Given Email property "Kontaktní e-mail" obsahuje u některých tasků hodnoty
      When uživatel property duplikuje
      And zvolí zkopírování hodnot
      Then vznikne nová samostatná Email property
      And nová property obsahuje u jednotlivých tasků stejné hodnoty jako původní property

    Scenario: Duplikace bez hodnot
      Given Email property "Kontaktní e-mail" obsahuje u některých tasků hodnoty
      When uživatel property duplikuje
      And odmítne zkopírování hodnot
      Then vznikne nová samostatná Email property
      And nová property je u všech tasků Empty

    Scenario: Duplikované properties jsou nezávislé
      Given existují původní a duplikovaná Email property
      When uživatel změní hodnotu původní property
      Then hodnota duplikované property se nezmění

  Rule: Odstranění Email property ovlivní celé schéma

    Scenario: Potvrzení odstranění neprázdné property
      Given Email property existuje u 20 tasků
      And u 7 tasků je její hodnota Is not empty
      When uživatel zahájí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog uvede, že 7 tasků obsahuje neprázdnou hodnotu

    Scenario: Zrušení odstranění property
      Given je zobrazen potvrzovací dialog pro odstranění Email property
      When uživatel odstranění zruší
      Then property zůstane ve schématu
      And všechny její hodnoty zůstanou zachovány

    Scenario: Potvrzení odstranění property
      Given je zobrazen potvrzovací dialog pro odstranění Email property
      When uživatel odstranění potvrdí
      Then property je odstraněna ze sdíleného schématu
      And property zmizí ze všech tasků používajících schéma
      And všechny její uložené hodnoty jsou odstraněny
```

# J. Explicitní hypotézy

## H1. Přesná šíře podporovaných adres

Specifikace definuje praktickou validaci běžných e-mailových adres. Nestandardní, ale teoreticky přípustné RFC formáty nejsou požadovány.

Příklady mimo garantovaný rozsah:

- adresy s komentáři,
- adresy s IP adresou místo domény,
- quoted local parts,
- adresy bez tečky v doméně,
- internacionalizované adresy s nelatinskými znaky.

## H2. Chování e-mailového klienta

Systém pouze předá požadavek operačnímu systému nebo prohlížeči. Dostupnost konkrétní e-mailové aplikace není odpovědností task systému.

## H3. Oprávnění

Úprava hodnoty, vytváření, duplikace a odstranění property používají stejný obecný model oprávnění jako ostatní typy properties. Email property nezavádí vlastní specifická oprávnění.
