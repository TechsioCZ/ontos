---
name: akros-foundation
overview: Sjednotit identitu prodejné položky a přesné odkazy na varianty jako společný základ požadovaných úprav.
todos:
  - id: define-sellable-ref
    content: Ověřit D2 a zavést společné rozlišení kontejneru a prodejné položky pro URL, oblíbené, akce, košík a opakování objednávky.
    status: pending
isProject: false
---

# akros-foundation

## Execution Notes

Společný technický předpoklad původních TASK 02, 03, 07, 11, 12, 13 a 16.
Nejde o nový obchodní požadavek. Autoritativní přehled a rozhodnutí D1–D8 jsou v
[IMPLEMENTATION-PLAN.md](../IMPLEMENTATION-PLAN.md).

### Identita prodejné položky a odkaz

- Navázat na současný klíč košíku `productId` + `variantId`. U produktu s více
  variantami není samotné `productId` platnou identitou vybrané prodejné položky.
- Potvrdit reprezentaci samostatného SKU bez variant a jednovariantového produktu.
  Nezaměňovat takovou prodejnou položku za kontejner více variant.
- Jeden resolver ověří příslušnost varianty k produktu a poskytne SKU, název,
  obrázek, cenu, jednotku, minimum, balení a aktuální sklad. Navázat na existující
  katalogové helpery, nepřidávat souběžné neslučitelné modely.
- Oddělit přesný výběr SKU/ID od volného dotazu, který dnes používá `?variant=`.
  Odkaz z oblíbených, sdílení i hledání musí určit stejnou variantu i po reloadu.
  Chybné nebo již neexistující ID nesmí tiše vybrat jinou variantu.
- Zachovat použitelnost existujících odkazů s hledaným výrazem. Přesný odkaz nesmí
  záviset na aktuálním pořadí, stránce seznamu nebo předchozím lokálním filtru.

Dokončeno: testy pokrývají různé varianty stejného produktu, samostatné SKU,
jednovariantový produkt, neplatný výběr a zpětně kompatibilní načtení původních URL.
Rozhodnutí D2 a výsledný kontrakt jsou zapsané u tohoto plánu.

## Constraints

Platí pravidla hlavního plánu. Zachovat stávající ceny, minimální odběry, násobky
balení a limity skladu. Nepřidávat skutečné backendové integrace. Nepovažovat
uložené historické ceny za aktuální katalogovou nabídku.

## Operator Guidance

Dotčené zdroje: `src/mock-storefront/types.ts`, `catalog.ts`, `cart.ts`,
`local-order.ts` a příslušné unit testy.
Tento plán předchází `akros-variants` a `akros-weight`. Ověřit kontrakt a migraci
starých lokálních dat před připojováním jednotlivých UI funkcí.
