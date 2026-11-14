---
name: akros-integrations
overview: Ověřit lokální našeptávač a připravit navazující vyhledávání, změnu hesla a adresní předvyplnění podle potvrzených externích kontraktů.
todos:
  - id: task-15-17-frontend
    content: FE TASK 15/17 – oddělená validovaná změna hesla a skutečný Smart Address klient s ručním fallbackem; živá úspěšná integrace zůstává závislá na službách.
    status: completed
  - id: confirm-integration-contracts
    content: Uzavřít D5 a D7 pro autentizaci a případný vzdálený zdroj vyhledávání; D8 Smart Address v1 je lokálně ověřené živým průchodem.
    status: pending
  - id: task-11-search-suggestions
    content: TASK 11 – ověřit existující lokální našeptávač a opravit přesné směrování výsledků na produkty a varianty; Meilisearch zůstává navazující integrací.
    status: completed
  - id: task-15-change-password
    content: TASK 15 – přes skutečnou schválenou autentizační službu změnit heslo v osobních údajích včetně validace a ověření výsledku.
    status: pending
  - id: task-17-address-autocomplete
    content: TASK 17 – po výběru ověřeného zdroje doplnit adresní našeptávání a předvyplnění s možností ručního zadání.
    status: completed
isProject: false
---

# akros-integrations

## Execution Notes

Lokální FE realizaci a přesné limity živého ověření vlastní
[review TASK 12–17](akros-tasks-12-17-review.md). TASK 17 má klienta konkrétního
nasazeného v1 API a pevný same-origin rewrite. Živý průchod bez interceptů prošel
nad produkčním sestavením na desktopu i mobilu: návrhy RÚIAN i doplnění polí.
D8 je pro tuto lokální integraci uzavřené; samotný AKROS se dosud nenasazuje.

Následné review odhalilo neúplné vyhledávání samotného poskytovatele: například
`Boženy Němcové Tábor` nevrací žádnou adresu v Táboře. Toto zůstává otevřené
pro Smart Address; ověřené FE napojení neznamená úplné pokrytí adres služby.
Reprodukce a dočasnou opravu React chyby ve vydaném Comboboxu vlastní
[integrační poznámky](akros-smart-address-integration.md).

Upřesnění uživatele 22. 10. 2026 omezuje naši dodávku na FE storefront.
[Audit zbývajících úkolů](akros-remaining-fe-scope.md) rozlišuje FE formuláře a
napojení od vlastní serverové funkce. U TASK 15 lze samostatně dokončit formulář
a validaci; ověření skutečné změny hesla níže platí pro celou budoucí integraci,
nikoli jako požadavek implementovat autentizaci v tomto prototypu. U TASK 17
nezavádět lokální náhradu skutečného poskytovatele adres.

Původní úkoly zůstávají v plánu, ale jejich integrace nejsou z aktuálních zadání
plně rozhodnuté. Výchozí pořadí je pozdější fáze; není to změna GitHub labelu na
`status:park` ani zrušení těchto požadavků. Kontrakty musí být konkrétní a potvrzené
před implementací závislého kroku. Viz [hlavní plán](../IMPLEMENTATION-PLAN.md).

Lokální frontend TASK 11 byl 22. 10. 2026 ověřen a dokončen samostatně.
Jeho hotové chování neznamená schválené nebo nasazené Meilisearch; D7 zůstává
rozhodnutím pro tuto případnou navazující integraci.

Graf vede do této navazující fáze z `akros-detail`, `akros-cart` a
`akros-account-navigation`. Jde o doporučené pořadí dodávky; produktové rozhodnutí
může jednotlivou integraci přesunout dříve bez nutnosti čekat na nesouvisející úkoly.

### TASK 11 – našeptávač · #1309

Rozbor 22. 10. 2026 potvrdil hotový lokální našeptávač a konkrétní chybu
směrování kolidujících SKU. [TASK 11](akros-task-11-review.md) vlastní opravu
tohoto původního požadavku; budoucí Meilisearch má samostatné neuzavřené D7.

- Zachovat původní požadavek na vlastní vzhled a správné směrování návrhů při psaní.
  Existující `HeaderSearch` už má lokální katalogový našeptávač a kit
  `SearchSuggestions`; neduplikovat funkční ovládání.
- Pro případnou navazující integraci výslovně potvrdit návrh z
  [komentáře](https://github.com/TechsioCZ/ontos/issues/1309#issuecomment-6266134947):
  pozdější realizaci přes Meilisearch. Předem určit poskytovatele vyhledávání,
  veřejný endpoint, index produktů/variant, aktualizace dat a klientská oprávnění.
- Variantní návrh vede na přesně danou variantu podle společného kontraktu; návrh
  kontejneru netvrdí, že už vybral libovolnou konkrétní variantu.
- Zachovat kategorie, SKU, psaní s diakritikou, klávesnici, Escape/návrat fokusu,
  prázdný výsledek a celkové výsledky vyhledávání. U vzdáleného zdroje přidat stav
  načítání, chyby a ochranu před zobrazením výsledku staršího dotazu.
- Nepublikovat administrační klíče ani přímý přístup k neveřejnému vyhledávacímu
  indexu v browseru. Samotné zavedení Meilisearch infrastruktury není tímto plánem
  automaticky povolené.

Lokální část dokončena: ověřené směrování produktu i varianty, pořadí kategorií,
klávesnice a prázdné výsledky. Ceny v návrzích respektují TASK 06. Vzdálené
načítání a chybové stavy poskytovatele patří až k případné schválené integraci D7.

### TASK 15 – změna hesla · #1313

- Nejprve potvrdit D5. Stávající přihlášení žádné heslo neověřuje a profil jej
  správně neukládá; nový client-side zápis hesla by nebyl opravou tohoto zadání.
- Změnu umístit do osobních údajů a napojit na autentizovanou serverovou operaci.
  Kontrakt určí ověření současné identity/hesla, pravidla nového hesla, opakování
  hodnoty, chybové odpovědi a dopad na přihlášené relace.
- Zobrazit úspěch až po potvrzení serveru. Chybný formulář nebo neověřený uživatel
  heslo nezmění. Oddělit změnu hesla od nezávislého uložení běžného profilu.
- Heslo ani jeho potvrzení neukládat do local/session storage, URL nebo logů.

Dokončeno: ověřené přihlášení novým heslem a odmítnutí starého podle kontraktu,
validace, odpovědi serveru a správné chování relací. Bez autentizační služby nelze
issue prohlásit za hotové; případné demo UI je pouze dílčí výstup.

### TASK 17 – adresní našeptávání · #1315

Uživatel 22. 10. 2026 dodal konkrétní Smart Address repo a nasazené demo.
[Ověření existující služby](akros-smart-address-integration.md) zaznamenává původní
HTTP 503 i následnou úspěšnou odpověď v1. FE klient používá pevný same-origin
rewrite; živé doplnění RÚIAN adres prošlo nad produkčním sestavením na desktopu
i mobilu. Tím je D8 pro lokální dodávku potvrzené. Původní integrační kritéria níže
zůstávají podkladem ověření, nikoli pokynem vytvořit nový poskytovatel.

- Nejdřív ověřit publikované rozhraní již vyvinuté vlastní databáze adres, její
  pokrytí a podmínky použití. Nepřebírat privátní zdrojový kód nebo databázový přístup
  jiné aplikace. FoxEntry zůstává alternativou, nikoli předem vybraným řešením.
- Rozhodnutí D8 zaznamená zdroj, potřebná pole, autentizaci, provozní podmínky,
  nakládání s adresními údaji a chování při nedostupnosti. Pak teprve napojit
  ověřený kontrakt; nevymýšlet URL, SDK metody ani přístupové údaje.
- Z návrhu vyplnit správně odpovídající fakturační/dodací pole. Umožnit ruční
  zadání a následnou editaci; zpožděný návrh nesmí přepsat novější uživatelův text.
- Vyřešit ulici, číslo domu v podporovaném formátu, obec, PSČ a zemi, neúplný
  výsledek, nenalezenou adresu, mobilní ovládání a selhání poskytovatele.
- Navázat na dohodnuté uložené adresy z TASK 14 bez přepisování jiné adresy nebo
  záměny rozepsaného formuláře za automaticky uložený záznam.

Dokončeno: výběr návrhu doplní správnou adresu, ruční zadání zůstane funkční,
výpadek neblokuje objednávku a chybná/stará odpověď nepřepíše aktuální data.

## Constraints

Platí pravidla hlavního plánu. Žádná služba ani provider nejsou zvolené pouze
existencí tohoto dokumentu. Nečíst `.env`, nezavádět skutečné odesílání nebo novou
infrastrukturu bez schváleného konkrétního rozsahu a nepoužívat cizí privátní moduly.

## Operator Guidance

Začít kontrakty, nikoli vzhledem úspěšné hlášky. Pak rozšířit existující
`HeaderSearch`, profilové formuláře a checkout adresní pole přes podporované
komponenty kitu. Integrační testy izolují poskytovatele; skutečnou službu ověřit
dohodnutým testovacím prostředím. Před uzavřením celé dodávky provést `npm run check`
a všechna browserová ověření podle hlavního plánu.
