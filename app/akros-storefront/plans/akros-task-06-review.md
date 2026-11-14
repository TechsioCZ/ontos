# TASK 06 – ceny pouze u konkrétní položky

Navazuje na dokončený TASK 05 (`a84c8c00`) v rámci uživatelem schváleného pokračování
na další úkoly. Zadání #1304 odpovídá Google dokumentu: odstranit cenový prefix
„Od“ na celém e-shopu a zobrazovat cenu ve vazbě na konkrétní variantu.

## Rozbor a rozsah

- Prefix se nyní sestavuje v `ProductGrid` a `HeaderSearch`. Sdílený grid obsluhuje
  homepage, kategorie, výsledky hledání, novinky, doporučení i oblíbené.
- Nevybrané vícevariantové skupině zobrazit `Cena dle varianty`. Nesmazat pouze
  prefix a neponechat nejnižší cenu kontejneru jako zdánlivě konkrétní cenu.
- Vybrané variantě, samostatnému SKU a skupině s právě jednou variantou zobrazit
  skutečnou cenu, případně `Cena na dotaz`. Data obsahují 150 skupin s jedinou
  variantou; jejich kontejnerová cena se shoduje s jedinou variantou.
- Zachovat `priceIsFrom` jako interní údaj pro rozlišení neurčené ceny skupiny,
  nepoužívat ho k vykreslení prefixu. Pro jednovariantové skupiny má být `false`.
  Neměnit číselná data, výpočty košíku ani nákupní identitu.
- Našeptávač i grid používají stejnou prezentaci ceny. Výsledky hledání konkrétní
  varianty musí převzít také její porovnávací cenu; nedědit ji z kontejneru jiné varianty.
- Detail vícevariantového produktu a tiskový list již cenu kontejneru nevypisují.
  Přehled cenových pásem `od N ks` znamená množstevní hranici a zůstává zachovaný.

## Ověření

- Cílená sada karet, našeptávače a katalogu: 49 testů prošlo. Doplňuje chování
  neurčené skupiny, konkrétního SKU, jednovariantové skupiny, nulové ceny a slev.
  Původní test homepage vyžadující `od 0,08 Kč` byl aktualizován podle zadání a prošel.
- `test:prices` prošel proti místnímu produkčnímu buildu na 1920/1024/390/320 px.
  Na každé šířce zkontroloval 83 karet proti katalogu: homepage, kategorie, hledání
  obecného dotazu, novinky, doporučení na detailu, oblíbené, hledání přesného SKU
  a detail jednovariantového výrobku. Celkem 332 kontrol karet; žádný cenový prefix
  `od`, žádná nejnižší cena nevybrané skupiny ani přetok cenového popisku.
- Na každé šířce prošlo obecné a přesné hledání v našeptávači, konkrétní variantní
  řádek, nákup skutečného minimálního množství a shoda `variantId`, množství i ceny
  v uloženém košíku a odpovídající zobrazený součet. Bez runtime/hydratačních chyb.
- Screenshoty desktopu, tabletu a mobilu byly vizuálně zkontrolovány. Screenshot
  našeptávače pořizovaný během vstupní animace byl doplněn ustáleným snímkem;
  vypočtená opacita je 1 a pozadí bílé. Sada nyní pro screenshot vypíná animace.
  Report i snímky jsou v ignorovaném `test-results/product-prices/`.
- Finální `npm run check` prošel: formátování, lint, TypeScript, 172 testů v 31
  souborech a produkční build. Dřívější nedostatek paměti při cíleném běhu byl
  vyřešen opakováním s jedním workerem a zastavením pomocného produkčního serveru;
  konfigurace ani diagnostiky nebyly oslabeny.

Implementace používá stávající kitové `ProductCard.Price` a našeptávač; CSS ani
hodnoty tokenů se v TASK 06 nemění. Číselné ceny a výpočty košíku zůstávají zachované.

TASK 06 je lokálně dokončený. Následuje zbývající hmotnostní část TASK 07
(čeká na potvrzení jednotky zdroje) a rozložení detailu z TASK 08.
