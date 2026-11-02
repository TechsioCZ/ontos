# TASK 10: zarovnání textů kategorií

Uživatel schválil pokračování 22. 10. 2026; TASK 09 je v commitu `c0e41744`.
[Issue #1308](https://github.com/TechsioCZ/ontos/issues/1308) bylo přečtené:
vycentrovat názvy a doprovodné texty, včetně popisu pod „Šrouby“, a sjednotit kategorie.
Issue je otevřené s labelem `bug`; GitHub tento lokální krok nemění.

## Rozsah a zjištění

- Výchozí browserová kontrola pěti kategorií na desktopu a mobilu potvrdila
  levé zarovnání nadpisů, popisů i názvů obrazových podkategorií.
- `akros-category-heading` používá také vyhledávání. Nový modifier jen na
  kategoriové route zabrání změně nadpisu výsledků hledání.
- Názvy podkategorií centruje existující obal `akros-category-card`.
  Odkaz dál obaluje celou kartu. Není potřeba přidat komponentu nebo měnit tokeny.
  Obecný heading/category-card kit 0.56.1 neposkytuje; jde o stávající obsahovou kompozici.
- Mění se dvě deklarace zarovnání a className kategoriového nadpisu. Rozměry,
  typografie, obrázky, texty a pravidlo zobrazení podkategorií zůstávají stejné.
  Boční katalog, breadcrumbs a produktové karty mají původní zarovnání.
- Kategorie s neúplnými obrázky nadále používají existující pravidlo, které
  jejich obrazový grid nezobrazuje. Tento krok chybějící obrázky nedoplňuje.

## Ověření

- `npm run check` prošlo: formatter, lint, TypeScript, všech 178 testů ve 33 souborech
  a produkční build. Použito `VITEST_MAX_WORKERS=1` kvůli paměti stroje.
- Před změnou ověřeno deset lokálních a deset nasazených kombinací pěti kategorií
  na 1920/390 px. Obě verze měly levé zarovnání textů.
- Hotová úprava prošla na pěti kategoriích a 12 šířkách, celkem 60 kombinací:
  1920/1440/1280/1101/1100/1024/1023/768/761/760/390/320 px.
  Kategorie: Šrouby, Matice, Šrouby s metrickým závitem, Nerezový hutní materiál
  a Nýtovací matice. Zahrnuté dlouhé názvy, chybějící popis i neúplné obrázky.
- Ověřené středové zarovnání nadpisu, přítomného popisu i všech vykreslených názvů
  podkategorií, bez přetečení stránky nebo ořezu textu. Shodné texty a odkazy
  s výchozími daty; původní pravidlo zobrazení obrazového gridu je zachované.
- Na 1920/390 px odkaz celé karty funguje klávesou Enter a otevře správnou kategorii.
  Nadpis výsledků hledání a boční katalog si zachovávají původní zarovnání.
- Browser neměl runtime ani hydratační chyby. Ručně prohlédnuté screenshoty Šroubů
  na 1920/320 px, dlouhých názvů na 390 px a hutního materiálu na 1920 px jsou v pořádku.
  Snímky a reporty jsou v ignorovaném `test-results/category-alignment/`.

U této drobné změny rozložení nevznikly nové unit testy ani testy kopírující CSS;
ověření používá browserové měření a screenshoty. Lokálně dokončeno, bez nového
commitu, deploye nebo změn GitHubu.
