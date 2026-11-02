---
name: akros-weight
overview: Ověřit zdroj a jednotkový význam hmotnosti konkrétních variant pro TASK 07 a 16 bez blokování nezávislých úprav výpisu.
todos:
  - id: verify-variant-weight
    content: Ověřit D3 a doplnit hmotnost konkrétních variant z doloženého zdroje včetně jednotky a pravidel pro chybějící data.
    status: completed
isProject: false
---

# akros-weight

## Execution Notes

Navazuje na identitu z `akros-foundation`. Technický předpoklad TASK 07 a 16,
nikoli nový obchodní požadavek. Rozhodnutí D3 a společná pravidla jsou v
[hlavním plánu](../IMPLEMENTATION-PLAN.md).

### Schválené pravidlo pro košík, 22. 10. 2026

Uživatel výslovně schválil logickou interpretaci zdrojové hmotnosti za jednu
prodejní jednotku po porovnání s akros.cz. Toto rozhodnutí nahrazuje předchozí
blokaci TASK 16 na formálním doložení jednotkového významu.

- Kladné `net_weight` kusového zboží znamená kg/ks. Balení je už převedené na
  kusy nákupním formulářem, takže se při součtu znovu nenásobí.
- U metrového zboží jde o kg/m: například lanko
  `10305304040011` má 0,06 kg/m na [původním webu](https://www.akros.cz/lanko-4-0-1-x19-dr-din-3053-1-4401).
- Následné upřesnění uživatele: FE používá kladné zdrojové hodnoty bez odhadování
  jejich fyzikální věrohodnosti. Dřívější výjimky pro 0,001 kg/m a FVE kategorii
  se ruší; správnost hodnot vlastní datový zdroj a budoucí backend.
- Při částečných datech je hlavní údaj „Hmotnost známých položek“ s číselným
  součtem a upozorněním na chybějící řádky. „Nelze určit“ se zobrazí pouze tehdy,
  když nemá použitelnou hmotnost žádný řádek.
- Nulové, chybějící a nepodporované jednotky zůstávají neznámé, bez odhadů náhrady.
- Jediný resolver `getProductUnitWeightKg` v katalogové vrstvě ověřuje produkt,
  variantu, SKU a MJ. Nedědí váhu rodiče a nevybírá jinou variantu při chybě ID.
  Součet přes něj funguje pro všechny nákupní cesty i staré uložené košíky;
  případná explicitně normalizovaná `unitWeightKg` má přednost.
- Žádné nové mock váhy, datový archiv, generovaný paralelní index nebo změny cen
  a skladů. Původní feed a generované soubory se nemění.

Ověření původního košíku, 22. 10. 2026: [řetěz DIN 766/A4 2 mm](https://www.akros.cz/retez-nerezovy-2-kratky-clanek-din-766-a4),
SKU `10076604020000`, uvádí v detailu 0,001 kg a MJ m. V izolovaném anonymním
košíku se stejnou variantou původní web zobrazuje 3 m → 0.003 kg a po změně
na 100 m → 0.1 kg v bloku Doprava. Kontrola zahrnula reload; objednávka se
nevytvářela. Screenshoty jsou v ignorované složce `test-results/task-16/legacy/`.
To potvrzuje shodu výpočtu se zdrojem, nikoli fyzikální správnost zdrojových dat.

### Předchozí audit hmotnosti varianty

Kontrola 21. 10. 2026: feed má kladnou hodnotu u 13 597 z 19 025 variant,
dalších 5 428 má nulu. Tag `net_weight` nemá atribut jednotky. Implementace
[detailu](akros-task-03-07-review.md) přenáší kladné zdrojové hodnoty do
`CatalogProductVariant.sourceNetWeight`; nula zůstává neznámým údajem.
Toto pole není interpretovanou hmotností a nesmí vstoupit do výpočtu košíku.
Jednotka a vztah k prodejní jednotce/balení dále čekají na doložení.

### Doplnění 22. 10. 2026

Uživatel požádal význam ověřit podle dostupných dat. Porovnání konkrétních SKU
s původním e-shopem doložilo **kg pro zobrazení zdrojové hmotnosti varianty**:

| SKU            | Feed `net_weight` | Původní e-shop                                                       | Balení |
| -------------- | ----------------- | -------------------------------------------------------------------- | ------ |
| 10799700050025 | 0.0034            | [0,003 Kg](https://www.akros.cz/vrut-5-x-25-zap-hl-kr-dr-din7997-a2) | 200 ks |
| 10091200040090 | 0.00691           | [0,007 Kg](https://www.akros.cz/sroub-m-4-x-90-imbus-din-912-a2)     | 100 ks |

Web původního obchodu hodnoty zaokrouhluje na tři desetinná místa. Lokální detail
zachová až šest míst a používá hodnotu konkrétní varianty. Neznámé hodnoty
zůstávají neuvedené. To umožňuje dokončit zobrazení z TASK 07.

Pro **výpočet košíku z TASK 16** však D3 ještě není uzavřené: ve feedu chybí
jednotkový atribut, `measure_price_by` je v kontrolovaných položkách prázdné
a `net_pieces/net_length` nulové. Z 2 202 metrových variant má kladnou váhu
jen 65. Například několik různých FVE profilů má shodně `0.01061` při různých
délkách a baleních; to neurčuje spolehlivý přepočet kg/m. U vrutů DIN 7997/A2
má mnoho odlišných rozměrů shodně `0.0034`. Zdrojové hodnoty neopravovat
odhadem a nerozdělovat je automaticky počtem kusů v balení.

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
