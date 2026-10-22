# TASK 03 + 07: odsouhlasený detail konkrétní varianty

Uživatel schválil následující chování 21. 10. 2026 a požádal o jeho zapsání
do plánu a následnou implementaci. Navazuje na commit `40796eb3` a
[společné variantní akce](akros-task-03-actions-review.md).

## Zjištěný stav

- [TASK 03 / #1301](https://github.com/TechsioCZ/ontos/issues/1301) vyžaduje
  hlídání, dotaz a sdílení konkrétní varianty; hlídání a dotaz patří i do jejího detailu.
- [TASK 07 / #1305](https://github.com/TechsioCZ/ontos/issues/1305) doplňuje modal,
  popis, váhu a obrázkový náhled při najetí. Obě issues byly znovu přečtené;
  nemají komentáře a nebyly upravené.
- Detail varianty nemá lokální aplikace ani kontrolovaný Vercel deploy. Existující
  hromadné akce nad produktem už používají výběr přesných variant a zůstávají zachované.
- Katalog má 19 025 variant, z nichž 18 007 má vlastní obrázek. Feed má popis
  u 12 449 variant a kladné `net_weight` u 13 597; ostatních 5 428 má nulu.
  Generátor nepřenáší variantní popis ani hmotnost. Rodičovská váha se nemůže dědit.
- Jednotka a vztah `net_weight` ke kusu/metru/balení nejsou doložené. Hodnota se
  bez tohoto ověření nebude prezentovat jako kg ani použita pro výpočet košíku.
- Figma spojení při kontrole vyžadovalo opětovné připojení; webový náhled nebyl
  dostupný. Rozložení níže je uživatelem odsouhlasený návrh, nikoli nově ověřená
  přesná shoda s Figmou. Přihlášení do GPT není podmínkou této práce.

## Schválené chování

1. Kliknutí na název varianty otevře její modal. Nákupní ovladače v řádku fungují
   samostatně. Odkaz má stabilní ID varianty a je dostupný klávesnicí i dotykem.
2. Modal obsahuje obrázek, název, celý kód, dostupnost, cenu s/bez DPH, parametry,
   popis a nákup konkrétní varianty. Minimum, sklad a pravidla nákupu se nemění.
3. Oblíbené, hlídání, dotaz a sdílení v modalu pracují rovnou s otevřenou variantou,
   bez dalšího výběrového dialogu. Stav zůstává společný s hromadnými akcemi.
4. Na desktopu obrázek vlevo a informace vpravo, na mobilu obsah pod sebou.
   Použít kit `Dialog`, existující tlačítka a nákupní formulář, tokeny a jemný stín.
5. Najetí nebo fokus na název zobrazí malý obrázkový náhled přes kit `Tooltip`.
   Náhled je doplňkový; všechny informace jsou i v modalu. Chybějící obrázek
   použije společný produktový obrázek, případně existující obrázek nedostupnosti.
6. Obnovování stránky, přímý odkaz, zavření, Escape a historie zachovají kontext
   seznamu. Otevření detailu nemaže `variantIds` ani starý filtr `variant`.
7. Vlastní popis se přenese generátorem; při jeho absenci je jasně označený společný
   popis produktu. Chybí-li oba, zobrazí se pravdivý prázdný stav.
8. Váha zmizí z vícevariantového kontejneru. V modalu se zobrazí až s doloženou
   jednotkou; do té doby bude údaj označený jako neuvedený. Tato mezera neblokuje
   implementaci modalu, akcí, popisů a obrázků, ale TASK 07 zůstává částečně otevřený.

## Implementační kroky a ověření

1. Přenést popis a nezinterpretovanou zdrojovou hmotnost do kontraktu varianty
   a regenerovat katalog; JSON neupravovat ručně. Nezavádět domnělou jednotku.
2. Doplnit samostatnou URL identitu otevřeného detailu a odkaz z názvu varianty.
   Přímý odkaz ověřit proti variantám stejného produktu; neznámé ID nezaměnit za jiné SKU.
3. Složit modal a obrazový náhled z kitu, zachovat nákupní logiku a přidat přímé
   variantní akce. Sdílení jedné varianty otevře tento detail; hromadný odkaz dál ukáže výběr.
4. Ověřit dvě varianty téhož produktu, chybějící popis/obrázek, neznámé ID,
   dlouhé SKU, nedostupnost, minimum a balení. Ověřit persistenci a nezávislost
   oblíbených/hlídání, předvyplněný dotaz, sdílení a historii/reload/fokus.
5. Zkontrolovat desktop/tablet/mobil 1920, 1440, 1280, 1024, 768, 390, 320 px
   a nízké okno. Spustit `npm run check` a relevantní browserové regrese.

TASK 04–06, přestavba dopravy z TASK 08, košíková váha a nové backendové integrace
nejsou součástí tohoto kroku. GitHub statusy ani issues se nemění. Souhlas s tímto
krokem nezakládá automatický commit či push jeho budoucí implementace.

## Realizace

- Generátor přenáší čistý text popisu a kladný `sourceNetWeight`. Katalog byl
  regenerován původním příkazem; jednotka hmotnosti nebyla domyšlená.
- Název varianty je kit `LinkButton` s `Tooltip` náhledem; fokus vnořeného odkazu
  udržuje náhled otevřený i při odchodu ukazatele ze span triggeru. Escape jej zavře.
- `variantDetail` je oddělený od `variantIds` a `variant`. Přímá URL a reload otevřou
  modal přesného SKU; neznámé ID zobrazí chybu bez nákupu jiné varianty.
- Modal používá kit `Dialog`, `AvailabilityStatus`, existující nákupní formulář,
  oblíbené a rozšířené akce. Hromadné výběry nad produktem se nemění.
- Přímé oblíbené/hlídání mění jen danou variantu, dotaz předává její ID a sdílení
  obsahuje `variantDetail`. Náhradní share Popover zůstává uvnitř modalu kvůli focus trapu.
- Dialog se montuje až po hydrataci: při serverovém portálu vznikal rozdíl `useId`
  uvnitř sdílení. Explicitní max-height konzumuje dialog token; v nízkém mobilním
  okně je menší obrázek, hlavička a zavření zůstávají dostupné, obsah scrolluje.
- Kód má na mobilu vlastní plnou šířku a zůstává na jednom řádku. Náhled se
  nezavírá při automatickém scrollu na odkaz; při odchodu ukazatele/fokusu,
  Escape a otevření modalu se dál zavírá.
- Chybějící/chybný obrázek postupně přechází na společný a na existující placeholder.
  Chybějící popis je označeným společným popisem nebo pravdivým prázdným stavem.
- Vícevariantový kontejner už neukazuje rodičovskou váhu. Modal má „Hmotnost:
  Neuvedena“ do doložení jednotky; hmotnostní část TASK 07 zůstává otevřená.

## Výsledky ověření

- `npm run check`: formátování, lint, TypeScript, 161 testů ve 30 souborech
  a produkční build prošly. Komponentové nákupní testy poskytují kontext URL
  novým odkazům; všech 12 původních scénářů zůstává zachovaných.
- `npm run test:variant-detail`: prošlo osm rozměrů včetně 320 × 480 px, celý
  kód na jednom řádku, ovlivnění rozměrů dialogovými tokeny, hover/fokus náhled,
  Escape, historie/návrat fokusu/reload, samostatné přidání i odebrání variant,
  nákup minima i celého balení, přesné sdílení a dotaz, neznámé ID a chybějící data.
  Náhradní sdílení a kopírování bylo ověřené i při 390 a 320 px; konzole bez
  nesouladu hydratace. Screenshoty desktopu a mobilu byly vizuálně zkontrolované.
- Regrese výpisu: 88 kontrol na 22 šířkách + 12 kontrol dlouhých SKU. Katalogová
  sada prošla při 1920/1024/390 px včetně minim, balení, filtrů a stránkování.
- Prošly `test:favorites` (18 layoutů, 386 variant, ukládání, native/fallback sdílení,
  tisk/PDF), `test:product-actions` (14 šířek, hromadné akce) a `test:theme`.
- Ověřováno proti `next start` s produkčním buildem. Vývojový server v tomto
  prostředí opakovaně skončil na nedostatku paměti; konfigurace ani diagnostiky
  nebyly kvůli tomu oslabeny. Build/testy měly omezený počet workerů.

Funkční část modalu a akcí je lokálně dokončená. Celý TASK 07 zůstává otevřený
kvůli neověřené hmotnosti. Uživatel 22. 10. 2026 schválil lokální commit tohoto bloku;
push ani nasazení nejsou součástí tohoto kroku. GitHub issues zůstaly beze změny.

### Doladění náhledu, 22. 10. 2026

Po uživatelské kontrole se náhled přednostně otevírá vlevo. Kitový `flip` dovoluje
nahoře/vpravo/dole náhradní umístění, pokud vlevo není dost místa. Šipka zůstává:
`--tooltip-arrow-background` přímo přebírá `--color-tooltip-bg`; původní přepsání
`--color-tooltip-arrow` neovlivnilo již vyhodnocený mezilehlý token a nechávalo šedý
kosočtverec. Skutečné vykreslení a shoda barvy byly ověřené při 1920/1024/390/320 px
včetně změny tokenu za běhu, fokusu a Escape. Desktop otevírá vlevo, úzký mobil nahoře.
Po úpravě znovu prošel `npm run check` včetně 161 testů a produkčního buildu.
