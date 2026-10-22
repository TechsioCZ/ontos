---
name: akros-weight
overview: Ověřit zdroj a jednotkový význam hmotnosti konkrétních variant pro TASK 07 a 16 bez blokování nezávislých úprav výpisu.
todos:
  - id: verify-variant-weight
    content: Ověřit D3 a doplnit hmotnost konkrétních variant z doloženého zdroje včetně jednotky a pravidel pro chybějící data.
    status: pending
isProject: false
---

# akros-weight

## Execution Notes

Navazuje na identitu z `akros-foundation`. Technický předpoklad TASK 07 a 16,
nikoli nový obchodní požadavek. Rozhodnutí D3 a společná pravidla jsou v
[hlavním plánu](../IMPLEMENTATION-PLAN.md).

### Hmotnost varianty

Kontrola 21. 10. 2026: feed má kladnou hodnotu u 13 597 z 19 025 variant,
dalších 5 428 má nulu. Tag `net_weight` nemá atribut jednotky. Implementace
[detailu](akros-task-03-07-review.md) přenáší kladné zdrojové hodnoty do
`CatalogProductVariant.sourceNetWeight`; nula zůstává neznámým údajem.
Toto pole není interpretovanou hmotností a nesmí vstoupit do výpočtu košíku.
Jednotka a vztah k prodejní jednotce/balení dále čekají na doložení.

- Výchozí generátor přenášel `net_weight` pouze na kontejner. Nyní ověřit význam
  variantního zdrojového pole před zavedením normalizované hmotnosti.
- Dohledat význam hodnoty u konkrétní zdrojové položky: jednotku váhy a vztah
  k prodejní jednotce nebo balení. Nedědit automaticky váhu rodiče do všech variant.
- Přenést ověřenou hodnotu i její jednotkový význam do katalogového kontraktu;
  generované soubory vytvářet generátorem, nikoli ručním dopisováním JSON.
- Chybějící údaj zůstává neznámý. Nezaměnit jej za nulu ani za váhu jiné varianty.
  Nejednoznačné jednotky feedu vyřešit nebo označit jako nevyhodnotitelné.

Dokončeno: existuje doložená vazba na zdroj a test alespoň dvou různě těžkých
variant stejného kontejneru, chybějící hodnoty, celého balení a desetinné prodejní
jednotky. Pokud jednotky nelze ověřit, související část zůstává pending.

## Constraints

Platí pravidla hlavního plánu. Neodhadovat hmotnost z ceny, názvu ani rodičovského
kontejneru. Význam jednotek doložit před výpočtem. Nejasnosti v hmotnosti neblokují
nezávislý plán výpisu `akros-variants`.

## Operator Guidance

Dotčené zdroje: `scripts/generate-akros-catalog.mjs`, `src/mock-storefront/types.ts`,
katalog a testy generátoru/výpočtu. Předchází `akros-detail` a `akros-cart`.
