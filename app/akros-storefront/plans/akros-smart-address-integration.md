# TASK 17: ověření existujícího Smart Address

Aktuální FE realizaci a finální ověření vlastní
[review TASK 12–17](akros-tasks-12-17-review.md). Původní rozbor níže doplnilo
opakované živé ověření: `/api/v1/suggest` už vrátil HTTP 200 a skutečné RÚIAN
adresy, ale bez CORS hlaviček pro localhost. Storefront proto používá pevný
Next rewrite `/api/address-suggestions` na existující HTTPS endpoint.
Je to pouze transport ke skutečné službě, žádná místní databáze nebo adresní
logika. Dotaz přes localhost rewrite již vrátil stejné skutečné návrhy.
[Oficiální kontrakt Next rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites).

## Následné uživatelské review, 22. 10. 2026

- React chyba `Each child in a list should have a unique key` je reprodukovaná
  komponentovým testem s více návrhy. Unikátní ID z API jsou správně; problém
  je ve výběrovém rendereru vydaného Comboboxu: statický popisek a indikátor
  vytváří přes `createElement` jako neoznačené pole dětí. Samotné `key` na
  popisku v aplikaci nestačí. Stejný kód má i kontrolovaná verze 0.57.0.
- Dočasná oprava zůstává uvnitř storefrontu: verzovaný patch pro 0.56.1 předá
  tuto statickou dvojici jako samostatné argumenty podle [React kontraktu](https://react.dev/reference/react/createElement#caveats).
  `patch-package --error-on-fail` v `postinstall` zajistí opakovatelnou instalaci;
  klíče samotných dynamických návrhů zůstávají nezměněné. Vlastník trvalé opravy
  je UI-kit tým; patch a závislost odstranit po vydání opravené verze a průchodu
  regresního testu. Zdroj sdílené knihovny mimo storefront se neměnil.
- Request limit se sjednocuje s nasazeným SDK na 20. Dotaz
  `Bakalovo nábřeží Brno` při limitu 5 vrací jen domy 1–5, při limitu 20 všech
  8 vrácených adres. FE výsledky dodatečně nefiltruje podle vstupního textu.
- Opakované otevření posledního úspěšného dotazu zachová jeho návrhy.
  Původní nové načtení stejného dotazu vyprázdnilo položky po debouncu a mohlo
  zrušit zvýraznění těsně před Enter. Request pro změněný dotaz a retry chyby
  dál fungují; nevzniká žádná další persistovaná cache nebo adresní databáze.
- Samotná služba vrací pro `Bakalovo` HTTP 200 a žádný návrh, pro `Bakalovo ná`
  už 8 adres v Brně. Pro `Boženy Němcové Tábor` vrací při limitu 20 celkem
  11 adres z Olomouce, Teplic, Hluboček, Polné a Pardubic, žádnou z Tábora.
  Nepomohlo pořadí města, čárka, číslo domu ani táborské PSČ. Nelze tím určit,
  zda chybí zdrojový záznam, nebo selhává vyhledávání/ranking služby.
- Ve veřejném kontraktu nasazeného SDK není samostatný parametr města:
  podporuje dotaz, stát, druh návrhu, jazyk, limit a tenant/session identitu.
  FE proto nepřidává domyšlené parametry, vlastní adresní databázi ani náhradní
  zdroj. Oprava pokrytí a relevance patří do Smart Address a zůstává otevřená.
  Surové odpovědi pro předání jsou v ignorovaném
  `test-results/task-17-live/reported-streets.json`.
- Prázdný výsledek nově říká „Služba nenašla návrhy. Adresu můžete zadat ručně.“,
  nikoli že zadaná adresa neexistuje. Ruční vstup zůstává plně použitelný.
- Dvacet výsledků má scrollující seznam v panelu omezeném na token
  `--akros-address-popup-max-height` → `--dimension-container-xs` (20 rem),
  současně nejvýše na prostor změřený positionerem. Kit nemá veřejný prop/token
  pro tuto výšku, proto ji čte cílené kompoziční CSS. Test kontroluje i dostupnost
  posledního návrhu a stabilitu klávesnice po uplynutí debounce.

Následující rozbor zachovává původní průběh ověřování; aktuální stav výše ho
upřesňuje.

Finální ověření opravy: `npm run check` prošel (208 testů ve 39 souborech,
formatter, lint, TypeScript a produkční build). Jeden předchozí průchod měl
časově citlivé selhání existujícího testu šipek carouselu; samostatný běh všech
5 testů i následný celý gate prošly bez změny carouselu. Adresní browser regrese
nad finálním buildem prošla na všech 14 šířkách 320–1920 px: 20 položek,
panel nejvýše 20 rem, posun na poslední návrh, stabilní zvýraznění, obě adresy,
retry, ruční vstup, staré odpovědi a reload. Screenshoty byly prohlédnuté.
Živý test bez interceptů prošel na 1920/390 px se skutečným Bakalovým nábřežím
8/8 v Brně včetně města a PSČ; report a screenshoty jsou v
`test-results/task-17-live/`. Prošel také reverse/reapply instalačního patche.
Bez commitu, pushnutí, nasazení nebo změn poskytovatele.

Ověřeno 22. 10. 2026. Uživatel dodal vlastní existující řešení:

- [Smart Address repo](https://github.com/TechsioCZ/smart-address)
- [Nasazená česká ukázka](https://smart-suggest-shell-super-app.edution.workers.dev/cs)
- [Veřejná HTML ukázka](https://smart-suggest-shell-super-app.edution.workers.dev/sdk/demo.html)

## Co je doložené

Repo obsahuje službu, browserový SDK a dokumentované HTTP rozhraní. Pro TASK 17
tedy existuje konkrétní kandidát poskytovatele; nepotřebujeme vytvářet vlastní
databázi ani simulovat adresní návrhy. Ve storefrontu zůstane jeho současný UI kit.

Veřejná dokumentace `apps/docs/content/cs/reference/service-api.md` popisuje
`GET /suggest` s `text`/`q`, `countryCode`, `locale`, `limit` a `strategy`.
SDK reference nabízí `createClient`, `suggest` a přerušení přes `AbortController`.
Návrh obsahuje `address.line1`, `city`, `postalCode` a `countryCode`; jednotlivé
části jsou volitelné, takže záznam nemusí být úplnou doručovací adresou.
Kontrolovaná větev main: `85c6883c799d53926ad381784a56b75cda49b4ae`.

Živé demo má našeptávání adresy, města a PSČ, českou jazykovou variantu a ruční
zadání. V prohlížeči po zadání „Václavské náměstí 1“ volá jiný kontrakt:

`GET /api/v1/suggest?countryCode=CZ&countryCodes=CZ&kind=address&language=cs&limit=20&q=…`

HTML demo načítá veřejný `/sdk/techsio-smart-suggest.js`. Jeho schema obsahuje
také `street`, `houseNumber` a `orientationNumber`. Dokumentaci main proto nelze
automaticky považovat za přesný kontrakt tohoto deploye nebo jeho SDK.

## Aktuální omezení živého ověření

- Stránka `/cs` i HTML/JS ukázka vrací HTTP 200.
- Prohlížeč při dotazu ukázal nedostupnost služby a nabídl ruční zadání.
- Přímý stejný typ GET požadavku s limitem 5 vrátil HTTP 503, Cloudflare 1102,
  „Worker exceeded resource limits“. Jde o pozorovaný stav konkrétního deploye,
  nikoli závěr, že je chybná celá knihovna nebo její implementace.
- Na chybové odpovědi nebyla CORS hlavička; z tohoto selhání nelze určit CORS
  úspěšné služby. Použitelnost přímo z localhostu/Vercelu není dosud ověřená.
- Nebyl získán úspěšný výsledek, takže skutečné doplnění polí zatím nebylo možné
  ověřit. Nic se neodesílalo přes potvrzení objednávky nebo accept endpoint.

## Doporučené napojení storefrontu

1. Použít existující službu přes její veřejné rozhraní; nekopírovat backend,
   databázi ani privátní zdroje jiných deploymentů do storefrontu.
2. Sladit správnou verzi SDK/API s deployem a ověřit funkční návrh, případná
   oprávnění a CORS pro localhost a nasazený AKROS. Chybu provozu řeší vlastník
   služby mimo tento storefrontový úkol.
3. Napojit fakturační a dodací `AddressFields`: nabídka návrhů v kit komponentě,
   po výběru ulice/číslo domu, město, PSČ a země. Jméno, telefon ani jinou adresu
   tím nepřepisovat. Neúplná pole ponechat k ručnímu doplnění.
4. Zachovat ruční editaci, debounce, zrušení staršího dotazu, klávesnici,
   načítání, prázdný výsledek a neblokující chybu. UI z demo aplikace nepřenášet.
5. Ověřit reálné doplnění obou adres, česká čísla domu, neúplný návrh, přepsání
   dotazu a výpadek na desktopu i mobilu. Testy mohou izolovat odpovědi služby,
   ale do produktu nevkládat lokální náhražku poskytovatele.

Výsledek rozboru: **ano, vhodné existující řešení pro FE integraci TASK 17**.
Zdroj už je identifikovaný; před funkční implementací zbývá potvrdit dostupný
nasazený kontrakt. Tento krok pouze aktualizuje plán, nic neimplementuje ani
nenasazuje a nemění GitHub issue.
