# Napojení N1 storefrontu

Storefront potřebuje vlastní N1 identitu, asociovaný trh a nakonfigurovanou
merchandise nabídku. Samotný import produktů ani vydání API klíče tyto kroky
nenahrazuje. Lokální a sdílené demo jsou dvě samostatná prostředí.

## Obnova hesla

N1 používá pouze veřejnou skupinu `portalAuthRecovery` z customer-context API;
nevytváří vlastní účet, token, e-mail ani náhradní provider. Request předává pouze
`email`; reset předává native `newPassword` a cookie token. Browserový JSON nemá
token field. Úspěšný reset není přihlášení ani customer admission.

`/commerce-customer-context-api/api/portal-auth/reset-password/:token` čte native
callback a přesměruje303 na pevné `/cs/obnova-hesla` bez tokenu/query. Cookie je
host-only, HttpOnly, Path=/,600s, Secure naHTTPS a SameSite=Lax. Strict byla v
browseru prokázaně rozbitá po cross-site303 z e-mailu; Lax průchod byl znovu
ověřený. Všechny password/mail POSTy nadále vyžadují stejný Origin, JSON a uzavřený
payload. Duplicitní token cookies se odmítají před owner I/O. Terminální výsledky
cookie odstraní; nejasný write se automaticky neopakuje.

**Deployment hranice:** native `requestPasswordReset` přijímá pouze email.
Odkaz generuje owner podle `COMMERCE_PORTAL_AUTH_URL`; N1 nesmí přidávat
nepodporovaný `redirectTo` ani přepisovat sdílený provider. Native mail callback
musí být legitimním deployment routingem doručený do N1 callback routy. Toto
skutečné mail→storefront směrování zatím není doložené. Browser proof se syntetickým
tokenem ověřil cookie/redirect/UI, nikoli doručení e-mailu nebo změnu hesla.

## Pořadí provisioningu

1. Ověřit cílový tenant, prodávající Legal Entity a existující N1 produkty
   veřejným staff rozhraním. Existující záznamy zachovat.
2. Ověřit existující service Principal pro `n1-storefront`. Klíč vydat pouze
   schváleným Shell identity rozhraním a uložit do chráněné serverové konfigurace
   mimo Git. Klíč nikdy nepatří do browseru ani veřejné Next proměnné.
3. Přes Storefront Registry ověřit nebo zaregistrovat aktivní aplikaci
   `n1-storefront` pro kanál B2C.
4. Přes Commerce Market Catalog ověřit nebo vytvořit N1 trh s prodávající
   Legal Entity, účinností, jurisdikcí a podporovaným locale. Asociace používá
   skutečný `marketRef` a aktuální `definitionRevisionRef` z odpovědi ownera.
5. Přes `AssociateStorefront` propojit aplikaci s trhem, kanálem a prodávajícím.
   Pro `/cs` a `/en` musí existovat odpovídající účinné asociace; jazyk UI sám
   neurčuje měnu nebo zemi doručení.
6. Merchandise `ConfigureMarket` nastaví nabídku a měnu stejného `marketId`.
   Nabídka celého katalogu má skutečnou enum hodnotu `WHOLE_CATALOGUE`.
   Kurz a zaokrouhlení jsou rozhodnutí ownera; frontend je nedoplňuje.
   Revision market settings je oddělená od globální katalogové revision.
7. Teprve po úspěšných veřejných čteních připojit FE konfigurací z README.

Používají se veřejné balíčky `@app/storefront-registry/api` a `api/client`,
`@app/commerce-market-catalog/api` a `api/client`,
`@app/merchandise/contracts/records`, `contracts/apply-command` a
`@app/merchandise/clients/apply-command`. Přímé zápisy do databází nejsou
náhrada provisioningu nebo importního rozhraní.

## Resource oprávnění a Action oprávnění

`marketAdministration.market.canAdminister:true` potvrzuje oprávnění ke zdroji.
Neznamená automaticky oprávnění vykonat explicitní Action
`commerce.market-catalog.associate-storefront`.

Při `action_permission_denied` se musí opravit schválená politika zamýšleného
operátora. Nevytvářet kvůli odmítnutí jiného aktéra nebo nový klíč operace.
Service Principal se nepřidává do People membership místo skutečných grants.

Stage politika pochází z chráněného operátorského souboru mimo repository,
nastaveného přes `ONTOS_STAGE_ACCOUNTS_FILE`. Aktuální
[StageAccountsFileSchema](../packages/core-runtime/src/install/stage-accounts-file.ts)
má `schemaVersion:4`, `scopedRoles` a `actionAuthorization` s `roleGrants` a
`actionAssertions`. Role i ověření allowed/denied musí mít správný tenant a
Legal Entity scope; nelze je odvodit z názvu role či e-mailu.

Správce použije odpovídající stage release a schválený postup
`mise exec -- pnpm authorization:provision-current-actions` s úplným vstupem.
Při rozdílu se starším dokumentačním příkladem rozhoduje aktuální schéma a
provisioning implementace. Deployment ani startup nemají tuto politiku
automaticky měnit. Viz [Action Execution](../docs/architecture/ACTIONS.md).

## Ověření skutečného propojení

- Service `current-market-catalog` musí vrátit účinnou N1 asociaci se správným
  tenantem, prodávajícím a kanálem. Samotná přítomnost N1 marketu nestačí.
- `merchandise/records` se čte s `view.storefront:true` a explicitním
  `view.storefrontCatalog.marketId`. Odpověď musí potvrdit stejné `marketId`
  a `market.configured:true`.
- Detail, vyhledávání a quote musí zůstat ve stejném scope a měně. Ověření
  proti lokálnímu vzorku nedokazuje napojení sdíleného katalogu.
- Doprava a platby čtou `storefrontCheckout` pro vybraný trh. Ceny dopravy
  už owner převedl do jeho měny; frontend je znovu nepřepočítává. Chybějící
  platební možnosti se nenahrazují GoPay nebo dobírkou z návrhové fixture.

## Historický katalog a demo sklad

Import do existujícího N1 je aditivní. Legacy SQL a exporty, přístupové údaje,
checkpointy a operátorské ledgery zůstávají mimo Git. Identita se páruje přes
`sourceProductId` a skutečné native product ID, nikoli pouze přes SKU nebo jméno.
Kolize SKU se řeší doloženým mapováním, nikoli sloučením cizích cen a variant.

Historické demo množství pochází z fyzického řádku zvoleného skladu.
Rodičovské součty a dodavatelské zásoby se znovu nepřičítají. Původní source
parent zůstává kontejner i tehdy, když výsledný native produkt nemá varianty.
Chybějící cena není nula a záporný historický zůstatek není potvrzená nula.

Kladné počáteční zásoby používají veřejný `RecordStockMovement` pro konkrétní
product/variant. `stockTracked:true` je samostatný `UpdateProduct`, až po
ověření skutečných zůstatků celého produktu a jeho variant. Známé nulové SKU
nepotřebuje nulový pohyb; zero-only produkty mají samostatnou tracking fázi.

Každá mutace má před odesláním uložený přesný payload, očekávanou revision a
nativní checkpoint. Po nejistém výsledku se nejprve vyřeší původní invocation;
nevytváří se náhradní idempotency key ani automatická vyrovnávací delta.
Ochrana původních produktů a finální stock audit patří ke stejnému importu.

## Hranice checkoutu

Současný N1 `/api/cart-quote` pouze ověřuje zboží pomocí `dryRun:true`.
Není to vytvoření objednávky. Guest `/api/checkout` má oddělené ověření s dopravou
a explicitní odeslání; `/api/checkout/status` čte pouze výsledek původního intentu.
Přijetí skutečné objednávky zase není důkaz
zaplacení. Účet, uložené adresy a platební provider vyžadují vlastní ověřené
owner rozhraní; browserová customer ID ani Figma fixture nejsou autorita.

Uživatel schválil ve formuláři vynechat firmu, druhý řádek adresy a kraj:
nativní objednávková adresa tato samostatná pole nepodporuje. Nevzniká kvůli
nim změna BE kontraktu ani ukládání do jiných polí. Souhrn respektuje také
nativní DPH včetně dopravy: čistá částka je označená jako včetně dopravy a
doprava jako část již zahrnutá v celku, bez dalšího výpočtu sazby nebo kurzu.

## C8 — native customer self-service

GET/POST `/api/customer-profile` používají veřejné own-profile API skupiny
commerce-customer-context. Každý request získá čerstvou Portal admission
v N1 tenantu; předávají se pouze filtrované Portal cookies a čerstvý audience
assertion. POST přijímá pouze displayName/contactEmail/phone/CAS version.
409 vyžaduje nové čtení, neurčitý write není automaticky opakován.
SSR viewerEmail pochází z přihlášení, nikoli z upravitelného kontaktu.

GET `/api/customer-orders?locale=cs&offset=0` a varianta s `orderId` používají
veřejný native records storefrontCustomerOrders filtr se serverem ověřeným
customerAccountId. Browserové account/party ID jsou odmítnuté. List vynechává
kontakty/adresy/nonce; detail se zpřístupní pouze pro požadovanou vlastní
objednávku. Uloženou měnu určuje veřejná native funkce orderCurrency, včetně
jejího doloženého legacy CZK kontraktu. Nejde o měnu právě prohlíženého trhu.

Adresář vyžaduje doložení Portal→Retail profilu a oprávnění; samotná provider
identita ho nenahrazuje. Aktuální guest checkout stále netvrdí přiřazení
k účtu. Chybějící native statistiky, média a právní obsah nejsou nahrazené FE.
