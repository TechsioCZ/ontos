# TASK 12: rozbor „Objednat znovu“

Aktuální FE akce a její ověření jsou v [review TASK 12–17](akros-tasks-12-17-review.md).
Následující dokument je původní rozbor dat a zamítnuté simulace; neznamená,
že by nadále chybělo UI akce. Skutečná serverová operace dosud připojená není.

Stav: původní návrh lokální simulace se po upřesnění uživatele nerealizuje.
Dodáváme pouze FE storefront; aktuální hranici a další postup vlastní
[audit zbývajících úkolů](akros-remaining-fe-scope.md). Nezakládat archiv lokálních
objednávek ani nové provázané fixtures pro napodobení backendu. Předchozí otázka
na podobu simulace již nevyžaduje odpověď. TASK 12 zatím není implementovaný.
Předchozí TASK 11 je v commitu `e1b99fe8`.

## Zadání a současná data

[Otevřené issue #1310](https://github.com/TechsioCZ/ontos/issues/1310), ověřené 22. 10. 2026, požaduje akci v historii, vložení původních položek do aktuálního
košíku a respektování aktuální dostupnosti a stavu variant. Má pouze label `bug`;
issue ani projekt se při rozboru nemění.

- `src/mock-storefront/fixtures/account.ts`: pět demo souhrnů objednávek.
  Pouze první má společný ukázkový seznam řádků; jejich kódy nemají ověřenou vazbu
  na katalog. Ostatní detaily správně říkají, že položky nejsou dostupné.
- `src/mock-storefront/local-order.ts` a `features/checkout/checkout-provider.tsx`:
  checkout ukládá poslední skutečně dokončenou demo objednávku do sessionStorage,
  včetně snapshotu košíku s produktovými a variantními ID a množstvím.
  Historie tyto objednávky dosud nezobrazuje a další dokončení přepíše poslední.
- `features/account/account-orders.tsx` a `account-order-detail.tsx`: historie má
  desktopovou tabulku a mobilní karty, ale chybí opakované objednání.
  Detail route nyní zná pouze statické demo objednávky.
- `mock-storefront/cart.ts`: shodné řádky se slučují podle produktového a variantního
  ID. Existující `add` však ponechává starý snapshot ceny/skladu a množství potichu
  normalizuje. Pouhá smyčka `dispatch(add)` tedy pro tento úkol nestačí.

## Původní návrh simulace — neimplementovat

1. V historii i detailu bude „Objednat znovu“. Otevře přehled řádků se skutečným
   objednaným množstvím, dnešní cenou a výsledkem ověření proti katalogu.
2. Vyprodané, odstraněné, nejednoznačné nebo neoceněné položky se nepřidají;
   přehled vždy uvede důvod. SKU se nesmí používat jako náhradní jednoznačná
   identita, pokud je ve zdroji sdílené mezi více variantami.
3. Výchozí požadavek je původní množství v základní prodejní jednotce. Balení se
   znovu nenásobí. Případnou změnu kvůli minimu, kroku nebo skladu je nutné ukázat
   před potvrzením. U sloučené varianty se posuzuje celkové výsledné množství.
   Pokud už má košík více, než dovoluje dnešní sklad, opakování jeho obsah nesníží.
4. Potvrzení přidá schválená množství do aktivního pojmenovaného košíku, zachová
   nesouvisející obsah a aktualizuje snapshot slučovaných variant. Výsledek oznámí
   počet přidaných a vynechaných řádků a nabídne odkaz do košíku.
5. Dvojklik nesmí přidat položky dvakrát. Změna aktivního košíku nebo jeho obsahu
   během otevřeného přehledu vyžaduje nový přehled před přidáním.
6. Pro demo doplnit odlišné provázané řádky ke stávajícím ukázkovým objednávkám
   a zahrnout lokálně dokončené objednávky. Zachovat historickou cenu jako údaj
   objednávky; dnešní cenu dohledat zvlášť. Není to integrace skutečného účtu.

Tento původní návrh byl nahrazen uživatelovým upřesněním FE rozsahu. Body níže
zachycují dřívější rozbor; nejsou současným implementačním pokynem.

## Komponenty a technický postup

Použít publikovaný UI kit 0.56.1: `Button` pro akci (`size="sm"`, v historii
`theme="outlined"`), `Dialog` (`size="xl"`, modal uprostřed), `Table`
(`size="sm"`, `variant="line"`) pro přehled a `LinkButton` pro košík.
Mobilní zobrazení složit jako přehledné řádky/karty místo široké tabulky.
Zachovat existující dialogové tokeny a návrat focusu; nepřidávat nový stín.
Veřejné API ověřené v instalovaných declaration souborech; vzor dialogu je
`src/components/variant-selection-dialog.tsx`, historie už používá kit `DataTable`.

Po rozhodnutí postupovat ve třech krocích:

1. Doplnit konkrétní reference řádků, historii lokálních objednávek a bezpečné
   načtení dosavadní poslední objednávky. Historie a detail musí číst stejná data.
2. Napsat čisté vyhodnocení aktuálních variant a jednu operaci přidání celé sady
   do košíku. Regresní testy musí zachytit staré snapshoty i změnu košíku mezi
   přehledem a potvrzením.
3. Zapojit akci, zvolený přehled/výsledek a browserové ověření. Nenavazovat
   implementaci na dosud neověřený jednotkový význam hmotnosti v TASK 16.

## Nutné ověření implementace

- Dvě odlišné objednávky přidají své vlastní položky, včetně skutečné lokální
  objednávky dokončené přes checkout; reload zachová správný výsledek.
- Cena se bere z aktuálního katalogu; původní detail objednávky se nemění.
- Chybějící varianta, nulový sklad, minimum/krok, desetinná množství, více balení,
  součet s existujícím množstvím a plný skladový limit mají vysvětlený výsledek.
- Aktivní pojmenovaný košík dostane položky, ostatní košíky a nesouvisející řádky
  zůstanou zachované; opakovaný klik a změna košíku nepřidají nic nečekaně.
- Historie, detail, dialog, klávesnice, focus a nepřetékání na 320/390/768/1024/1920 px.
- Cílené unit/component testy, plné `npm run check`, browserová regrese účtu,
  košíku a dokončení objednávky. Testy browseru nepouštět souběžně s plnou sadou.
