# Created time property — GOLD business specifikace

## A. Executive summary

Property `Created time` automaticky zaznamenává okamžik vzniku tasku. Hodnota vzniká při otevření nového prázdného taskového kanvasu, i když uživatel ještě nezadal `Title` ani obsah.

Hodnota je pouze pro čtení, po celou dobu existence tasku se nemění a uživatel ji nemůže ručně nastavit, upravit ani vymazat. Každému uživateli se stejný okamžik zobrazuje v jeho lokální časové zóně.

Toto chování odpovídá principu Notion, kde `Created time` automaticky zaznamenává timestamp vytvoření položky a není editovatelný. Notion rovněž automaticky vytváří tuto hodnotu při vzniku nové položky.

**Readiness score: GOLD**

- Okamžik vzniku tasku je jednoznačně určen.
- Editovatelnost a neměnnost hodnoty jsou definovány.
- Zobrazení časové zóny a přesnosti je potvrzeno.
- Hlavní scénáře, výjimky i chování existujících tasků jsou testovatelné.

---

## B. Business cíl

Poskytnout důvěryhodný a neměnný údaj o tom, kdy task vznikl.

Property umožňuje uživatelům:

- rozlišovat nové a staré tasky,
- řadit tasky podle okamžiku vytvoření,
- filtrovat tasky podle data nebo času vytvoření,
- používat čas vytvoření v přehledech a pracovních pohledech.

---

## C. Aktéři

### Uživatel task systému

- vytváří a upravuje tasky,
- zobrazuje hodnotu `Created time`,
- řadí a filtruje tasky,
- může mít vlastní časovou zónu.

### Správce schématu

Uživatel oprávněný:

- přidat property do sdíleného schématu tasků,
- property přejmenovat,
- duplikovat,
- odstranit.

---

## D. Scope

Součástí zadání je:

1. vytvoření property typu `Created time`,
2. automatické určení hodnoty při vzniku tasku,
3. chování u prázdného taskového kanvasu,
4. zobrazení hodnoty v časové zóně uživatele,
5. přesnost zobrazeného času,
6. neměnnost a needitovatelnost hodnoty,
7. chování u existujících tasků,
8. řazení podle času vytvoření,
9. filtrování podle času vytvoření,
10. přejmenování, duplikace a odstranění property.

---

## E. Mimo scope

- `Created by`,
- `Last edited time`,
- `Last edited by`,
- historie jednotlivých úprav tasku,
- možnost opravit nebo ručně nastavit čas vytvoření,
- import a migrace času vytvoření z externích systémů,
- pravidla automatického mazání opuštěných prázdných tasků,
- technický způsob ukládání času,
- oprávnění ke správě schématu obecně,
- systémové logování a auditní infrastruktura.

---

## F. Business pravidla

### F1. Typ property

1. Property má typ `Created time`.
2. Výchozí název nové property je `Created time`.
3. Název property lze změnit.
4. Přejmenování nemění typ, hodnotu ani chování property.
5. Property je součástí sdíleného schématu tasků.
6. Po přidání je dostupná u všech tasků používajících dané schéma.

### F2. Okamžik vytvoření tasku

1. Task vzniká v okamžiku, kdy systém vytvoří nový taskový záznam a otevře jeho prázdný kanvas.
2. Vyplnění `Title` není podmínkou vzniku tasku.
3. Přidání obsahu nebo jiné property není podmínkou vzniku tasku.
4. `Created time` odpovídá tomuto okamžiku.
5. Pozdější první vyplnění tasku hodnotu neposouvá.

### F3. Automatické vytvoření hodnoty

1. Systém hodnotu nastaví automaticky.
2. Uživatel není vyzván k jejímu zadání.
3. Každý existující task má právě jeden systémový okamžik vytvoření.
4. Hodnota `Created time` nesmí být u vytvořeného tasku `Empty`.
5. Hodnota reprezentuje datum i čas, nikoliv pouze kalendářní datum.

Notion používá pro tuto property read-only timestamp vytvoření položky; její hodnota obsahuje datum a čas vytvoření.

### F4. Neměnnost hodnoty

Hodnota se nezmění při:

- doplnění nebo změně `Title`,
- změně obsahu kanvasu,
- změně jiné property,
- přesunu tasku,
- změně jeho stavu,
- opětovném otevření tasku,
- přejmenování property `Created time`,
- skrytí nebo opětovném zobrazení property.

### F5. Needitovatelnost

Uživatel nemůže:

- hodnotu ručně zadat,
- hodnotu přepsat,
- hodnotu vymazat,
- vložit jinou hodnotu kopírováním,
- změnit pouze datum,
- změnit pouze čas,
- nastavit hodnotu na `Empty`.

Property neposkytuje ovládací prvek pro editaci hodnoty.

### F6. Existující tasky

Když správce přidá `Created time` do schématu, které již používají existující tasky:

1. property se zobrazí u všech těchto tasků,
2. každý task zobrazí svůj původní okamžik vytvoření,
3. hodnota nebude odpovídat okamžiku přidání property,
4. žádný existující task nebude mít hodnotu `Empty`.

### F7. Časová zóna

1. Systém eviduje jeden společný okamžik vytvoření tasku.
2. Hodnota se zobrazuje v časové zóně aktuálního uživatele.
3. Dva uživatelé v různých časových zónách mohou vidět rozdílný místní čas nebo kalendářní datum.
4. Oba zobrazené údaje musí reprezentovat stejný okamžik.
5. Změna časové zóny uživatele změní pouze zobrazení, nikoliv okamžik vytvoření tasku.
6. Zobrazení musí respektovat pravidla letního a zimního času dané časové zóny.

### F8. Přesnost a formát zobrazení

1. Ve standardním zobrazení se hodnota ukazuje s přesností na minuty.
2. V detailním zobrazení hodnoty je dostupná přesnost na sekundy.
3. Datum a čas se formátují podle uživatelského prostředí.
4. Skrytí sekund ve standardním zobrazení nesmí snížit přesnost používanou pro řazení nebo filtrování.

### F9. Řazení

1. Tasky lze řadit podle `Created time` vzestupně i sestupně.
2. Vzestupné řazení zobrazí starší tasky před novějšími.
3. Sestupné řazení zobrazí novější tasky před staršími.
4. Řazení pracuje se skutečným okamžikem vytvoření, nikoliv s formátovaným textem.
5. Časová zóna uživatele nemění vzájemné pořadí tasků.

Notion podporuje řazení podle timestampu `created_time` v obou směrech.

### F10. Filtrování

Property podporuje časové podmínky odpovídající datumové hodnotě, zejména:

- je přesně,
- je před,
- je po,
- je včetně nebo před,
- je včetně nebo po,
- je v konkrétní kalendářní den nebo období.

Pravidla:

1. Filtr pracuje se skutečným okamžikem vytvoření.
2. Podmínka obsahující konkrétní čas se vyhodnocuje s dostupnou přesností hodnoty.
3. Podmínka obsahující pouze datum používá hranice daného dne v časové zóně aktuálního uživatele.
4. Změna časové zóny může změnit výsledek filtru založeného pouze na kalendářním datu.
5. Změna časové zóny nemění výsledek filtru založeného na přesném okamžiku.

Notion umožňuje používat `created_time` v datumových filtrech.

### F11. Duplikace property

1. Duplikací vznikne nová samostatná property typu `Created time`.
2. Nová property převezme zobrazovací konfiguraci původní property.
3. Nová property dostane samostatný název.
4. Systém se neptá, zda má kopírovat hodnoty.
5. Obě properties zobrazují u stejného tasku stejný okamžik vytvoření.
6. Pozdější přejmenování nebo odstranění jedné property neovlivní druhou.

### F12. Odstranění property

1. Odstranění property odstraní její definici ze sdíleného schématu.
2. Property následně zmizí ze všech tasků používajících toto schéma.
3. Před odstraněním se vždy zobrazí potvrzovací dialog.
4. Dialog zobrazí počet tasků, u kterých property obsahuje hodnotu.
5. U `Created time` tento počet odpovídá počtu existujících tasků používajících schéma.
6. Odstranění property nesmí změnit skutečný historický okamžik vytvoření tasků.
7. Po pozdějším přidání nové property `Created time` se znovu zobrazí původní okamžiky vytvoření.

---

## G. Klíčové výjimky a hraniční situace

### G1. Prázdný opuštěný task

Uživatel otevře nový taskový kanvas, ale nevyplní `Title` ani obsah.

Task již vznikl, a proto má platný `Created time`. Případné automatické odstranění prázdného tasku je mimo scope.

### G2. První úprava s časovým odstupem

Uživatel otevře prázdný task a vyplní jej až o několik hodin později.

`Created time` zůstane okamžikem otevření nového taskového kanvasu.

### G3. Task vytvořený před přidáním property

Přidání property zpřístupní původní historickou hodnotu. Nevytvoří nový čas.

### G4. Task vytvořený poblíž půlnoci

Stejný task může být pro různé uživatele zobrazen pod jiným kalendářním datem. Nejde o rozdílnou hodnotu, ale o rozdílnou místní reprezentaci.

### G5. Změna časové zóny

Po změně časové zóny se může změnit:

- zobrazený čas,
- zobrazené datum,
- výsledek filtru založeného pouze na místním datu.

Nezmění se:

- skutečný okamžik vytvoření,
- pořadí při řazení,
- výsledek filtru založeného na přesném okamžiku.

### G6. Dva tasky zobrazené ve stejné minutě

Tasky mohou mít ve standardním zobrazení stejnou hodnotu na minuty, ale přesto se lišit sekundami.

Řazení musí použít přesnější systémovou hodnotu.

### G7. Přechod letního času

Zobrazená hodnota musí odpovídat pravidlům časové zóny platným v okamžiku vytvoření tasku.

### G8. Odstranění a opětovné přidání property

Opětovné přidání property nevytvoří nový čas. Zobrazí původní okamžik vytvoření každého tasku.

---

## H. Akceptační kritéria

1. Otevřením nového prázdného taskového kanvasu vznikne task a jeho čas vytvoření.
2. Hodnota vznikne i bez vyplnění `Title`.
3. Hodnota je doplněna automaticky.
4. Vytvořený task nikdy nemá `Created time = Empty`.
5. Uživatel nemůže hodnotu změnit ani odstranit.
6. Změna tasku nemění jeho `Created time`.
7. Přidání property k existujícím taskům zobrazí jejich původní časy vytvoření.
8. Standardní zobrazení používá přesnost na minuty.
9. Detailní zobrazení umožňuje zjistit čas s přesností na sekundy.
10. Čas se zobrazuje v časové zóně aktuálního uživatele.
11. Změna časové zóny nemění skutečný okamžik vytvoření.
12. Řazení funguje chronologicky podle skutečného okamžiku.
13. Datumové filtrování respektuje časovou zónu aktuálního uživatele.
14. Přejmenování property nemění její hodnoty ani chování.
15. Duplikované properties zobrazují stejný okamžik vytvoření.
16. Odstranění property vyžaduje potvrzení a zobrazí počet dotčených tasků.
17. Opětovné přidání property zobrazí původní časy vytvoření.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Created time property

  Uživatelé potřebují znát neměnný okamžik vzniku tasku
  a používat jej pro zobrazení, filtrování a řazení.

  Rule: Created time vzniká automaticky při vzniku tasku

    Scenario: Vytvoření času při otevření prázdného taskového kanvasu
      Given uživatel nemá otevřený žádný nový task
      When uživatel otevře nový prázdný taskový kanvas v 10:15:30
      Then systém vytvoří nový task
      And nastaví jeho Created time na okamžik 10:15:30
      And hodnota Created time není Empty

    Scenario: Title není podmínkou vytvoření času
      Given uživatel otevřel nový prázdný taskový kanvas v 10:15:30
      And Title zůstal prázdný
      When uživatel zobrazí Created time
      Then Created time odpovídá okamžiku 10:15:30

    Scenario: Pozdější první vyplnění tasku neposune čas vytvoření
      Given uživatel otevřel nový prázdný taskový kanvas v 10:15:30
      And task dosud nemá Title ani obsah
      When uživatel zadá první obsah v 12:45:00
      Then Created time zůstane 10:15:30

  Rule: Created time je pouze pro čtení

    Scenario: Uživatel nemůže změnit hodnotu
      Given task má Created time nastavený na 10:15:30
      When se uživatel pokusí hodnotu upravit
      Then systém úpravu neumožní
      And Created time zůstane 10:15:30

    Scenario: Uživatel nemůže hodnotu vymazat
      Given task má vyplněný Created time
      When se uživatel pokusí hodnotu odstranit
      Then systém odstranění hodnoty neumožní
      And hodnota nezůstane Empty

  Rule: Úpravy tasku nemění čas vytvoření

    Scenario Outline: Změna obsahu tasku zachová původní čas
      Given task byl vytvořen v 10:15:30
      When uživatel provede změnu "<změna>"
      Then Created time zůstane 10:15:30

      Examples:
        | změna                 |
        | doplnění Title        |
        | přejmenování Title    |
        | úprava obsahu kanvasu |
        | změna jiné property   |
        | přesun tasku          |
        | změna stavu tasku     |

  Rule: Property funguje také pro existující tasky

    Scenario: Přidání Created time k existujícím taskům
      Given schéma používají tasky vytvořené 1. července a 5. července
      And schéma zatím neobsahuje property Created time
      When správce přidá property Created time
      Then první task zobrazí svůj čas vytvoření z 1. července
      And druhý task zobrazí svůj čas vytvoření z 5. července
      And žádný task nezobrazí jako hodnotu čas přidání property
      And žádný task nemá hodnotu Empty

  Rule: Hodnota se zobrazuje v časové zóně uživatele

    Scenario: Dva uživatelé vidí místní reprezentaci stejného okamžiku
      Given task byl vytvořen v jednom konkrétním okamžiku
      And uživatel A používá časovou zónu Europe/Prague
      And uživatel B používá jinou časovou zónu
      When oba uživatelé zobrazí Created time
      Then každý uživatel vidí čas ve své časové zóně
      And obě hodnoty reprezentují stejný okamžik

    Scenario: Změna časové zóny mění pouze zobrazení
      Given task má zaznamenaný konkrétní okamžik vytvoření
      And uživatel jej zobrazil v časové zóně Europe/Prague
      When uživatel změní svou časovou zónu
      Then zobrazené datum nebo čas se mohou změnit
      But skutečný okamžik vytvoření tasku zůstane stejný

  Rule: Přesnost zobrazení závisí na kontextu

    Scenario: Standardní zobrazení používá přesnost na minuty
      Given task byl vytvořen v 10:15:30
      When uživatel zobrazí Created time ve standardním přehledu
      Then systém zobrazí čas 10:15

    Scenario: Detail hodnoty zpřístupní sekundy
      Given task byl vytvořen v 10:15:30
      When uživatel zobrazí detail Created time
      Then systém zpřístupní čas 10:15:30

  Rule: Tasky lze řadit podle Created time

    Scenario: Sestupné řazení zobrazí nejnovější task jako první
      Given task A byl vytvořen v 09:00
      And task B byl vytvořen v 11:00
      When uživatel nastaví sestupné řazení podle Created time
      Then task B je zobrazen před taskem A

    Scenario: Vzestupné řazení zobrazí nejstarší task jako první
      Given task A byl vytvořen v 09:00
      And task B byl vytvořen v 11:00
      When uživatel nastaví vzestupné řazení podle Created time
      Then task A je zobrazen před taskem B

    Scenario: Řazení rozliší tasky vytvořené ve stejné zobrazené minutě
      Given task A byl vytvořen v 10:15:10
      And task B byl vytvořen v 10:15:50
      And standardní zobrazení ukazuje u obou tasků 10:15
      When uživatel nastaví sestupné řazení podle Created time
      Then task B je zobrazen před taskem A

  Rule: Tasky lze filtrovat podle Created time

    Scenario: Filtrování tasků vytvořených od určitého okamžiku
      Given task A byl vytvořen v 09:00
      And task B byl vytvořen v 11:00
      When uživatel nastaví filtr Created time je včetně nebo po 10:00
      Then systém zobrazí task B
      And systém nezobrazí task A

    Scenario: Datumový filtr používá časovou zónu uživatele
      Given task byl vytvořen poblíž půlnoci
      And v časové zóně uživatele připadá jeho Created time na 15. července
      When uživatel filtruje tasky vytvořené 15. července
      Then systém task zobrazí

  Rule: Přejmenování property nemění její význam

    Scenario: Přejmenování Created time
      Given property Created time obsahuje systémové časy vytvoření tasků
      When správce přejmenuje property na "Vytvořeno"
      Then property se zobrazuje pod názvem "Vytvořeno"
      And její typ zůstane Created time
      And všechny hodnoty zůstanou beze změny

  Rule: Created time lze duplikovat

    Scenario: Duplikace Created time
      Given schéma obsahuje property Created time
      When správce property duplikuje
      Then vznikne nová samostatná property typu Created time
      And systém se neptá na kopírování hodnot
      And obě properties zobrazují u každého tasku stejný okamžik vytvoření

  Rule: Odstranění property vyžaduje potvrzení

    Scenario: Potvrzení odstranění Created time
      Given schéma používá 25 existujících tasků
      And obsahuje property Created time
      When správce zahájí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog uvede, že hodnotu obsahuje 25 tasků
      And property ještě není odstraněna

    Scenario: Potvrzené odstranění property
      Given správce vidí potvrzovací dialog pro odstranění Created time
      When správce odstranění potvrdí
      Then property zmizí ze sdíleného schématu
      And property zmizí ze všech tasků používajících schéma
      And původní okamžiky vytvoření tasků zůstanou zachovány

    Scenario: Opětovné přidání po odstranění
      Given property Created time byla odstraněna
      And existující task byl původně vytvořen v 10:15:30
      When správce znovu přidá property Created time
      Then task zobrazí původní Created time 10:15:30
      And systém nevytvoří nový čas
```

---

## J. Explicitní hypotézy

Následující rozhodnutí nebyla v původním briefu výslovně uvedena, ale byla zvolena jako doporučené chování konzistentní se zbytkem task systému:

### H1. Sdílené schéma

`Created time` je standardní součást sdíleného schématu. Přidání nebo odstranění property se projeví u všech tasků používajících dané schéma.

### H2. Historický čas existuje nezávisle na property

Task má svůj okamžik vytvoření i tehdy, když schéma momentálně neobsahuje property `Created time`. Property tento údaj pouze zpřístupňuje.

### H3. Duplikace nekopíruje hodnoty

U duplikace se nezobrazuje otázka na kopírování hodnot, protože obě properties odvozují hodnotu ze stejného systémového okamžiku vytvoření tasku.

### H4. Odstranění nemaže historický okamžik

Odstranění property odstraní její definici ze schématu, nikoliv historický údaj o vzniku tasku.

Tyto hypotézy nemění potvrzené základní chování property a jsou dostatečně konkrétní pro implementaci a testování.
