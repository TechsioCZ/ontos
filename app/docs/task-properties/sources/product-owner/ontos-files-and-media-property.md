Níže je finální GOLD handoff připravený pro coding agents.

# Files & media property — finální business specifikace

## A. Executive summary

Property `Files & media` umožňuje připojit k tasku více nahraných souborů a veřejných externích odkazů.

Property je součástí sdíleného schématu tasků. Po jejím vytvoření je dostupná ve všech tascích používajících dané schéma a u existujících tasků začíná ve stavu `Empty`.

Položky lze přidávat, otevírat, stahovat, řadit a jednotlivě odstraňovat. Odstranění celé property ze schématu vždy vyžaduje potvrzení a zobrazí počet tasků, ve kterých property není `Empty`.

Property lze duplikovat. Při každé duplikaci se uživatel rozhodne, zda chce zkopírovat také její hodnoty.

---

## B. Business cíl

Umožnit uživateli uchovávat soubory, média a externí podklady přímo v kontextu tasku, aby byly vstupy, reference a výstupy tasku dostupné na jednom místě.

---

## C. Aktéři

### Uživatel upravující task

Pracuje s hodnotou existující property:

- přidává soubory a externí odkazy,
- otevírá a stahuje položky,
- mění jejich pořadí,
- odstraňuje jednotlivé položky.

### Uživatel upravující sdílené schéma

Pracuje s definicí property:

- vytváří property,
- přejmenovává ji,
- duplikuje ji,
- odstraňuje ji ze schématu.

Konkrétní oprávnění rolí jsou mimo scope této specifikace.

---

## D. Scope

- vytvoření property typu `Files & media`,
- vlastní název property,
- dostupnost property ve všech tascích používajících stejné schéma,
- prázdný stav `Empty`,
- nahrání jednoho nebo více souborů,
- přidání veřejného externího odkazu,
- více položek v jedné hodnotě,
- uživatelsky definované pořadí položek,
- otevření položky,
- náhled podporovaných médií,
- stažení nahraného souboru,
- odstranění jednotlivé položky,
- validace souborů a odkazů,
- duplikace property s volbou kopírování hodnot,
- odstranění celé property s potvrzením.

---

## E. Mimo scope

- editace obsahu přiložených souborů,
- verzování souborů,
- komentáře a anotace uvnitř souborů,
- synchronizace změn externího obsahu,
- centrální knihovna médií,
- napojení na externí cloudová úložiště,
- automatické použití obrázku jako náhledu tasku,
- nastavení limitů samostatně pro jednotlivé properties,
- technický způsob ukládání a kopírování souborů,
- bezpečnostní kontrola souborů,
- oprávnění a role.

---

## F. Business pravidla

### F1. Sdílené schéma

1. `Files & media` je property sdíleného schématu tasků.
2. Po vytvoření je property dostupná ve všech tascích používajících dané schéma.
3. U všech existujících tasků má nová property hodnotu `Empty`.
4. Nové tasky vytvořené podle stejného schématu property automaticky obsahují.
5. Každý task má vlastní nezávislou hodnotu property.
6. Změna hodnoty v jednom tasku neovlivní ostatní tasky.

### F2. Obsah property

1. Property může obsahovat žádnou, jednu nebo více položek.
2. Položkou může být:
   - nahraný soubor,
   - veřejný externí odkaz na soubor nebo médium.
3. Property může současně obsahovat nahrané soubory i externí odkazy.
4. Přidání nové položky nenahrazuje již existující položky.
5. Více souborů lze přidat v jedné operaci.
6. Duplicitní položky jsou povoleny.
7. Odstranění poslední položky nastaví hodnotu property na `Empty`.

### F3. Pořadí položek

1. Položky mají explicitní pořadí.
2. Pořadí lze uživatelsky měnit.
3. Nové položky se standardně přidají za existující položky.
4. Při hromadném přidání odpovídá pořadí nových položek pořadí, ve kterém byly přijaty.
5. Pořadí je specifické pro konkrétní task.

### F4. Otevření a stažení

1. Nahraný soubor lze otevřít nebo stáhnout.
2. Podporovaný mediální formát může být otevřen v interním náhledu.
3. Soubor bez interního náhledu se zobrazí alespoň názvem a typem.
4. Externí položka se otevírá ve svém původním externím umístění.
5. Systém negarantuje budoucí dostupnost externího obsahu.

### F5. Validace

1. Nahrávaný soubor musí splnit společná produktová pravidla pro:
   - podporovaný typ,
   - maximální velikost.
2. Externí položka musí obsahovat syntakticky platný podporovaný odkaz.
3. Neplatná položka není uložena.
4. Odmítnutí nebo selhání nové položky nesmí změnit již uložené položky.
5. Při přidání více souborů se každý soubor vyhodnocuje samostatně.
6. Platné soubory mohou být uloženy i tehdy, když jsou jiné soubory ze stejné operace odmítnuty.
7. Uživatel dostane vysvětlení pro každou odmítnutou položku.

### F6. Odstranění jednotlivé položky

1. Každou položku lze odstranit samostatně.
2. Odstranění jedné položky neovlivní ostatní položky.
3. Odstranění jednotlivé položky neodstraní definici property.
4. Odstranění jednotlivé položky nevyžaduje potvrzovací dialog.

### F7. Duplikace property

1. Duplikací vznikne nová samostatná property.
2. Nová property převezme typ a konfiguraci původní property.
3. Při každé duplikaci se systém zeptá, zda chce uživatel zkopírovat také hodnoty.
4. Pokud uživatel kopírování hodnot odmítne:
   - nová property je u všech tasků `Empty`.
5. Pokud uživatel kopírování hodnot potvrdí:
   - hodnoty se zkopírují pro všechny existující tasky,
   - zachová se typ každé položky,
   - zachová se pořadí položek.
6. Původní a nová property jsou po dokončení duplikace nezávislé.
7. Pozdější přidání, odstranění nebo změna pořadí položek v jedné property neovlivní druhou property.
8. Selhání duplikace nesmí vytvořit částečně dostupnou property.

### F8. Odstranění celé property

1. Odstranění property z jednoho tasku znamená odstranění property ze sdíleného schématu.
2. Property se následně odstraní ze všech tasků používajících dané schéma.
3. Odstranění vždy zobrazí potvrzovací dialog.
4. Dialog zobrazí počet tasků, ve kterých property není `Empty`.
5. Do počtu se zahrne každý task, který obsahuje alespoň jednu položku.
6. Po potvrzení se odstraní definice property i všechny její hodnoty.
7. Po zrušení dialogu se nic nezmění.

---

## G. Klíčové výjimky a hraniční situace

1. **Částečně platný hromadný upload**

   Platné soubory se uloží, neplatné se odmítnou samostatně.

2. **Selhání během nahrávání**

   Neúspěšná položka se nesmí prezentovat jako uložená a existující hodnoty zůstanou zachovány.

3. **Nedostupný externí obsah**

   Uložený odkaz zůstává v property. Systém pouze nesmí prezentovat otevření jako úspěšné.

4. **Soubor bez podporovaného náhledu**

   Soubor zůstává platnou přílohou a lze jej stáhnout.

5. **Stejné názvy souborů**

   Více položek může mít stejný název. Jde o samostatné položky.

6. **Odstranění poslední položky**

   Property zůstává součástí tasku a přejde do stavu `Empty`.

7. **Odstranění prázdné property ze schématu**

   Potvrzovací dialog se zobrazí také tehdy, když je počet neprázdných tasků `0`.

8. **Duplikace prázdné property s kopírováním hodnot**

   Nová property vznikne a zůstane u všech tasků `Empty`.

9. **Změna původní property po duplikaci**

   Nemění konfiguraci ani hodnoty duplikované property.

---

## H. Akceptační kritéria

1. Uživatel může vytvořit property typu `Files & media` s vlastním názvem.
2. Property se objeví ve všech tascích stejného schématu.
3. Existující tasky mají po vytvoření property hodnotu `Empty`.
4. Uživatel může přidat nahraný soubor.
5. Uživatel může přidat veřejný externí odkaz.
6. Jedna property může obsahovat více položek obou typů.
7. Uživatel může přidat více souborů v jedné operaci.
8. Přidání položky zachová všechny existující položky.
9. Uživatel může měnit pořadí položek.
10. Uživatel může otevřít každou platnou položku odpovídajícím způsobem.
11. Nahraný soubor lze stáhnout.
12. Uživatel může odstranit jednu položku bez odstranění celé property.
13. Odstranění poslední položky nastaví property na `Empty`.
14. Neplatný soubor nebo odkaz není uložen.
15. Selhání jedné položky nepoškodí již uložené hodnoty.
16. Při hromadném přidání jsou platné a neplatné soubory vyhodnoceny samostatně.
17. Property lze duplikovat bez hodnot.
18. Property lze duplikovat včetně hodnot všech existujících tasků.
19. Duplikovaná property je nezávislá na původní property.
20. Odstranění celé property vždy vyžaduje potvrzení.
21. Potvrzení zobrazuje počet tasků, ve kterých property není `Empty`.
22. Zrušení odstranění nezmění schéma ani hodnoty.
23. Potvrzené odstranění smaže property a její hodnoty ze všech tasků stejného schématu.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Files & media property tasku

  Uživatel potřebuje připojit k tasku soubory a externí média,
  aby měl podklady, reference a výstupy dostupné v kontextu tasku.

  Rule: Files & media je součástí sdíleného schématu

    Scenario: Přidání property do schématu s existujícími tasky
      Given schéma používá 15 existujících tasků
      When uživatel přidá property "Podklady" typu "Files & media"
      Then property "Podklady" je dostupná ve všech 15 tascích
      And její hodnota je ve všech 15 tascích `Empty`

    Scenario: Nový task obsahuje property ze svého schématu
      Given schéma obsahuje property "Podklady" typu "Files & media"
      When uživatel vytvoří nový task podle tohoto schématu
      Then nový task obsahuje property "Podklady"
      And její hodnota je `Empty`

    Scenario: Hodnoty property jsou nezávislé mezi tasky
      Given task "A" a task "B" používají stejné schéma
      And oba obsahují property "Podklady"
      When uživatel přidá soubor "zadani.pdf" do tasku "A"
      Then task "A" obsahuje soubor "zadani.pdf"
      And property "Podklady" v tasku "B" zůstane `Empty`

  Rule: Property může obsahovat více nahraných souborů

    Scenario: Přidání prvního souboru
      Given property "Podklady" je `Empty`
      And soubor "zadani.pdf" splňuje platná omezení
      When uživatel přidá soubor "zadani.pdf"
      Then property obsahuje soubor "zadani.pdf"

    Scenario: Přidání dalšího souboru
      Given property obsahuje soubor "zadani.pdf"
      And soubor "navrh.png" splňuje platná omezení
      When uživatel přidá soubor "navrh.png"
      Then property obsahuje položky v pořadí:
        | pořadí | položka    |
        | 1      | zadani.pdf |
        | 2      | navrh.png  |

    Scenario: Přidání více souborů v jedné operaci
      Given property je `Empty`
      And všechny vybrané soubory splňují platná omezení
      When uživatel přidá soubory "a.pdf", "b.png" a "c.csv"
      Then property obsahuje všechny tři soubory
      And jejich pořadí odpovídá pořadí přidání

    Scenario: Přidání stejného souboru opakovaně
      Given property obsahuje jednu položku "zadani.pdf"
      When uživatel znovu přidá soubor "zadani.pdf"
      Then property obsahuje dvě samostatné položky s názvem "zadani.pdf"

  Rule: Property podporuje veřejné externí odkazy

    Scenario: Přidání platného externího odkazu
      Given property "Podklady" je `Empty`
      When uživatel přidá platný veřejný odkaz na médium
      Then property obsahuje externí položku
      And položku lze otevřít v původním umístění

    Scenario: Kombinace souboru a externího odkazu
      Given property obsahuje nahraný soubor "zadani.pdf"
      When uživatel přidá platný veřejný externí odkaz
      Then property obsahuje nahraný soubor i externí položku

    Scenario: Zamítnutí neplatného odkazu
      Given property obsahuje soubor "zadani.pdf"
      When uživatel zadá hodnotu, která není platným podporovaným odkazem
      Then externí položka není přidána
      And soubor "zadani.pdf" zůstane zachován

    Scenario: Externí obsah se stane nedostupným
      Given property obsahuje uložený externí odkaz
      And cílový obsah již není dostupný
      When uživatel se pokusí externí položku otevřít
      Then systém neprezentuje otevření jako úspěšné
      And externí odkaz zůstane uložen v property

  Rule: Položky mají uživatelem definované pořadí

    Scenario: Změna pořadí položek
      Given property obsahuje položky v pořadí "zadani.pdf", "navrh.png"
      When uživatel přesune "navrh.png" před "zadani.pdf"
      Then property obsahuje položky v pořadí "navrh.png", "zadani.pdf"

    Scenario: Změna pořadí v jednom tasku neovlivní jiný task
      Given task "A" a task "B" obsahují stejné dvě položky
      And položky jsou v obou tascích ve stejném pořadí
      When uživatel změní pořadí položek v tasku "A"
      Then pořadí v tasku "A" se změní
      And pořadí v tasku "B" zůstane nezměněné

  Rule: Uživatel může otevřít nebo stáhnout položku

    Scenario: Otevření podporovaného obrázku
      Given property obsahuje podporovaný obrázek
      When uživatel obrázek otevře
      Then systém zobrazí jeho náhled

    Scenario: Zobrazení souboru bez interního náhledu
      Given property obsahuje platný soubor
      And systém pro jeho typ neposkytuje náhled
      When uživatel zobrazí položku
      Then systém zobrazí alespoň název a typ souboru
      And uživatel může soubor stáhnout

    Scenario: Stažení nahraného souboru
      Given property obsahuje nahraný soubor "zadani.pdf"
      When uživatel požádá o jeho stažení
      Then systém poskytne soubor "zadani.pdf" ke stažení

    Scenario: Otevření externího média
      Given property obsahuje platný externí odkaz
      When uživatel položku otevře
      Then systém otevře původní umístění externího média

  Rule: Neplatné soubory nesmí změnit existující hodnotu

    Scenario: Zamítnutí nepodporovaného typu
      Given property obsahuje soubor "zadani.pdf"
      And nový soubor má nepodporovaný typ
      When uživatel se pokusí nový soubor přidat
      Then nový soubor není uložen
      And uživatel dostane vysvětlení, že typ není podporován
      And soubor "zadani.pdf" zůstane zachován

    Scenario: Zamítnutí příliš velkého souboru
      Given property obsahuje soubor "zadani.pdf"
      And nový soubor překračuje platný velikostní limit
      When uživatel se pokusí nový soubor přidat
      Then nový soubor není uložen
      And uživatel dostane informaci o maximální povolené velikosti
      And soubor "zadani.pdf" zůstane zachován

    Scenario: Selhání nahrávání dalšího souboru
      Given property obsahuje soubor "zadani.pdf"
      When nahrávání souboru "navrh.png" skončí chybou
      Then soubor "navrh.png" není dostupný jako uložená položka
      And soubor "zadani.pdf" zůstane zachován

    Scenario: Částečně úspěšné přidání více souborů
      Given uživatel vybral soubory "a.pdf", "b.exe" a "c.png"
      And "a.pdf" a "c.png" splňují platná omezení
      And "b.exe" platná omezení nesplňuje
      When systém soubory vyhodnotí
      Then "a.pdf" a "c.png" jsou přidány
      And "b.exe" není přidán
      And uživatel dostane vysvětlení odmítnutí souboru "b.exe"

  Rule: Uživatel může odstranit jednotlivou položku

    Scenario: Odstranění jedné z více položek
      Given property obsahuje soubory "zadani.pdf" a "navrh.png"
      When uživatel odstraní položku "zadani.pdf"
      Then property již neobsahuje položku "zadani.pdf"
      And property stále obsahuje položku "navrh.png"

    Scenario: Odstranění poslední položky
      Given property obsahuje pouze položku "zadani.pdf"
      When uživatel položku odstraní
      Then property zůstane součástí tasku
      And její hodnota je `Empty`

  Rule: Property lze duplikovat

    Scenario: Duplikace bez hodnot
      Given property "Podklady" obsahuje hodnoty v existujících tascích
      When uživatel zahájí duplikaci property
      Then systém se zeptá, zda zkopírovat také hodnoty
      When uživatel kopírování hodnot odmítne
      Then vznikne nová samostatná property stejného typu
      And nová property je u všech tasků `Empty`

    Scenario: Duplikace včetně hodnot
      Given property "Podklady" obsahuje hodnoty v existujících tascích
      When uživatel zahájí duplikaci property
      And potvrdí zkopírování hodnot
      Then vznikne nová samostatná property stejného typu
      And hodnoty se zkopírují pro všechny existující tasky
      And typy a pořadí položek zůstanou zachovány

    Scenario: Duplikované properties jsou nezávislé
      Given property byla duplikována včetně hodnot
      And původní i nová property obsahují položku "zadani.pdf"
      When uživatel odstraní položku z původní property
      Then položka je odstraněna pouze z původní property
      And v duplikované property zůstane zachována

    Scenario: Selhání duplikace
      Given uživatel duplikuje property
      When duplikaci nelze dokončit
      Then nová property není dostupná ve schématu
      And původní property i její hodnoty zůstanou nezměněné

  Rule: Odstranění celé property vyžaduje potvrzení

    Scenario: Zahájení odstranění používané property
      Given property "Podklady" je součástí sdíleného schématu
      And property není `Empty` ve 12 tascích
      When uživatel zahájí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog zobrazí počet 12 tasků s neprázdnou hodnotou

    Scenario: Potvrzení odstranění property
      Given uživatel vidí potvrzovací dialog pro odstranění property
      When odstranění potvrdí
      Then property je odstraněna ze sdíleného schématu
      And property je odstraněna ze všech tasků tohoto schématu
      And všechny její hodnoty jsou odstraněny

    Scenario: Zrušení odstranění property
      Given uživatel vidí potvrzovací dialog pro odstranění property
      When odstranění zruší
      Then property zůstane součástí schématu
      And všechny její hodnoty zůstanou nezměněné

    Scenario: Odstranění property bez hodnot
      Given property je `Empty` ve všech tascích daného schématu
      When uživatel zahájí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog zobrazí počet 0 tasků s neprázdnou hodnotou
```

---

## J. Explicitní hypotézy

### H1. Produktové limity

Konkrétní seznam podporovaných typů souborů a maximální velikost souboru budou definovány jako společná produktová pravidla mimo tuto specifikaci.

### H2. Platnost externího odkazu

Při přidání se ověřuje syntaktická platnost a podporovaný formát odkazu. Trvalá dostupnost cílového obsahu není garantována.

### H3. Náhled médií

Interní náhled je poskytován pouze pro podporované formáty. Absence náhledu není důvodem k odmítnutí jinak podporovaného souboru.

### H4. Nezávislost hodnot po duplikaci

Po duplikaci včetně hodnot se obě properties z pohledu uživatele chovají nezávisle. Odstranění hodnoty z jedné property nesmí odstranit její výskyt z druhé property.

### H5. Název duplikované property

Systém novou property automaticky odliší od původní podle společného pravidla pro pojmenování duplikovaných properties. Přesná podoba názvu není součástí této specifikace.

Specifikace dosáhla úrovně **GOLD** a nevyžaduje další business rozhodnutí pro implementační handoff.
