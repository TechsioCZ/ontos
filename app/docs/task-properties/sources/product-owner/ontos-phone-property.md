# Phone property — finální business specifikace

## A. Executive summary

Property `Phone` umožňuje evidovat u tasku jednu nepovinnou telefonní hodnotu. Hodnota se ukládá jako text bez kontroly platnosti nebo vynucování konkrétního telefonního formátu.

Uživatel může hodnotu zadat, vložit, upravit, odstranit a zkopírovat. Aktivací vyplněné hodnoty požádá systém zařízení uživatele o zahájení telefonního hovoru. Pokud zařízení volání nepodporuje, aplikace nezobrazí chybu a hodnota zůstane dostupná ke zkopírování.

Toto chování odpovídá základnímu modelu Notion: Phone přijímá hodnotu psaním nebo vložením podobně jako textová property a nevynucuje formát telefonního čísla.

---

## B. Business cíl

Umožnit uživateli evidovat telefonní kontakt přímo u tasku a rychle jej použít pro zahájení hovoru, aniž by systém omezoval různé národní formáty, interní linky nebo uživatelské formátování.

---

## C. Aktéři

### Uživatel s oprávněním upravovat task

Může:

- zadat a upravit hodnotu Phone,
- odstranit hodnotu,
- zkopírovat hodnotu,
- aktivovat hodnotu pro zahájení hovoru.

### Uživatel s oprávněním spravovat schéma tasků

Může:

- vytvořit Phone property,
- přejmenovat Phone property,
- duplikovat Phone property,
- odstranit Phone property ze sdíleného schématu.

---

## D. Scope

- vytvoření property typu `Phone`,
- zobrazení property ve všech tascích používajících dané schéma,
- jedna nepovinná hodnota na jeden task,
- ruční zadání hodnoty,
- vložení hodnoty ze schránky,
- úprava hodnoty,
- vymazání hodnoty,
- kopírování hodnoty,
- aktivace hodnoty pro zahájení hovoru,
- chování na zařízení bez podpory volání,
- přejmenování property,
- duplikace property s volbou kopírování hodnot,
- odstranění property ze sdíleného schématu.

---

## E. Mimo scope

- ověřování existence nebo dosažitelnosti telefonního čísla,
- kontrola národního nebo mezinárodního formátu,
- automatické doplňování předvolby,
- automatické přeformátování nebo normalizace hodnoty,
- rozdělení čísla na předvolbu, hlavní číslo a linku,
- ukládání více čísel do jedné Phone property,
- odesílání SMS nebo zpráv,
- historie uskutečněných hovorů,
- správa kontaktů,
- automatické zahájení hovoru bez systémové akce zařízení,
- filtrování, řazení a seskupování podle Phone property,
- technické chování konkrétních operačních systémů,
- oprávnění a role mimo obecnou správu tasku a schématu.

---

## F. Business pravidla

### BR-01: Sdílené schéma

Phone property je součástí sdíleného schématu tasků.

Po vytvoření je property dostupná u všech tasků používajících dané schéma. Existující tasky mají novou property ve stavu `Empty`.

### BR-02: Jedna hodnota

Jeden task může mít v jedné Phone property nejvýše jednu hodnotu.

Pro evidenci více telefonních čísel musí být vytvořeno více samostatných Phone properties.

### BR-03: Nepovinná hodnota

Phone property může zůstat ve stavu `Empty`.

Prázdná hodnota nebrání vytvoření, úpravě ani jinému zpracování tasku.

### BR-04: Textová reprezentace

Hodnota Phone se ukládá jako textový řetězec, nikoliv jako číselná hodnota.

Může proto obsahovat například:

- číslice,
- znak `+`,
- mezery,
- pomlčky,
- závorky,
- lomítka,
- text interní linky,
- další uživatelem zadané znaky.

Notion rovněž reprezentuje Phone jako řetězcovou hodnotu a nevynucuje její formát.

### BR-05: Bez blokující validace

Systém nekontroluje, zda hodnota představuje platné nebo existující telefonní číslo.

Libovolná neprázdná textová hodnota může být uložena bez:

- blokující chyby,
- varování o neplatném formátu,
- automatické opravy.

Například hodnoty `+420 777 123 456`, `777-123-456`, `ústředna 123, linka 42` nebo `555 / 123` jsou přípustné.

### BR-06: Zachování zápisu

Systém zachová uživatelem zadaný obsah a jeho vnitřní formátování.

Nesmí automaticky:

- přidávat nebo odstraňovat předvolbu,
- přeskupovat číslice,
- odstraňovat mezery, závorky nebo pomlčky,
- převádět hodnotu do jednotného telefonního formátu.

### BR-07: Zadání a vložení

Uživatel může hodnotu:

- napsat ručně,
- vložit ze schránky.

Obě metody mají stejné výsledné business chování. Notion obdobně umožňuje Phone hodnotu zadat nebo vložit jako textovou hodnotu.

### BR-08: Úprava hodnoty

Uživatel může existující hodnotu změnit.

Nová hodnota plně nahrazuje původní hodnotu. Property neudržuje historii předchozích hodnot.

### BR-09: Vymazání hodnoty

Odstraněním celé hodnoty se Phone property konkrétního tasku vrátí do stavu `Empty`.

Odstranění hodnoty z tasku neodstraňuje samotnou property ze schématu.

### BR-10: Kopírování

Neprázdnou hodnotu lze zkopírovat v podobě, v jaké je zobrazena a uložena.

Kopírování:

- nemění hodnotu,
- nezahajuje hovor,
- neprovádí validaci ani normalizaci.

### BR-11: Aktivace hodnoty

Aktivací neprázdné Phone hodnoty systém požádá zařízení uživatele o zahájení hovoru s danou hodnotou.

Aplikace sama:

- hovor automaticky nezahájí,
- nepotvrdí, že zařízení hovor skutečně uskutečnilo,
- nezapisuje výsledek hovoru do tasku.

### BR-12: Nepodporované zařízení

Pokud zařízení nebo prostředí neumí zahájit telefonní hovor:

- task ani jeho hodnota se nezmění,
- aplikace nezobrazí chybu tasku,
- hodnota zůstane dostupná ke zkopírování.

Neschopnost zařízení zahájit hovor se nepovažuje za neplatnou hodnotu Phone property.

### BR-13: Prázdná hodnota není aktivní

Phone property ve stavu `Empty` nenabízí akci pro zahájení hovoru ani kopírování hodnoty.

### BR-14: Přejmenování property

Přejmenování Phone property:

- nemění její typ,
- nemění hodnoty existujících tasků,
- nemění její chování.

### BR-15: Duplikace property

Při duplikaci vznikne nová samostatná Phone property.

Nová property převezme konfiguraci původní property. Systém se při každé duplikaci zeptá, zda chce uživatel zkopírovat také existující hodnoty.

Pokud uživatel zvolí kopírování hodnot:

- hodnoty se zkopírují pro všechny existující tasky,
- stav `Empty` zůstane u odpovídajících tasků také `Empty`.

Pokud uživatel kopírování hodnot odmítne:

- nová property bude u všech existujících tasků `Empty`.

Po duplikaci jsou obě properties nezávislé. Pozdější změna hodnoty, názvu nebo konfigurace jedné z nich nemění druhou.

### BR-16: Odstranění property

Odstranění Phone property znamená odstranění ze sdíleného schématu, a tedy ze všech tasků, které toto schéma používají.

Před odstraněním systém vždy zobrazí potvrzovací dialog.

Dialog zobrazí počet tasků, ve kterých má property stav `Is not empty`.

Při potvrzení se odstraní:

- definice property,
- všechny její hodnoty ve všech dotčených tascích.

Při zrušení dialogu se property ani její hodnoty nezmění.

---

## G. Klíčové výjimky a hraniční situace

### Prázdná hodnota

Prázdná property je platný stav. Nelze ji aktivovat pro volání ani zkopírovat jako existující hodnotu.

### Nestandardní hodnota

Nestandardní hodnota se uloží beze změny a bez validační chyby.

### Hodnota obsahující text

Hodnota jako `ústředna +420 123 456 789, linka 42` je povolena. Schopnost zařízení takovou hodnotu interpretovat pro volání není garantována.

### Zařízení neumí volat

Neúspěšné nebo nepodporované předání hodnoty zařízení nesmí změnit task ani způsobit chybu uložení.

### Nahrazení existující hodnoty

Protože je Phone jednohodnotová property, zadání nové hodnoty nahradí hodnotu původní. Nevznikne seznam telefonních čísel.

### Duplikace s částečně vyplněnými hodnotami

Při kopírování hodnot se zachová mapování jednotlivých tasků:

- vyplněná hodnota se zkopíruje,
- `Empty` zůstane `Empty`.

### Odstranění property bez hodnot

Potvrzovací dialog se zobrazí i v případě, že je počet `Is not empty` roven nule.

---

## H. Akceptační kritéria

1. Uživatel může vytvořit property typu `Phone`.
2. Nová Phone property je dostupná ve všech tascích sdíleného schématu.
3. Existující tasky mají novou property ve stavu `Empty`.
4. Jeden task může mít v jedné Phone property pouze jednu hodnotu.
5. Phone property může zůstat prázdná.
6. Uživatel může hodnotu napsat nebo vložit.
7. Systém přijme hodnotu bez validace telefonního formátu.
8. Systém zachová uživatelem zadaný obsah a formátování.
9. Uživatel může existující hodnotu změnit.
10. Uživatel může hodnotu odstranit a vrátit property do stavu `Empty`.
11. Neprázdnou hodnotu lze zkopírovat.
12. Aktivace neprázdné hodnoty požádá zařízení o zahájení hovoru.
13. Nepodporované zařízení nezpůsobí změnu tasku ani chybu aplikace.
14. Prázdná hodnota nenabízí akci volání.
15. Property lze přejmenovat bez změny jejích hodnot.
16. Property lze duplikovat s volbou zkopírovat nebo nezkopírovat hodnoty.
17. Duplikovaná property je nezávislá na původní property.
18. Odstranění property vždy vyžaduje potvrzení.
19. Potvrzení odstranění zobrazuje počet tasků ve stavu `Is not empty`.
20. Zrušení odstranění zachová property i všechny její hodnoty.
21. Potvrzení odstranění smaže property a její hodnoty ze všech tasků sdíleného schématu.

---

## I. BDD scénáře v Gherkinu

```gherkin
Feature: Phone property u tasků
  Uživatel potřebuje evidovat telefonní kontakt u tasku
  a použít jej pro zahájení hovoru.

  Rule: Phone property je součástí sdíleného schématu tasků

    Scenario: Vytvoření Phone property
      Given sdílené schéma používá několik existujících tasků
      When uživatel vytvoří property typu "Phone" s názvem "Telefon"
      Then property "Telefon" je dostupná ve všech tascích používajících schéma
      And u všech existujících tasků má stav "Empty"

    Scenario: Přejmenování Phone property
      Given schéma obsahuje Phone property "Telefon"
      And některé tasky obsahují vyplněné telefonní hodnoty
      When uživatel přejmenuje property na "Kontaktní telefon"
      Then property má název "Kontaktní telefon"
      And její typ zůstává "Phone"
      And hodnoty jednotlivých tasků zůstávají beze změny

  Rule: Phone property obsahuje nejvýše jednu nepovinnou hodnotu

    Scenario: Task zůstane bez telefonní hodnoty
      Given task obsahuje Phone property ve stavu "Empty"
      When uživatel task uloží
      Then task je uložen
      And Phone property zůstává ve stavu "Empty"

    Scenario: Zadání hodnoty do prázdné Phone property
      Given task obsahuje Phone property ve stavu "Empty"
      When uživatel zadá hodnotu "+420 777 123 456"
      Then Phone property obsahuje přesně hodnotu "+420 777 123 456"

    Scenario: Nahrazení existující hodnoty
      Given Phone property obsahuje "+420 777 123 456"
      When uživatel zadá novou hodnotu "+420 777 654 321"
      Then Phone property obsahuje pouze "+420 777 654 321"
      And původní hodnota již není aktuální hodnotou property

  Rule: Hodnotu lze zadat nebo vložit bez kontroly formátu

    Scenario: Vložení telefonní hodnoty ze schránky
      Given Phone property je ve stavu "Empty"
      When uživatel vloží hodnotu "(+420) 777-123-456"
      Then Phone property obsahuje přesně "(+420) 777-123-456"

    Scenario: Uložení nestandardně formátované hodnoty
      Given task obsahuje Phone property
      When uživatel zadá "ústředna +420 123 456 789, linka 42"
      Then hodnota je uložena beze změny
      And systém nezobrazí validační chybu
      And uložení tasku není zablokováno

    Scenario: Uložení hodnoty bez mezinárodní předvolby
      Given task obsahuje Phone property
      When uživatel zadá "777 123 456"
      Then hodnota je uložena jako "777 123 456"
      And systém automaticky nepřidá mezinárodní předvolbu

    Scenario: Zachování formátování
      Given task obsahuje Phone property
      When uživatel zadá "+420 (777) 123-456"
      Then hodnota je zobrazena jako "+420 (777) 123-456"
      And systém neodstraní mezery, závorky ani pomlčku

  Rule: Uživatel může hodnotu změnit nebo odstranit

    Scenario: Úprava telefonní hodnoty
      Given Phone property obsahuje "+420 777 123 456"
      When uživatel hodnotu změní na "+420 777 654 321"
      Then Phone property obsahuje "+420 777 654 321"

    Scenario: Odstranění telefonní hodnoty z tasku
      Given Phone property obsahuje "+420 777 123 456"
      When uživatel odstraní celou hodnotu
      Then Phone property má stav "Empty"
      And samotná Phone property zůstává součástí schématu

  Rule: Neprázdnou hodnotu lze zkopírovat

    Scenario: Zkopírování telefonní hodnoty
      Given Phone property obsahuje "+420 (777) 123-456"
      When uživatel zkopíruje její hodnotu
      Then zkopírovaný obsah je "+420 (777) 123-456"
      And hodnota Phone property zůstává beze změny
      And systém nezahájí hovor

  Rule: Aktivace hodnoty požádá zařízení o zahájení hovoru

    Scenario: Aktivace hodnoty na podporovaném zařízení
      Given Phone property obsahuje "+420 777 123 456"
      And zařízení podporuje zahájení telefonního hovoru
      When uživatel aktivuje telefonní hodnotu
      Then systém požádá zařízení o zahájení hovoru s hodnotou "+420 777 123 456"
      And hodnota tasku zůstává beze změny

    Scenario: Aktivace hodnoty na zařízení bez podpory volání
      Given Phone property obsahuje "+420 777 123 456"
      And zařízení neumí zahájit telefonní hovor
      When uživatel aktivuje telefonní hodnotu
      Then task zůstává beze změny
      And telefonní hodnota zůstává dostupná ke zkopírování
      And systém nezobrazí chybu tasku nebo jeho uložení

    Scenario: Prázdnou Phone property nelze použít pro volání
      Given Phone property má stav "Empty"
      When uživatel zobrazí property
      Then systém nenabízí zahájení hovoru
      And systém nenabízí kopírování existující hodnoty

  Rule: Phone property lze duplikovat

    Scenario: Duplikace včetně hodnot
      Given Phone property "Telefon" obsahuje v některých tascích hodnoty
      When uživatel duplikuje property
      And zvolí zkopírování hodnot
      Then vznikne nová samostatná Phone property
      And vyplněné hodnoty jsou zkopírovány do odpovídajících tasků
      And původně prázdné hodnoty zůstávají v nové property "Empty"

    Scenario: Duplikace bez hodnot
      Given Phone property "Telefon" obsahuje v některých tascích hodnoty
      When uživatel duplikuje property
      And odmítne zkopírování hodnot
      Then vznikne nová samostatná Phone property
      And nová property má ve všech existujících tascích stav "Empty"

    Scenario: Nezávislost duplikované property
      Given Phone property byla duplikována
      When uživatel změní hodnotu původní property u jednoho tasku
      Then hodnota duplikované property se nezmění

  Rule: Odstranění property ovlivní všechny tasky sdíleného schématu

    Scenario: Zobrazení potvrzení před odstraněním
      Given Phone property existuje ve sdíleném schématu
      And ve 12 tascích má stav "Is not empty"
      When uživatel zahájí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog informuje, že 12 tasků má stav "Is not empty"
      And property zatím není odstraněna

    Scenario: Zrušení odstranění property
      Given je zobrazen potvrzovací dialog odstranění Phone property
      When uživatel odstranění zruší
      Then Phone property zůstává ve sdíleném schématu
      And všechny její hodnoty zůstávají beze změny

    Scenario: Potvrzení odstranění property
      Given je zobrazen potvrzovací dialog odstranění Phone property
      When uživatel odstranění potvrdí
      Then Phone property je odstraněna ze sdíleného schématu
      And property již není dostupná v žádném tasku používajícím schéma
      And všechny hodnoty odstraněné property jsou smazány

    Scenario: Odstranění property bez vyplněných hodnot
      Given Phone property má ve všech tascích stav "Empty"
      When uživatel zahájí odstranění property
      Then systém zobrazí potvrzovací dialog
      And dialog zobrazí počet "Is not empty" jako 0
```

---

## J. Explicitní hypotézy

### H-01: Prázdné znaky

Hodnota obsahující pouze mezery nebo jiné prázdné znaky se považuje za `Empty`. Tato hypotéza neovlivňuje přijímání běžných nestandardních telefonních zápisů.

### H-02: Předání nestandardní hodnoty zařízení

Při aktivaci systém předá zařízení uloženou hodnotu beze změny. Není garantováno, že zařízení dokáže hodnotu obsahující text, linku nebo více čísel použít pro zahájení hovoru.

### H-03: Název duplikované property

Přesný způsob vytvoření názvu duplikované property se řídí společným chováním duplikace properties a není specifický pro typ Phone.

---

## Coaching note

Původní brief definoval pouze název property a inspiraci Notionem, ale neurčoval validaci, počet hodnot ani chování po aktivaci. Doplněná rozhodnutí převádějí Phone na jednoznačnou jednohodnotovou textovou property s předvídatelným chováním na podporovaných i nepodporovaných zařízeních.
