---
name: akros-account-navigation
overview: Upravit textovou horní navigaci, zarovnání kategorií a skutečné chybějící části editace profilu a adres podle TASK 09, 10 a 14.
todos:
  - id: task-09-text-navigation
    content: TASK 09 – po upřesnění D6 ponechat v horním seznamu jen odkazy na textové stránky a zachovat dostupnost katalogu jinde.
    status: completed
  - id: task-10-category-alignment
    content: TASK 10 – sjednotit středové zarovnání názvů a doprovodných textů kategorií.
    status: completed
  - id: task-14-profile-addresses
    content: TASK 14 – podle D4 doplnit chybějící editaci profilu a správu adres a ověřit ukládání i následné zobrazení.
    status: pending
isProject: false
---

# akros-account-navigation

## Execution Notes

Tato část může postupovat nezávisle na přestavbě variant. Odkazy na issues a
rozhodnutí D4/D6 jsou v [hlavním plánu](../IMPLEMENTATION-PLAN.md).

### TASK 09 – horní navigace · #1307

Uživatel schválil [konkrétní seznam a ověření](akros-task-09-review.md) 22. 10. 2026.
D6 je vyjasněné: šest textových odkazů, domů přes logo, oddělené přihlášení.

- Inventarizovat `utilityLinks` v `site-header.tsx`. Odstranit z horního seznamu
  odkazy na katalogové kategorie včetně „Spojovací materiál“, „Hutní materiál“
  a současné kategoriové route „AKROS CZ výroba“.
- Potvrdit konečný seznam textových stránek a zacházení s „Domů“ a přihlášením.
  Pokud má výroba zůstat jako textová stránka, potřebuje doloženou textovou route;
  samotná změna popisku kategoriového odkazu zadání nesplňuje.
- Katalog musí zůstat dostupný boční/mobilní navigací; logo dál vede domů.
  Zachovat aktuální položku, fokus a uzavírání mobilního menu.

Dokončeno: horní seznam obsahuje dohodnuté textové odkazy, žádný z nich omylem
nevede do kategorie a odstraněné vstupy do katalogu mají nadále funkční náhradu.

### TASK 10 – texty kategorií · #1308

Aktuální rozsah a ověření vlastní [rozbor TASK 10](akros-task-10-review.md).

- Vycentrovat názvy a související doprovodný text ve výpisu kategorií; zkontrolovat
  zvlášť nadpis/popisek kategorie „Šrouby“ i názvy podkategorií v kartách.
- Sjednotit pravidlo pro ostatní kategorie, delší názvy a chybějící obrázek/popisek.
  Nevycentrovat tím boční strom nebo nesouvisející sloupce nákupní tabulky.

Dokončeno: screenshoty krátké i dlouhé kategorie prokážou stejné zarovnání názvu
a doprovodného textu bez ořezu nebo změny klikatelné oblasti.

### TASK 14 – osobní údaje a adresy · #1312

- Nejdřív porovnat očekávané chování s existujícím `AccountProfilePage`, validací
  a lokálním uložením. Tyto části už fungují; neopakovat jejich implementaci.
- Potvrdit D4: lokální demo versus účtový backend a rozsah uložených adres.
  Současná fakturační a dodací pole sama o sobě nejsou víceadresovým adresářem.
- Implementovat zjištěné mezery podle tohoto rozhodnutí. Každá editace správné adresy
  se musí promítnout zpět do zobrazení a přežít reload v rámci dohodnutého úložiště.
- U formuláře zachovat chybové stavy, odkrytí chybné sekce, fokus a ochranu před
  ztrátou rozepsaných dat. Pole změny hesla řešit samostatným TASK 15; nesmí tiše
  blokovat uložení jinak správně upraveného profilu.
- Při účtovém řešení ověřit vlastnictví adres a izolaci zákazníků na serveru.
  Lokální demo tuto záruku nenahrazuje a nesmí se za ni vydávat.

Dokončeno: změněný osobní údaj a dohodnutá uložená adresa se správně načtou po
reloadu i při opětovném vstupu do účtu; chybný formulář nezapíše neplatná data.
Rozsah persistence je doložen a chování odpovídá D4.

## Constraints

Platí pravidla hlavního plánu. Není povolení měnit autentizaci, zakládat backend
ani importovat privátní adresní databázi z jiné části OntOS. Neodstraňovat funkční
validaci a obnovu profilu při sjednocování formulářů.

## Operator Guidance

Dotčená místa: `site-header.tsx`, `category-grid.tsx`, kategoriová route,
`account-profile-page.tsx`, `use-account-profile.ts`, `account-profile.ts` a případné
nové app-local adresní rozhraní. Ověřit `test:shared-ui`, `test:account`, `test:auth`
a dotčené komponentové/unit testy; správu adres ověřit i chybami a reloadem.
