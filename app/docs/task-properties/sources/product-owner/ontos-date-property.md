# Readiness score: GOLD

Specifikace nyní jednoznačně určuje sdílené schéma, chování hodnoty, date picker, ruční zadání, duplikaci i dopad smazání. Je dostatečně přesná a testovatelná pro handoff coding agents.

## A. Executive summary

Property **Date** umožňuje uložit u každého tasku právě jedno kalendářní datum nebo stav `Empty`.

Property je součástí sdíleného schématu. Její vytvoření, duplikace nebo odstranění proto ovlivňuje všechny tasky používající dané schéma, zatímco konkrétní hodnota data patří vždy jednotlivému tasku.

Datum lze:

- vybrat z kalendáře,
- zadat ručně,
- nastavit na dnešní den,
- změnit,
- nebo odstranit.

Date Range, čas a připomínky nejsou podporovány.

---

## B. Business cíl

Umožnit uživatelům přidávat k taskům obecné datum, například „Termín“, „Datum kontroly“ nebo „Datum publikace“, bez nutnosti používat rozsah nebo časovou složku.

Význam property určuje její název, nikoliv speciální systémové chování.

---

## C. Aktéři

### Uživatel upravující task

Může:

- zobrazit Date property,
- zadat, změnit nebo odstranit její hodnotu.

### Uživatel upravující sdílené schéma

Může:

- vytvořit Date property,
- přejmenovat ji,
- duplikovat ji,
- odstranit ji ze sdíleného schématu.

---

## D. Scope

- vytvoření Date property ve sdíleném schématu,
- automatické přidání property ke všem taskům používajícím schéma,
- stav `Empty`,
- zadání jednoho data,
- ruční zápis data,
- výběr data z kalendáře,
- navigace mezi měsíci,
- akce `Today`,
- změna a odstranění hodnoty,
- duplikace s volitelným kopírováním hodnot,
- odstranění property s potvrzovacím dialogem,
- zobrazení počtu hodnot ve stavu `Is not empty`.

---

## E. Mimo scope

- Date Range,
- počáteční a koncové datum,
- čas,
- časová pásma,
- připomínky a notifikace,
- opakovaná data,
- automatické nastavování data,
- speciální chování due date,
- zvýraznění prošlých termínů,
- filtrování a řazení,
- kalendářové nebo timeline pohledy,
- technická architektura a API.

---

## F. Business pravidla

### F1. Sdílené schéma

1. Date property je součástí sdíleného schématu tasků.
2. Po vytvoření je dostupná u všech tasků používajících toto schéma.
3. U všech existujících tasků má nová property hodnotu `Empty`.
4. Nově vytvořený task používající dané schéma obsahuje property také ve stavu `Empty`.
5. Hodnota property se spravuje samostatně pro každý task.
6. Změna hodnoty jednoho tasku neovlivní ostatní tasky.

### F2. Hodnota Date property

1. Property může obsahovat právě jedno kalendářní datum nebo stav `Empty`.
2. Datum neobsahuje čas.
3. Datum neobsahuje časové pásmo.
4. Minulé, dnešní i budoucí platné datum je povoleno.
5. Date Range není možné zapnout ani zadat.
6. Význam data určuje název property.

### F3. Date picker

1. Otevřený date picker obsahuje:

- editovatelné pole s datem,
- označení zobrazeného měsíce a roku,
- akci `Today`,
- navigaci na předchozí měsíc,
- navigaci na následující měsíc,
- názvy dnů v týdnu,
- kalendářní mřížku,
- vizuální označení zvoleného data.

1. U property ve stavu `Empty` se otevře aktuální měsíc.
2. U vyplněné property se otevře měsíc obsahující uložené datum.
3. Navigace mezi měsíci sama o sobě nemění hodnotu property.
4. Výběr dne nahradí případné původní datum.
5. Výběr dne sousedního měsíce zobrazeného v mřížce nastaví odpovídající datum.
6. Akce `Today` nastaví aktuální kalendářní datum.

### F4. Ruční zadání

1. Pole v horní části date pickeru je editovatelné.
2. Uživatel může zadat datum bez použití kalendářní mřížky.
3. Systém přijme pouze platné existující kalendářní datum.
4. Po potvrzení platného vstupu je ručně zadané datum uloženo.
5. Neplatný vstup není uložen.
6. Pokud property před neplatným vstupem obsahovala hodnotu, tato hodnota zůstane nezměněná.
7. Formát zadání a zobrazení se řídí aktivní lokalizací produktu.

### F5. Odstranění hodnoty

1. Uživatel může odstranit datum z konkrétního tasku.
2. Odstraněním hodnoty přejde property do stavu `Empty`.
3. Samotná property zůstane součástí schématu.
4. Hodnoty ostatních tasků zůstanou nezměněné.
5. Odstranění hodnoty nevyžaduje potvrzovací dialog určený pro odstranění celé property.

### F6. Duplikace

1. Duplikací vznikne nová samostatná Date property.
2. Nová property převezme konfiguraci původní property.
3. Při každé duplikaci systém zobrazí volbu, zda mají být zkopírovány také hodnoty.
4. Při duplikaci včetně hodnot se pro každý existující task zkopíruje jeho aktuální hodnota.
5. Stav `Empty` se zkopíruje jako `Empty`.
6. Při duplikaci bez hodnot je nová property u všech existujících tasků `Empty`.
7. Původní a duplikovaná property mají samostatnou identitu.
8. Pozdější změna konfigurace jedné property neovlivní druhou.
9. Pozdější změna hodnoty jedné property neovlivní druhou.

### F7. Odstranění property

1. Odstranění property z libovolného tasku znamená odstranění property ze sdíleného schématu.
2. Property bude odstraněna ze všech tasků používajících dané schéma.
3. Spolu s property budou odstraněny všechny její hodnoty.
4. Systém před odstraněním vždy zobrazí potvrzovací dialog.
5. Dialog se zobrazí i tehdy, když žádný task nemá vyplněnou hodnotu.
6. Dialog zobrazí počet tasků, u kterých je hodnota property `Is not empty`.
7. Do počtu se nezahrnují tasky, u kterých je property `Empty`.
8. Dialog upozorní, že property bude odstraněna ze všech tasků používajících schéma.
9. Potvrzení provede odstranění property a jejích hodnot.
10. Zrušení dialogu nezmění schéma ani hodnoty.

---

## G. Klíčové výjimky a hraniční situace

- Datum 29. února je platné pouze v přestupném roce.
- Neexistující datum, například 31. dubna, nelze uložit.
- Pouhá navigace v kalendáři nesmí přepsat uloženou hodnotu.
- Dnešní den nesmí být automaticky uložen pouze proto, že uživatel otevřel prázdnou property.
- Odstranění hodnoty jednoho tasku nesmí odstranit property ze schématu.
- Dialog pro odstranění property se zobrazí i při počtu `Is not empty = 0`.
- Počet v dialogu vyjadřuje vyplněné hodnoty, nikoliv celkový počet tasků používajících schéma.
- Při kopírování hodnot během duplikace se kopíruje stav každého tasku samostatně.
- Duplikát nesmí zůstat propojený s původní property.

---

## H. Akceptační kritéria

1. Date property je po vytvoření dostupná ve všech tascích daného schématu.
2. Existující i nové tasky mají počáteční hodnotu `Empty`.
3. U každého tasku lze uložit nejvýše jedno datum.
4. Datum lze vybrat z kalendáře i zadat ručně.
5. Akce `Today` nastaví dnešní datum.
6. Neplatné kalendářní datum nelze uložit.
7. Date Range ani čas nelze zadat.
8. Hodnotu lze odstranit bez odstranění samotné property.
9. Změna hodnoty jednoho tasku neovlivní ostatní tasky.
10. Duplikace vždy nabídne volbu kopírování hodnot.
11. Duplikace včetně hodnot zachová data i stavy `Empty`.
12. Duplikace bez hodnot vytvoří u všech tasků hodnotu `Empty`.
13. Původní property a duplikát jsou po vytvoření nezávislé.
14. Odstranění property vždy vyžaduje potvrzení.
15. Potvrzovací dialog ukazuje počet tasků s hodnotou `Is not empty`.
16. Potvrzené odstranění smaže property ze všech tasků používajících schéma.
17. Zrušení odstranění nezmění property ani její hodnoty.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Date property ve sdíleném schématu tasků

  Date property umožňuje uložit u každého tasku jedno kalendářní
  datum bez času a bez rozsahu.

  Rule: Date property je součástí sdíleného schématu

    Scenario: Vytvoření Date property
      Given sdílené schéma používá několik existujících tasků
      When uživatel vytvoří property typu Date s názvem "Datum kontroly"
      Then property "Datum kontroly" je přidána do sdíleného schématu
      And je dostupná u všech tasků používajících toto schéma
      And její hodnota je u všech existujících tasků Empty

    Scenario: Vytvoření nového tasku
      Given sdílené schéma obsahuje Date property "Datum kontroly"
      When uživatel vytvoří nový task používající toto schéma
      Then nový task obsahuje property "Datum kontroly"
      And její hodnota je Empty

    Scenario: Hodnota je samostatná pro každý task
      Given dva tasky používají stejné sdílené schéma
      And jejich Date property je Empty
      When uživatel nastaví datum pouze u prvního tasku
      Then první task obsahuje nastavené datum
      And Date property druhého tasku zůstává Empty

  Rule: Date property obsahuje jedno datum nebo stav Empty

    Scenario: Výběr data z kalendáře
      Given Date property "Datum kontroly" je Empty
      When uživatel vybere 13. července 2026
      Then property obsahuje datum 13. července 2026
      And property neobsahuje čas
      And property neobsahuje koncové datum

    Scenario: Nahrazení existujícího data
      Given Date property obsahuje datum 13. července 2026
      When uživatel vybere datum 20. července 2026
      Then property obsahuje datum 20. července 2026
      And datum 13. července 2026 již není její hodnotou

    Scenario: Nastavení dnešního data
      Given uživatel upravuje Date property
      When použije akci Today
      Then property obsahuje aktuální kalendářní datum

    Scenario: Povolení minulého data
      Given task obsahuje Date property
      When uživatel nastaví platné datum v minulosti
      Then systém datum uloží

    Scenario: Povolení budoucího data
      Given task obsahuje Date property
      When uživatel nastaví platné datum v budoucnosti
      Then systém datum uloží

  Rule: Date picker umožňuje výběr a navigaci

    Scenario: Otevření prázdné Date property
      Given Date property je Empty
      When uživatel otevře date picker
      Then date picker zobrazí aktuální měsíc
      And obsahuje akci Today
      And dnešní datum není automaticky uloženo

    Scenario: Otevření property s existujícím datem
      Given Date property obsahuje datum 13. července 2026
      When uživatel otevře date picker
      Then date picker zobrazí červenec 2026
      And datum 13. července 2026 je označeno jako vybrané

    Scenario: Navigace mezi měsíci bez změny hodnoty
      Given Date property obsahuje datum 13. července 2026
      And date picker zobrazuje červenec 2026
      When uživatel přejde na srpen 2026
      And nevybere žádný den
      Then hodnota property zůstává 13. července 2026

    Scenario: Výběr dne sousedního měsíce
      Given date picker zobrazuje červenec 2026
      And v kalendářní mřížce je zobrazen 1. srpen 2026
      When uživatel vybere 1. srpen 2026
      Then property obsahuje datum 1. srpna 2026

  Rule: Datum lze zadat ručně

    Scenario: Ruční zadání platného data
      Given task obsahuje Date property
      When uživatel ručně zadá platné datum
      And zadání potvrdí
      Then systém zadané datum uloží

    Scenario: Ruční zadání neexistujícího data
      Given Date property obsahuje datum 13. července 2026
      When uživatel ručně zadá neexistující kalendářní datum
      And zadání potvrdí
      Then systém neplatné datum neuloží
      And hodnota property zůstává 13. července 2026

    Scenario: Zadání přestupného dne v přestupném roce
      Given task obsahuje Date property
      When uživatel zadá 29. února 2028
      Then systém datum přijme
      And uloží datum 29. února 2028

    Scenario: Zadání přestupného dne mimo přestupný rok
      Given task obsahuje Date property
      When uživatel zadá 29. února 2027
      Then systém datum neuloží

  Rule: Hodnotu lze odstranit samostatně

    Scenario: Odstranění hodnoty Date property
      Given Date property obsahuje datum
      When uživatel odstraní její hodnotu
      Then property zůstane součástí sdíleného schématu
      And její hodnota u daného tasku je Empty
      And hodnoty ostatních tasků zůstanou nezměněné

  Rule: Date Range a čas nejsou podporovány

    Scenario: Zadání pouze jednoho data
      Given uživatel nastavuje hodnotu Date property
      When zadává datum
      Then může zadat právě jeden kalendářní den
      And nemůže zadat koncové datum
      And nemůže zadat čas

  Rule: Date property lze duplikovat

    Scenario: Zahájení duplikace
      Given schéma obsahuje Date property
      When uživatel zahájí její duplikaci
      Then systém se zeptá, zda mají být zkopírovány také hodnoty

    Scenario: Duplikace včetně hodnot
      Given původní Date property obsahuje u jednotlivých tasků data nebo stav Empty
      When uživatel zvolí duplikaci včetně hodnot
      Then vznikne nová samostatná Date property
      And u každého existujícího tasku převezme hodnotu původní property
      And stav Empty se zkopíruje jako Empty

    Scenario: Duplikace bez hodnot
      Given původní Date property obsahuje u některých tasků datum
      When uživatel zvolí duplikaci bez hodnot
      Then vznikne nová samostatná Date property
      And její hodnota je u všech existujících tasků Empty

    Scenario: Nezávislost duplikovaných properties
      Given Date property byla duplikována
      When uživatel změní konfiguraci nebo hodnotu původní property
      Then duplikovaná property zůstane nezměněná
      When uživatel následně změní konfiguraci nebo hodnotu duplikované property
      Then původní property zůstane nezměněná

  Rule: Odstranění property ovlivňuje celé sdílené schéma

    Scenario: Zobrazení potvrzovacího dialogu s vyplněnými hodnotami
      Given schéma obsahuje Date property
      And 7 tasků má hodnotu property Is not empty
      When uživatel požádá o odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog uvede, že 7 tasků má hodnotu Is not empty
      And dialog upozorní, že property bude odstraněna ze všech tasků používajících schéma

    Scenario: Zobrazení dialogu bez vyplněných hodnot
      Given schéma obsahuje Date property
      And žádný task nemá hodnotu property Is not empty
      When uživatel požádá o odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog uvede počet Is not empty jako 0

    Scenario: Potvrzení odstranění property
      Given uživatel má otevřený potvrzovací dialog pro odstranění Date property
      When odstranění potvrdí
      Then property je odstraněna ze sdíleného schématu
      And property již není dostupná u žádného tasku používajícího schéma
      And všechny její dřívější hodnoty jsou odstraněny

    Scenario: Zrušení odstranění property
      Given uživatel má otevřený potvrzovací dialog pro odstranění Date property
      When odstranění zruší
      Then property zůstane ve sdíleném schématu
      And všechny její hodnoty zůstanou nezměněné
```

---

## J. Explicitní hypotézy

1. Formát ručního zadávání a zobrazení data se řídí aktivní lokalizací produktu a není konfigurovatelný pro jednotlivou property.
2. Název duplikované property se vytváří podle společného pravidla pro duplikaci properties v systému; konkrétní pojmenování není součástí specifikace Date property.
3. Automatické zavření date pickeru po výběru data je prezentační chování a není podmínkou business akceptace.
