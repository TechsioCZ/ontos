# Multi-select property – finální GOLD business specifikace

## A. Executive summary

Multi-select je property sdíleného taskového schématu, která umožňuje přiřadit jednomu tasku žádnou, jednu nebo více možností.

Definice property, její katalog možností a konfigurace jsou společné pro všechny tasky používající stejné schéma. Každý task má vlastní hodnotu představovanou množinou vybraných možností.

Vytvoření, úprava nebo odstranění konfigurace property se proto může projevit ve všech taskech stejného schématu. Duplikace naopak vytváří novou samostatnou property, která se po vytvoření vyvíjí nezávisle.

Multi-select zároveň podporuje filtrování tasků podle:

- přítomnosti konkrétní možnosti,
- nepřítomnosti konkrétní možnosti,
- prázdné hodnoty,
- neprázdné hodnoty.

---

## B. Business cíl

Umožnit uživatelům jednotně klasifikovat tasky pomocí více štítků z předem definovaného katalogu, například:

- `Frontend`
- `Backend`
- `Bug`
- `Feature`
- `Customer request`

Řešení musí podporovat konzistentní používání stejných možností napříč všemi tasky jednoho schématu a následné vyhledávání tasků podle těchto hodnot.

---

## C. Aktéři

### Editor tasku

Uživatel, který může:

- měnit hodnotu Multi-select property na konkrétním tasku,
- vytvářet nové možnosti,
- spravovat konfiguraci property,
- duplikovat property,
- odstranit property ze schématu,
- filtrovat tasky podle hodnot Multi-select property.

Rozdíly v oprávněních mezi uživateli nejsou součástí této specifikace.

---

## D. Scope

Součástí řešení je:

1. vytvoření Multi-select property,
2. zpřístupnění property všem taskům stejného schématu,
3. prázdný výchozí stav hodnoty,
4. výběr žádné, jedné nebo více možností,
5. odebrání vybraných možností,
6. vytvoření nové možnosti,
7. validace názvu možnosti,
8. přejmenování možnosti,
9. změna barvy možnosti,
10. změna pořadí možností,
11. odstranění možnosti,
12. odstranění celé property,
13. duplikace property,
14. volitelné kopírování hodnot při duplikaci,
15. nezávislost původní a duplikované property,
16. filtrování pomocí operátorů:

- `Contains`,
- `Does not contain`,
- `Is empty`,
- `Is not empty`.

---

## E. Mimo scope

Tato specifikace neřeší:

- obecné logické skládání více filtrů,
- seskupování filtrů pomocí AND/OR,
- řazení tasků,
- seskupování tasků,
- hromadné úpravy hodnot,
- automatizace,
- oprávnění a role,
- import a export,
- API,
- historii změn a audit log,
- obnovu odstraněné property nebo možnosti.

---

## F. Business pravidla

### F1. Sdílení property přes schéma

1. Multi-select property je součástí sdíleného schématu tasků.
2. Vytvořením property se property zpřístupní všem taskům používajícím dané schéma.
3. Existující tasky získají novou property ve stavu `Empty`.
4. Nové tasky používající stejné schéma mají property rovněž ve stavu `Empty`, dokud jim uživatel nenastaví hodnotu.
5. Hodnota property je pro každý task samostatná.

---

### F2. Hodnota Multi-select property

1. Hodnota obsahuje nula až více vybraných možností.
2. Prázdná hodnota je platná.
3. Jedna možnost může být na jednom tasku vybrána nejvýše jednou.
4. Výběr další možnosti zachová všechny dříve vybrané možnosti.
5. Odebrání jedné možnosti neovlivní ostatní vybrané možnosti.
6. Odebráním poslední možnosti přejde property do stavu `Empty`.

---

### F3. Katalog možností

1. Každá Multi-select property má vlastní katalog možností.
2. Katalog je součástí sdílené konfigurace property.
3. Stejný katalog používají všechny tasky daného schématu.
4. Jedna možnost obsahuje minimálně:
   - název,
   - barvu,
   - pořadí.
5. Možnosti jedné Multi-select property nejsou sdíleny s jinou Multi-select property.

---

### F4. Vytvoření možnosti

1. Uživatel může vytvořit novou možnost při úpravě hodnoty property.
2. Nově vytvořená možnost se přidá do sdíleného katalogu property.
3. Nová možnost je dostupná ve všech taskech používajících schéma.
4. Nová možnost se zároveň vybere na aktuálním tasku.
5. Nová možnost dostane automaticky přidělenou barvu.
6. Barvu lze následně změnit.
7. Vytvořením možnosti se tato možnost automaticky nepřiřadí ostatním taskům.

---

### F5. Validace názvu možnosti

1. Název možnosti je povinný.
2. Mezery na začátku a konci se před uložením odstraní.
3. Název obsahující pouze mezery je neplatný.
4. Názvy musí být v rámci jedné property unikátní bez rozlišení velikosti písmen.
5. `Backend` a `backend` jsou považovány za stejný název.
6. Název nesmí obsahovat čárku.
7. Neplatná možnost se nevytvoří ani neuloží.

---

### F6. Přejmenování možnosti

1. Přejmenování možnosti mění její název ve všech taskech.
2. Přejmenování nezruší existující přiřazení možnosti.
3. Tasky, které možnost používaly před přejmenováním, používají stejnou možnost i po přejmenování.
4. Nový název musí splnit stejná validační pravidla jako název nové možnosti.

---

### F7. Změna barvy a pořadí

1. Změna barvy možnosti se projeví ve všech taskech.
2. Změna pořadí možnosti se projeví ve sdíleném katalogu property.
3. Změna barvy ani pořadí nemění přiřazení možností k taskům.

---

### F8. Odstranění možnosti

1. Odstranění možnosti je změna sdíleného katalogu property.
2. Před odstraněním systém zobrazí potvrzovací dialog.
3. Dialog zobrazí celkový počet tasků, ve kterých je možnost aktuálně vybrána.
4. Uživatel nemusí vybírat náhradní možnost.
5. Pokud uživatel odstranění zruší:
   - možnost zůstane v katalogu,
   - hodnoty všech tasků zůstanou beze změny.
6. Pokud uživatel odstranění potvrdí:
   - možnost se odstraní z katalogu,
   - možnost se odebere ze všech tasků, ve kterých byla vybrána,
   - ostatní vybrané možnosti na těchto taskech zůstanou zachovány.
7. Task, který po odstranění možnosti nemá žádnou další vybranou možnost, přejde do stavu `Empty`.

---

### F9. Odstranění celé property

1. Odstranění property zobrazené na jednom tasku znamená odstranění property ze sdíleného schématu.
2. Property se následně odstraní ze všech tasků používajících dané schéma.
3. Spolu s property se odstraní:
   - její konfigurace,
   - katalog možností,
   - všechny hodnoty uložené na taskech.
4. Před odstraněním systém vždy zobrazí potvrzovací dialog.
5. Dialog musí jednoznačně uvést, že property bude odstraněna ze všech tasků stejného schématu.
6. Pokud uživatel odstranění zruší, nedojde k žádné změně.
7. Pokud uživatel odstranění potvrdí, property již není dostupná na žádném tasku používajícím schéma.

---

### F10. Duplikace property

1. Duplikací vznikne nová samostatná Multi-select property.
2. Nová property převezme konfiguraci původní property, zejména:
   - katalog možností,
   - názvy možností,
   - barvy možností,
   - pořadí možností.
3. Možnosti duplikované property jsou samostatné kopie možností původní property.
4. Při každé duplikaci se systém zeptá, zda chce uživatel zkopírovat také hodnoty.
5. Uživatel může:
   - zkopírovat konfiguraci i hodnoty,
   - zkopírovat pouze konfiguraci.

---

### F11. Duplikace s hodnotami

Pokud uživatel zvolí kopírování hodnot:

1. nová property se přidá do stejného sdíleného schématu,
2. vytvoří se samostatné kopie všech možností,
3. pro každý existující task se zkopíruje jeho aktuální výběr,
4. vybrané možnosti se převedou na odpovídající možnosti nové property,
5. prázdná hodnota původní property zůstane prázdná také v duplikátu,
6. změna hodnoty jednoho tasku v původní property následně neovlivňuje duplikovanou property.

---

### F12. Duplikace bez hodnot

Pokud uživatel kopírování hodnot odmítne:

1. nová property převezme konfiguraci původní property,
2. všechny existující tasky získají novou property ve stavu `Empty`,
3. původní hodnoty zůstanou beze změny.

---

### F13. Nezávislost duplikátu

Po dokončení duplikace jsou obě property nezávislé.

Pozdější změny původní property neovlivní duplikát a naopak. To zahrnuje zejména:

- přejmenování property,
- vytvoření možnosti,
- přejmenování možnosti,
- změnu barvy,
- změnu pořadí,
- odstranění možnosti,
- změnu hodnot na taskech,
- odstranění celé property.

---

### F14. Dostupné filtrovací operátory

Multi-select property podporuje právě tyto filtrovací operátory:

1. `Contains`
2. `Does not contain`
3. `Is empty`
4. `Is not empty`

Filtr vždy pracuje pouze s hodnotou zvolené Multi-select property.

---

### F15. Filtr Contains

1. Operátor `Contains` vyžaduje výběr jedné konkrétní možnosti.
2. Task odpovídá filtru, pokud má zvolenou možnost mezi svými hodnotami.
3. Task může kromě hledané možnosti obsahovat také další možnosti.
4. Task ve stavu `Empty` filtru neodpovídá.
5. Task s jinými možnostmi, ale bez hledané možnosti, filtru neodpovídá.

Příklad:

```
Labels contains Bug
```

Task odpovídá, pokud obsahuje `Bug`, například:

- `Bug`
- `Bug, Backend`
- `Frontend, Bug, Urgent`

---

### F16. Filtr Does not contain

1. Operátor `Does not contain` vyžaduje výběr jedné konkrétní možnosti.
2. Task odpovídá filtru, pokud zvolenou možnost nemá mezi svými hodnotami.
3. Task může obsahovat jiné možnosti.
4. Task ve stavu `Empty` filtru odpovídá.
5. Task neodpovídá filtru, pokud hledanou možnost obsahuje, bez ohledu na další vybrané možnosti.

Příklad:

```
Labels does not contain Bug
```

Task odpovídá, pokud obsahuje například:

- `Backend`
- `Frontend, Urgent`
- `Empty`

---

### F17. Filtr Is empty

1. Operátor `Is empty` nevyžaduje výběr konkrétní možnosti.
2. Task odpovídá filtru právě tehdy, když nemá vybranou žádnou možnost.
3. Task s alespoň jednou vybranou možností filtru neodpovídá.

---

### F18. Filtr Is not empty

1. Operátor `Is not empty` nevyžaduje výběr konkrétní možnosti.
2. Task odpovídá filtru právě tehdy, když má vybranou alespoň jednu možnost.
3. Task ve stavu `Empty` filtru neodpovídá.

---

### F19. Výběr hodnoty filtru

1. Operátory `Contains` a `Does not contain` vyžadují výběr jedné možnosti.
2. Možnost se vybírá pouze z aktuálního katalogu filtrované property.
3. Operátory `Is empty` a `Is not empty` výběr možnosti nevyžadují.
4. Filtr `Contains` nebo `Does not contain` bez vybrané možnosti není kompletní a nelze jej aplikovat.
5. Stejnojmenná možnost jiné Multi-select property se při vyhodnocení filtru nepoužije.

---

## G. Klíčové výjimky a hraniční situace

1. Property může zůstat prázdná.
2. Task může mít vybrány všechny dostupné možnosti.
3. Stejnou možnost nelze na jednom tasku vybrat vícekrát.
4. Odstranění jedné z více vybraných možností zachová ostatní možnosti.
5. Odstranění poslední vybrané možnosti nastaví hodnotu na `Empty`.
6. Přejmenování možnosti nesmí vytvořit duplicitní název.
7. Při odstranění používané možnosti není povinná náhradní možnost.
8. Duplikace bez hodnot musí zachovat všechny původní hodnoty a vytvořit prázdný duplikát.
9. Duplikace s hodnotami musí zachovat rozdílné výběry jednotlivých tasků.
10. Odstranění původní property nesmí odstranit její dříve vytvořený duplikát.
11. Odstranění duplikátu nesmí ovlivnit původní property.
12. Task ve stavu `Empty` neodpovídá filtru `Contains`.
13. Task ve stavu `Empty` odpovídá filtru `Does not contain`.
14. `Is empty` znamená přesně nula vybraných možností.
15. `Is not empty` znamená jednu nebo více vybraných možností.
16. `Does not contain X` nevylučuje task jen proto, že obsahuje jiné možnosti.
17. Filtr vyžadující konkrétní možnost nelze aplikovat bez jejího výběru.

---

## H. Akceptační kritéria

1. Po vytvoření Multi-select property ji vidí všechny tasky stejného schématu.
2. Všechny existující tasky mají novou property ve stavu `Empty`.
3. Uživatel může na jednom tasku vybrat více možností.
4. Stejnou možnost nelze vybrat dvakrát.
5. Nová možnost se přidá do sdíleného katalogu, ale automaticky se vybere pouze na aktuálním tasku.
6. Přejmenování nebo změna barvy možnosti se projeví ve všech taskech.
7. Přejmenování možnosti nezruší její existující použití.
8. Před odstraněním možnosti systém zobrazí počet tasků, které ji používají.
9. Potvrzené odstranění možnosti ji odebere ze všech dotčených tasků.
10. Zrušené odstranění možnosti nezmění katalog ani hodnoty.
11. Před odstraněním celé property systém upozorní na odstranění ze všech tasků stejného schématu.
12. Potvrzené odstranění property odstraní konfiguraci i všechny hodnoty.
13. Duplikace vždy vytvoří samostatnou property.
14. Při duplikaci systém vždy nabídne volbu kopírování hodnot.
15. Duplikace s hodnotami zachová odpovídající hodnoty všech existujících tasků.
16. Duplikace bez hodnot vytvoří na všech taskech stav `Empty`.
17. Pozdější změna původní property neovlivní duplikát.
18. Pozdější změna duplikátu neovlivní původní property.
19. Filtr nabízí operátory:
    - `Contains`,
    - `Does not contain`,
    - `Is empty`,
    - `Is not empty`.
20. `Contains` vrátí všechny tasky obsahující zvolenou možnost bez ohledu na další vybrané možnosti.
21. `Does not contain` vrátí tasky bez zvolené možnosti, včetně prázdných hodnot.
22. `Is empty` vrátí pouze tasky bez vybrané možnosti.
23. `Is not empty` vrátí pouze tasky s alespoň jednou vybranou možností.
24. U operátorů pracujících s konkrétní možností lze vybírat pouze z katalogu filtrované property.
25. U operátorů kontrolujících prázdnost se výběr možnosti nevyžaduje.
26. Neúplný filtr `Contains` nebo `Does not contain` bez zvolené možnosti nelze aplikovat.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Multi-select property ve sdíleném taskovém schématu

  Uživatel potřebuje klasifikovat tasky pomocí více možností
  ze společného katalogu definovaného ve schématu
  a následně podle těchto hodnot tasky filtrovat.

  Rule: Property je sdílena všemi tasky stejného schématu

    Scenario: Vytvoření Multi-select property
      Given schéma používá několik existujících tasků
      And schéma zatím neobsahuje property "Labels"
      When uživatel vytvoří Multi-select property "Labels"
      Then property "Labels" je součástí schématu
      And property "Labels" je dostupná na všech taskech používajících schéma
      And hodnota property "Labels" je na všech existujících taskech Empty

    Scenario: Nový task získá property ze schématu
      Given schéma obsahuje Multi-select property "Labels"
      When vznikne nový task používající toto schéma
      Then nový task obsahuje property "Labels"
      And hodnota property "Labels" je Empty

  Rule: Jeden task může obsahovat více vybraných možností

    Scenario: Výběr více možností
      Given katalog property "Labels" obsahuje možnosti "Backend" a "Bug"
      And task má vybranou možnost "Backend"
      When uživatel vybere možnost "Bug"
      Then task má vybrány možnosti "Backend" a "Bug"

    Scenario: Stejnou možnost nelze vybrat vícekrát
      Given task má vybranou možnost "Backend"
      When uživatel znovu pracuje s výběrem možností
      Then možnost "Backend" nelze přidat jako další výskyt
      And task obsahuje právě jeden výskyt možnosti "Backend"

    Scenario: Odebrání jedné z více možností
      Given task má vybrány možnosti "Backend" a "Bug"
      When uživatel odebere možnost "Backend"
      Then task má vybranou možnost "Bug"
      And task nemá vybranou možnost "Backend"

    Scenario: Odebrání poslední možnosti
      Given task má vybranou pouze možnost "Backend"
      When uživatel odebere možnost "Backend"
      Then hodnota property je Empty

  Rule: Katalog možností je sdílený v rámci property

    Scenario: Vytvoření nové možnosti
      Given katalog property "Labels" neobsahuje možnost "Research"
      When uživatel vytvoří možnost "Research" při úpravě Tasku A
      Then katalog property obsahuje možnost "Research"
      And možnost "Research" je dostupná také na ostatních taskech stejného schématu
      And možnost "Research" je vybrána na Tasku A
      And možnost "Research" není automaticky vybrána na ostatních taskech

    Scenario: Přejmenování používané možnosti
      Given možnost "FE" je vybrána na několika taskech
      When uživatel přejmenuje možnost "FE" na "Frontend"
      Then katalog obsahuje možnost "Frontend"
      And katalog již neobsahuje název "FE"
      And možnost zůstává vybrána na všech původních taskech pod názvem "Frontend"

    Scenario: Změna barvy možnosti
      Given možnost "Bug" je používána na několika taskech
      When uživatel změní barvu možnosti "Bug"
      Then nová barva se projeví na všech taskech používajících možnost "Bug"
      And přiřazení možnosti k taskům se nezmění

    Scenario: Změna pořadí možností
      Given možnosti jsou seřazeny jako "Frontend", "Backend", "Bug"
      When uživatel přesune možnost "Bug" před možnost "Frontend"
      Then pořadí možností je "Bug", "Frontend", "Backend"
      And přiřazení možností k taskům se nezmění

  Rule: Názvy možností musí být platné a unikátní

    Scenario: Odmítnutí prázdného názvu
      When uživatel zadá jako název nové možnosti pouze mezery
      Then možnost nevznikne
      And systém oznámí, že název je povinný

    Scenario: Odmítnutí názvu obsahujícího čárku
      When uživatel zadá název "Backend, API"
      Then možnost nevznikne
      And systém oznámí, že název nesmí obsahovat čárku

    Scenario: Odmítnutí duplicitního názvu bez ohledu na velikost písmen
      Given katalog obsahuje možnost "Backend"
      When uživatel vytvoří možnost "backend"
      Then nová možnost nevznikne
      And katalog nadále obsahuje právě jednu odpovídající možnost

    Scenario: Normalizace okrajových mezer
      Given katalog neobsahuje možnost "Research"
      When uživatel vytvoří možnost s názvem "  Research  "
      Then vznikne možnost s názvem "Research"

    Scenario: Odmítnutí duplicitního názvu při přejmenování
      Given katalog obsahuje možnosti "Frontend" a "Backend"
      When uživatel přejmenuje možnost "Backend" na "frontend"
      Then přejmenování není provedeno
      And katalog nadále obsahuje možnosti "Frontend" a "Backend"

  Rule: Odstranění možnosti ovlivňuje všechny tasky

    Scenario: Zahájení odstranění používané možnosti
      Given možnost "Bug" je vybrána na 12 taskech
      When uživatel zahájí odstranění možnosti "Bug"
      Then systém zobrazí potvrzovací dialog
      And dialog informuje, že možnost používá 12 tasků
      And dialog nevyžaduje výběr náhradní možnosti

    Scenario: Zrušení odstranění používané možnosti
      Given uživatel vidí potvrzovací dialog pro možnost "Bug"
      When uživatel odstranění zruší
      Then možnost "Bug" zůstane v katalogu
      And možnost "Bug" zůstane vybrána na původních taskech

    Scenario: Potvrzení odstranění používané možnosti
      Given možnost "Bug" je vybrána na 12 taskech
      When uživatel potvrdí odstranění možnosti "Bug"
      Then možnost "Bug" již není součástí katalogu
      And možnost "Bug" není vybrána na žádném tasku
      And ostatní možnosti vybrané na dotčených taskech zůstanou zachovány

    Scenario: Odstranění poslední vybrané možnosti tasku
      Given task má vybranou pouze možnost "Bug"
      When uživatel potvrdí odstranění možnosti "Bug" z katalogu
      Then hodnota property na tasku je Empty

    Scenario: Odstranění nepoužívané možnosti
      Given možnost "Deprecated" není vybrána na žádném tasku
      When uživatel potvrdí odstranění možnosti "Deprecated"
      Then možnost "Deprecated" již není součástí katalogu
      And hodnoty tasků zůstanou beze změny

  Rule: Odstranění property je odstraněním ze schématu

    Scenario: Zrušení odstranění property
      Given property "Labels" je používána tasky stejného schématu
      When uživatel zahájí odstranění property z jednoho tasku
      Then systém upozorní, že property bude odstraněna ze všech tasků stejného schématu
      When uživatel odstranění zruší
      Then property "Labels" zůstane součástí schématu
      And konfigurace a hodnoty zůstanou beze změny

    Scenario: Potvrzení odstranění property
      Given property "Labels" je používána tasky stejného schématu
      When uživatel potvrdí odstranění property
      Then property "Labels" již není součástí schématu
      And property "Labels" není dostupná na žádném tasku používajícím schéma
      And katalog možností property je odstraněn
      And všechny hodnoty property jsou odstraněny

  Rule: Duplikace vytváří nezávislou property

    Scenario: Zahájení duplikace
      Given schéma obsahuje Multi-select property "Labels"
      When uživatel zahájí její duplikaci
      Then systém se zeptá, zda mají být zkopírovány také hodnoty

    Scenario: Duplikace bez kopírování hodnot
      Given property "Labels" obsahuje nakonfigurované možnosti
      And jednotlivé tasky mají rozdílné hodnoty property "Labels"
      When uživatel duplikuje property bez kopírování hodnot
      Then ve schématu vznikne nová samostatná Multi-select property
      And nová property obsahuje kopie možností, barev a pořadí
      And nová property je na všech existujících taskech Empty
      And hodnoty původní property zůstanou beze změny

    Scenario: Duplikace s kopírováním hodnot
      Given Task A má v původní property vybrány možnosti "Backend" a "Bug"
      And Task B má v původní property vybránu možnost "Frontend"
      And Task C má původní property Empty
      When uživatel duplikuje property včetně hodnot
      Then duplikovaná property Tasku A obsahuje odpovídající kopie možností "Backend" a "Bug"
      And duplikovaná property Tasku B obsahuje odpovídající kopii možnosti "Frontend"
      And duplikovaná property Tasku C je Empty

    Scenario: Pozdější změna původní property neovlivní duplikát
      Given property "Labels Copy" vznikla duplikací property "Labels"
      When uživatel přidá do property "Labels" možnost "Urgent"
      Then property "Labels Copy" možnost "Urgent" neobsahuje

    Scenario: Pozdější změna duplikátu neovlivní originál
      Given property "Labels Copy" vznikla duplikací property "Labels"
      When uživatel odstraní možnost z property "Labels Copy"
      Then odpovídající možnost v property "Labels" zůstane zachována
      And hodnoty property "Labels" na taskech zůstanou zachovány

    Scenario: Odstranění originálu neodstraní duplikát
      Given property "Labels Copy" vznikla duplikací property "Labels"
      When uživatel odstraní property "Labels"
      Then property "Labels Copy" zůstane součástí schématu
      And její konfigurace a hodnoty zůstanou zachovány

  Rule: Operátor Contains vyhledává tasky obsahující zvolenou možnost

    Scenario: Task obsahuje hledanou možnost jako jedinou hodnotu
      Given task má v property "Labels" vybranou možnost "Bug"
      When uživatel použije filtr "Labels contains Bug"
      Then task odpovídá filtru

    Scenario: Task obsahuje hledanou možnost společně s dalšími hodnotami
      Given task má v property "Labels" vybrány možnosti "Bug" a "Backend"
      When uživatel použije filtr "Labels contains Bug"
      Then task odpovídá filtru

    Scenario: Task obsahuje pouze jinou možnost
      Given task má v property "Labels" vybranou možnost "Backend"
      When uživatel použije filtr "Labels contains Bug"
      Then task neodpovídá filtru

    Scenario: Prázdná property neobsahuje hledanou možnost
      Given hodnota property "Labels" je Empty
      When uživatel použije filtr "Labels contains Bug"
      Then task neodpovídá filtru

  Rule: Operátor Does not contain vyhledává tasky bez zvolené možnosti

    Scenario: Task neobsahuje hledanou možnost
      Given task má v property "Labels" vybranou možnost "Backend"
      When uživatel použije filtr "Labels does not contain Bug"
      Then task odpovídá filtru

    Scenario: Task obsahuje hledanou možnost společně s další hodnotou
      Given task má v property "Labels" vybrány možnosti "Bug" a "Backend"
      When uživatel použije filtr "Labels does not contain Bug"
      Then task neodpovídá filtru

    Scenario: Prázdná property neobsahuje hledanou možnost
      Given hodnota property "Labels" je Empty
      When uživatel použije filtr "Labels does not contain Bug"
      Then task odpovídá filtru

  Rule: Operátory Is empty a Is not empty vyhodnocují počet vybraných možností

    Scenario: Filtrování prázdné property
      Given hodnota property "Labels" je Empty
      When uživatel použije filtr "Labels is empty"
      Then task odpovídá filtru

    Scenario: Neprázdná property neodpovídá filtru Is empty
      Given task má v property "Labels" vybranou možnost "Bug"
      When uživatel použije filtr "Labels is empty"
      Then task neodpovídá filtru

    Scenario: Filtrování neprázdné property
      Given task má v property "Labels" vybranou alespoň jednu možnost
      When uživatel použije filtr "Labels is not empty"
      Then task odpovídá filtru

    Scenario: Prázdná property neodpovídá filtru Is not empty
      Given hodnota property "Labels" je Empty
      When uživatel použije filtr "Labels is not empty"
      Then task neodpovídá filtru

  Rule: Operátor určuje potřebu výběru konkrétní možnosti

    Scenario Outline: Filtr vyžaduje konkrétní možnost
      When uživatel zvolí operátor "<operator>"
      And nevybere žádnou možnost
      Then filtr není možné aplikovat jako kompletní podmínku

      Examples:
        | operator         |
        | Contains         |
        | Does not contain |

    Scenario Outline: Filtr nevyžaduje konkrétní možnost
      When uživatel zvolí operátor "<operator>"
      Then systém nevyžaduje výběr možnosti
      And filtr lze aplikovat

      Examples:
        | operator     |
        | Is empty     |
        | Is not empty |

    Scenario: Hodnota filtru pochází pouze z katalogu filtrované property
      Given property "Labels" obsahuje možnost "Bug"
      And jiná property "Category" také obsahuje možnost "Bug"
      When uživatel nastavuje filtr pro property "Labels"
      Then vybírá možnost z katalogu property "Labels"
      And stejně pojmenovaná možnost z property "Category" se pro filtr nepoužije
```

---

## J. Explicitní hypotézy

### H1. Název duplikované property

Duplikovaná property dostane automaticky vytvořený unikátní název odvozený od názvu původní property, například:

```
Labels copy
```

Přesný text přípony je produktové rozhodnutí a nemění základní business chování.

### H2. Pořadí zobrazených hodnot

Vybrané možnosti se na tasku zobrazují podle pořadí definovaného ve sdíleném katalogu, nikoliv podle času jejich výběru.

### H3. Počet tasků v dialogu pro odstranění možnosti

Počet zahrnuje tasky, ve kterých je daná možnost aktuálně vybrána. Jeden task se započítá nejvýše jednou.

### H4. Automatické přidělení barvy

Systém vybere nově vytvořené možnosti jednu z podporovaných barev. Konkrétní algoritmus výběru barvy není součástí business specifikace.

### H5. Jedna možnost na jednu filtrovací podmínku

Jeden filtr `Contains` nebo `Does not contain` pracuje právě s jednou možností.

Filtrování podle více možností se řeší více samostatnými filtrovacími podmínkami. Jejich spojování pomocí AND/OR patří do obecné specifikace filtrovacího systému.
