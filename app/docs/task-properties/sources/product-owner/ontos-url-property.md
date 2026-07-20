# URL property — GOLD business specifikace

## Readiness score

**GOLD**

- Je potvrzeno, že property obsahuje nula nebo jednu URL.
- Je potvrzeno, že jsou přijímány pouze úplné adresy s protokolem `http://` nebo `https://`.
- Hlavní tok, validace, změna, odstranění, otevření a filtrování jsou jednoznačně testovatelné.
- URL-specifické chování lze předat coding agents bez dalších business rozhodnutí.

# A. Executive summary

URL property umožňuje k tasku připojit jednu webovou adresu externího zdroje, například dokumentace, zákaznického systému, návrhu nebo souvisejícího ticketu.

Hodnota je nepovinná. Pokud je vyplněna, musí jít o úplnou absolutní URL začínající `http://` nebo `https://`. Neúplné a nepodporované adresy se neuloží.

Jedna URL property může na jednom tasku obsahovat maximálně jednu adresu. Zadání nové adresy nahrazuje původní hodnotu.

# B. Business cíl

Umožnit uživateli:

- připojit k tasku externí webový zdroj,
- uložený odkaz přímo otevřít nebo zkopírovat,
- snadno rozpoznat tasky s vyplněným odkazem,
- filtrovat tasky podle přítomnosti nebo obsahu URL.

Výsledkem má být jednoduchá property určená výhradně pro webové adresy, nikoliv obecné textové poznámky.

# C. Aktéři

## Editor tasku

Uživatel oprávněný měnit hodnoty properties tasku.

Může:

- zadat URL,
- změnit URL,
- odstranit URL,
- otevřít nebo zkopírovat uloženou URL.

## Čtenář tasku

Uživatel oprávněný zobrazit task.

Může:

- zobrazit URL,
- otevřít URL,
- zkopírovat URL,

pokud mu to jeho oprávnění k tasku dovoluje.

## Správce schématu

Uživatel oprávněný přidávat a konfigurovat properties ve schématu tasků.

Může vytvořit property s datovým typem `URL`.

# D. Scope

Specifikace zahrnuje:

- property datového typu `URL`,
- prázdnou hodnotu,
- zadání URL,
- validaci URL,
- uložení URL,
- změnu existující URL,
- odstranění hodnoty,
- otevření uloženého odkazu,
- zkopírování uložené hodnoty,
- filtrování podle hodnoty,
- řazení podle textové hodnoty URL,
- zobrazení validační chyby.

Obecný lifecycle properties, například vytvoření ve sdíleném schématu, přejmenování, změna pořadí, duplikace nebo odstranění celé property, se řídí společnými pravidly properties a není v této specifikaci znovu definován.

# E. Mimo scope

- více URL v jedné hodnotě,
- seznam odkazů,
- interní vazby mezi tasky,
- mentions a relations,
- automatické načítání názvu cílové stránky,
- favicon nebo náhled cílové stránky,
- kontrola existence cílové stránky,
- kontrola dostupnosti odkazu,
- kontrola HTTP statusu,
- stahování obsahu z URL,
- automatické přihlašování do cílové služby,
- zkracování URL,
- sledování počtu otevření odkazu,
- automatické doplnění chybějícího protokolu,
- protokoly jiné než HTTP a HTTPS.

# F. Business pravidla

## F1. Kardinalita hodnoty

1. Jedna URL property obsahuje na jednom tasku:
   - žádnou hodnotu, nebo
   - právě jednu URL.
2. Property nesmí obsahovat více samostatných URL současně.
3. Zadání nové URL do již vyplněné property nahrazuje původní hodnotu.

## F2. Nepovinná hodnota

1. URL property je nepovinná.
2. Prázdná URL property je platný stav.
3. Task lze uložit i bez vyplněné URL.
4. Odstranění URL vrátí property do stavu `Empty`.

## F3. Platná URL

Hodnota je platná, pokud:

1. představuje jednu absolutní URL,
2. začíná protokolem `http://` nebo `https://`,
3. obsahuje neprázdnou hostitelskou část,
4. neobsahuje mezery uvnitř adresy,
5. lze ji vyhodnotit jako jedinou URL hodnotu.

Příklady platných hodnot:

```
https://example.com
http://example.com
https://example.com/path
https://example.com/path?source=task
https://example.com/path?source=task#section
```

## F4. Neplatná URL

Za neplatnou se považuje zejména:

- doména bez protokolu,
- běžný text,
- relativní cesta,
- hodnota obsahující více samostatných URL,
- URL s nepodporovaným protokolem,
- hodnota s mezerami uvnitř adresy,
- hodnota bez hostitelské části.

Příklady neplatných hodnot:

```
example.com
www.example.com
documentation
/example/path
ftp://example.com
mailto:user@example.com
javascript:alert(1)
https://
https://example .com
```

## F5. Zpracování neplatného vstupu

1. Neplatná hodnota se neuloží.
2. Původní uložená hodnota se při neúspěšné změně neztratí.
3. Uživatel dostane validační zprávu vysvětlující, že musí zadat úplnou HTTP nebo HTTPS adresu.
4. Systém neprovádí automatické doplnění `https://`.
5. Systém nezmění neplatnou hodnotu na jinou adresu bez vědomí uživatele.

Doporučené znění validační zprávy:

```
Zadejte úplnou URL začínající http:// nebo https://.
```

## F6. Mezery kolem hodnoty

1. Mezery před a za URL se před validací odstraní.
2. Mezery uvnitř URL způsobí neplatnost hodnoty.
3. Kromě odstranění vnějších mezer se URL automaticky nepřepisuje.

Příklad:

```
"  https://example.com/page  "
```

se uloží jako:

```
"https://example.com/page"
```

## F7. Zachování hodnoty

Systém zachová uživatelem zadané významové části URL, zejména:

- cestu,
- query parametry,
- fragment,
- velikost písmen v cestě,
- zakódované znaky.

Systém nesmí bez samostatně definovaného pravidla:

- odstraňovat query parametry,
- odstraňovat fragment,
- měnit cestu,
- měnit HTTP na HTTPS,
- přidávat nebo odstraňovat koncové lomítko.

## F8. Otevření URL

1. Neprázdná platná hodnota je zobrazena jako aktivní odkaz.
2. Aktivací odkazu systém otevře přesně uloženou URL.
3. Otevření URL nemění uloženou hodnotu.
4. Prázdná property nenabízí otevření odkazu.
5. Otevření URL není podmíněno předchozí kontrolou dostupnosti cílové stránky.

## F9. Kopírování URL

1. Uživatel může zkopírovat přesně uloženou hodnotu.
2. Kopírování URL hodnotu nemění.
3. U prázdné property není dostupná akce pro kopírování URL.

## F10. Filtrování

URL property podporuje minimálně tyto operátory:

- `Contains`
- `Does not contain`
- `Is empty`
- `Is not empty`

### Contains

Task odpovídá filtru, pokud uložená URL obsahuje zadaný text.

### Does not contain

Task odpovídá filtru, pokud:

- má vyplněnou URL, která zadaný text neobsahuje, nebo
- podle společných pravidel filtrování systému spadá prázdná hodnota do negativního filtru.

Chování prázdných hodnot u negativních filtrů musí být stejné jako u ostatních textových properties.

### Is empty

Task odpovídá, pokud URL property nemá hodnotu.

### Is not empty

Task odpovídá, pokud URL property obsahuje uloženou URL.

## F11. Řazení

Pokud task systém podporuje řazení podle properties:

1. URL hodnoty se řadí podle své uložené textové reprezentace.
2. Umístění prázdných hodnot se řídí společným pravidlem řazení systému.
3. Systém při řazení neanalyzuje doménu, protokol ani cílový obsah samostatně.

# G. Klíčové výjimky a hraniční situace

## G1. Neúplná doména

Vstup:

```
example.com
```

se neuloží, protože chybí protokol.

## G2. Nepodporovaný protokol

Vstup:

```
ftp://example.com
```

se neuloží.

## G3. Více adres v jednom vstupu

Vstup:

```
https://example.com https://example.org
```

se neuloží, protože property podporuje pouze jednu URL.

## G4. URL s query parametry

Vstup:

```
https://example.com/search?q=task&type=open
```

je platný a uloží se včetně parametrů.

## G5. URL s fragmentem

Vstup:

```
https://example.com/document#section-2
```

je platný a uloží se včetně fragmentu.

## G6. URL obklopená mezerami

Vnější mezery se odstraní a očištěná URL se uloží.

## G7. Mezery uvnitř URL

Vstup:

```
https://example .com
```

se neuloží.

## G8. Chybná změna existující URL

Pokud property obsahuje platnou URL a uživatel se ji pokusí nahradit neplatnou hodnotou:

- neplatná hodnota se neuloží,
- původní platná URL zůstane zachována.

## G9. Cílová stránka neexistuje

Pokud je URL syntakticky platná, může být uložena bez ohledu na to, zda cílová stránka existuje nebo je dostupná.

# H. Akceptační kritéria

1. Uživatel může ponechat URL property prázdnou.
2. Uživatel může uložit jednu úplnou `http://` nebo `https://` adresu.
3. Uživatel nemůže uložit doménu bez protokolu.
4. Uživatel nemůže uložit URL s nepodporovaným protokolem.
5. Uživatel nemůže uložit více URL do jedné property.
6. Zadání nové platné URL nahradí původní hodnotu.
7. Neplatná změna nesmaže původní platnou hodnotu.
8. Uživatel může uloženou URL odstranit.
9. Uživatel může uloženou URL otevřít.
10. Uživatel může uloženou URL zkopírovat.
11. Vnější mezery jsou před uložením odstraněny.
12. Query parametry a fragment zůstávají zachovány.
13. Tasky lze filtrovat podle prázdné a neprázdné URL.
14. Tasky lze filtrovat podle textu obsaženého v URL.
15. Systém automaticky nedoplňuje chybějící protokol.
16. Systém nekontroluje dostupnost nebo existenci cílové stránky.

# I. BDD scénáře v Gherkinu

```gherkin
Feature: URL property tasku
  URL property umožňuje připojit k tasku jednu externí webovou adresu.

  Rule: URL property je nepovinná

    Scenario: URL property může zůstat prázdná
      Given task obsahuje property typu URL
      And property nemá žádnou hodnotu
      When uživatel uloží task
      Then task je uložen
      And URL property zůstane ve stavu Empty

    Scenario: Uživatel odstraní existující URL
      Given URL property obsahuje "https://example.com/specification"
      When uživatel odstraní její hodnotu
      And uloží změnu
      Then URL property je ve stavu Empty

  Rule: URL property obsahuje nejvýše jednu URL

    Scenario: Uživatel uloží URL do prázdné property
      Given URL property je ve stavu Empty
      When uživatel zadá "https://example.com/specification"
      And uloží změnu
      Then URL property obsahuje přesně "https://example.com/specification"

    Scenario: Nová URL nahradí původní URL
      Given URL property obsahuje "https://example.com/old"
      When uživatel zadá "https://example.com/new"
      And uloží změnu
      Then URL property obsahuje "https://example.com/new"
      And původní URL již není hodnotou property

    Scenario: Uživatel zadá více URL do jedné property
      Given URL property je ve stavu Empty
      When uživatel zadá "https://example.com https://example.org"
      And pokusí se změnu uložit
      Then hodnota není uložena
      And URL property zůstane ve stavu Empty
      And uživatel je informován, že property podporuje pouze jednu URL

  Rule: Uložena může být pouze úplná HTTP nebo HTTPS URL

    Scenario Outline: Uživatel uloží platnou URL
      Given URL property je ve stavu Empty
      When uživatel zadá "<url>"
      And uloží změnu
      Then URL property obsahuje "<url>"

      Examples:
        | url                                             |
        | https://example.com                             |
        | http://example.com                              |
        | https://example.com/path                        |
        | https://example.com/path?source=task            |
        | https://example.com/path?source=task#section    |

    Scenario Outline: Uživatel zadá neplatnou URL
      Given URL property je ve stavu Empty
      When uživatel zadá "<value>"
      And pokusí se změnu uložit
      Then hodnota není uložena
      And URL property zůstane ve stavu Empty
      And uživatel je informován, že musí zadat úplnou HTTP nebo HTTPS adresu

      Examples:
        | value                         |
        | example.com                   |
        | www.example.com               |
        | documentation                 |
        | /example/path                 |
        | ftp://example.com             |
        | mailto:user@example.com       |
        | javascript:alert(1)           |
        | https://                      |
        | https://example .com          |

    Scenario: Systém automaticky nedoplní chybějící protokol
      Given URL property je ve stavu Empty
      When uživatel zadá "example.com"
      And pokusí se změnu uložit
      Then hodnota není uložena
      And systém nezmění hodnotu na "https://example.com"

  Rule: Neplatná změna nesmí odstranit původní hodnotu

    Scenario: Uživatel nahradí platnou URL neplatnou hodnotou
      Given URL property obsahuje "https://example.com/original"
      When uživatel zadá "example.com/new"
      And pokusí se změnu uložit
      Then změna není uložena
      And URL property stále obsahuje "https://example.com/original"
      And uživatel je informován, že musí zadat úplnou HTTP nebo HTTPS adresu

  Rule: Systém odstraní pouze vnější mezery

    Scenario: URL je obklopena mezerami
      Given URL property je ve stavu Empty
      When uživatel zadá "  https://example.com/page  "
      And uloží změnu
      Then URL property obsahuje "https://example.com/page"

    Scenario: URL obsahuje mezery uvnitř adresy
      Given URL property je ve stavu Empty
      When uživatel zadá "https://example .com/page"
      And pokusí se změnu uložit
      Then hodnota není uložena
      And uživatel je informován, že URL není platná

  Rule: Významové části URL zůstávají zachovány

    Scenario: URL obsahuje query parametry a fragment
      Given URL property je ve stavu Empty
      When uživatel zadá "https://example.com/Page?a=One#Section"
      And uloží změnu
      Then URL property obsahuje přesně "https://example.com/Page?a=One#Section"

  Rule: Uloženou URL lze otevřít

    Scenario: Uživatel otevře uloženou URL
      Given URL property obsahuje "https://example.com/specification"
      When uživatel aktivuje uložený odkaz
      Then systém otevře "https://example.com/specification"
      And uložená hodnota zůstane nezměněna

    Scenario: Prázdnou URL nelze otevřít
      Given URL property je ve stavu Empty
      When uživatel zobrazí task
      Then property nenabízí otevření cílové adresy

    Scenario: Systém před otevřením nekontroluje existenci cílové stránky
      Given URL property obsahuje syntakticky platnou URL
      And cílová stránka není dostupná
      When uživatel aktivuje uložený odkaz
      Then systém se pokusí otevřít uloženou URL
      And dostupnost cílové stránky nemění uloženou hodnotu

  Rule: Uloženou URL lze zkopírovat

    Scenario: Uživatel zkopíruje URL
      Given URL property obsahuje "https://example.com/specification"
      When uživatel zkopíruje hodnotu property
      Then zkopírovaná hodnota je přesně "https://example.com/specification"
      And URL property zůstane nezměněna

    Scenario: Prázdná property nenabízí kopírování URL
      Given URL property je ve stavu Empty
      When uživatel zobrazí task
      Then property nenabízí kopírování URL

  Rule: Tasky lze filtrovat podle vyplnění URL property

    Scenario: Filtrování tasků s vyplněnou URL
      Given task "A" má URL "https://example.com/a"
      And task "B" má URL property ve stavu Empty
      When uživatel použije filtr "URL Is not empty"
      Then výsledek obsahuje task "A"
      And výsledek neobsahuje task "B"

    Scenario: Filtrování tasků bez URL
      Given task "A" má URL "https://example.com/a"
      And task "B" má URL property ve stavu Empty
      When uživatel použije filtr "URL Is empty"
      Then výsledek obsahuje task "B"
      And výsledek neobsahuje task "A"

  Rule: Tasky lze filtrovat podle textu obsaženého v URL

    Scenario: URL obsahuje hledaný text
      Given task "A" má URL "https://docs.example.com/specification"
      And task "B" má URL "https://other.example.org"
      When uživatel použije filtr "URL Contains docs.example.com"
      Then výsledek obsahuje task "A"
      And výsledek neobsahuje task "B"

    Scenario: URL neobsahuje hledaný text
      Given task "A" má URL "https://docs.example.com/specification"
      And task "B" má URL "https://other.example.org"
      When uživatel použije filtr "URL Does not contain docs.example.com"
      Then výsledek obsahuje task "B"
      And výsledek neobsahuje task "A"
```

# J. Explicitní hypotézy

Následující rozhodnutí nebyla výslovně potvrzena, ale jsou přijata jako pracovní návrh, protože nevyžadují další zásadní business rozhodnutí:

## H1. Otevírání odkazu

Uložená URL se otevře způsobem, který zachová uživateli kontext otevřeného tasku, typicky v novém panelu nebo okně.

## H2. Normalizace hodnoty

Systém odstraní pouze mezery před a za hodnotou. Žádnou jinou část URL automaticky nemění.

## H3. Kopírování

Akce kopírování vrátí přesnou uloženou textovou hodnotu URL.

## H4. Filtrování textu

Operátory `Contains` a `Does not contain` používají stejná pravidla porovnání textu jako ostatní textové properties v task systému.

## H5. Řazení

URL se řadí podle celé uložené textové hodnoty, nikoliv samostatně podle domény nebo protokolu.

Specifikace je připravena pro handoff coding agents.
