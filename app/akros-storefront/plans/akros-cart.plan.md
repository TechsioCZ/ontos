---
name: akros-cart
overview: Doplnit hmotnost košíku a opakování konkrétní objednávky s aktuálními variantami podle TASK 16 a 12.
todos:
  - id: task-12-16-frontend
    content: FE TASK 12/16 – funkční opakování demo objednávek do aktivního košíku; reaktivní váha z ověřených jednotkových dat nebo neznámý součet.
    status: completed
  - id: task-16-cart-weight
    content: TASK 16 – zobrazit a průběžně přepočítávat celkovou hmotnost z ověřených variant a skutečných množství.
    status: completed
  - id: task-12-order-again
    content: TASK 12 – vložit položky vybrané původní objednávky do aktuálního košíku po ověření současného katalogu a skladu.
    status: completed
isProject: false
---

# akros-cart

## Execution Notes

Lokální FE výsledek a ověření po souhlasu uživatele vlastní
[review TASK 12–17](akros-tasks-12-17-review.md). Zbývající pending body níže
jsou funkce celé integrace, nikoli chybějící simulace backendu.

Navazuje na `akros-weight` a jeho předchůdce `akros-foundation`;
nemusí čekat na celý vizuální detail variant.
Issues [#1314](https://github.com/TechsioCZ/ontos/issues/1314) a
[#1310](https://github.com/TechsioCZ/ontos/issues/1310) patří původním TASK 16 a 12.
Společná pravidla a D2/D3 jsou v [hlavním plánu](../IMPLEMENTATION-PLAN.md).

### TASK 16 – celková hmotnost košíku

- V prvním kroku košíku uvést součet hmotností konkrétních prodejných položek podle
  ověřeného jednotkového významu z D3 a skutečných nákupních množství.
- Počet balení se v nákupu převádí na základní množství; hmotnost se nesmí následně
  násobit velikostí balení podruhé. Ošetřit desetinné množství a zaokrouhlit až
  prezentaci výsledku podle dohodnuté jednotky.
- Výsledek aktualizovat po přidání, změně množství, odebrání, změně pojmenovaného
  košíku i reloadu. Pro staré uložené řádky znovu dohledat jejich přesnou variantu.
- Chybějící hmotnost označit jako neznámou/neúplný součet. Nevydávat částečnou
  hodnotu za celkovou ani neznámé hodnoty za nulu; neodhadovat podle kontejneru.

Dokončeno: unit testy pokryjí více variant, více balení, desetinnou jednotku,
prázdný košík, chybějící data a změny množství. Browserový test ověří okamžitý
přepočet, odebrání, přepnutí košíku a obnovení uloženého košíku.

### TASK 12 – objednat znovu

Pozdější souhlas uživatele schvaluje funkční demo TASK 12 nad jedním zdrojem
dat účtu a pěti historickými objednávkami v `fixtures/account.ts` a současným
košíkem. Nevytvářet další backend, autentizaci ani archiv nových objednávek.
Aktuální implementaci a review vlastní [výsledek TASK 12–17](akros-tasks-12-17-review.md).

- Přidat akci v historii pro konkrétní objednávku. Neplnit všechny objednávky
  stejnými `mockOrderLines`; současná historie nemá vazby potřebné pro tento úkon.
- Jednoznačný zdroj řádků pro demo je `fixtures/account.ts`. Historická objednávka
  nese reference a objednané množství; nezavádět další paralelní zdroj.
- Před vložením vyhodnotit dnešní existenci varianty, cenu, sklad, minimum a balení.
  Původní cenu ani dostupnost nepovažovat za současnou nabídku.
- Vkládat do aktivního košíku a zachovat jeho dosavadní položky. Při sloučení stejné
  varianty posoudit sklad proti výslednému množství, nikoli jen proti přidávané části.
- Neexistující/nedostupné položky a nutné změny množství srozumitelně vypsat;
  množství tiše neupravovat. Přesnou politiku nabídky/potvrzení úprav zachytit před
  realizací. Opakované kliknutí nesmí vytvořit nepozorovanou duplicitní operaci.

Dokončeno: dvě různé objednávky přidají své skutečné řádky; existující obsah košíku
zůstane zachován. Testy zahrnují změnu ceny, skladový limit při sloučení, smazanou
variantu, minimum/balení a informaci, které položky se přidaly či nepřidaly.

## Constraints

Platí pravidla hlavního plánu. Zachovat chování pojmenovaných košíků, cenová pásma,
DPH, dostupnost dopravy a platby i dokončení objednávky. Zobrazení hmotnosti samo
nezavádí nový výpočet dopravného, který zadání nepožaduje.

## Operator Guidance

Dotčená místa: `cart.ts`, cart provider/collection/storage, `cart-items-table.tsx`,
`cart-content.tsx`, `local-order.ts`, historie/detail objednávky a provázané fixtures.
Ověřit unit testy výpočtů a sloučení, browserovou regresi košíku a celou objednávku.
Rozšíření uložených dat musí bezpečně načíst starší verze bez ztráty existujícího košíku.
