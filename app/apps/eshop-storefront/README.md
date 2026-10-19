# Kavárna Doma – DEMO e-shop (storefront)

Zákaznická prezentační aplikace nad OntOS pro firmu **Kavárna Doma s.r.o.** (LE `71000000-0000-4000-8000-000000000023`).
Jen lokální demo na `http://localhost:3060`, nic se nenasazuje. Bez přihlášení zákazníka.

> E-shop je prezentační demo. Žádné zboží vám nebude doručeno a nic neplatíte.

## Spuštění

```bash
cd app
apps/eshop-storefront/scripts/demo-restart.sh     # build + start na :3060 (z runtime worktree, pid pro down.sh)
mise exec -- pnpm --dir apps/eshop-storefront typecheck
```

Vývoj bez backendu: `ESHOP_FIXTURE=1 ESHOP_STOREFRONT_PORT=3062 node apps/eshop-storefront/server/server.ts`
(lokální testovací data; `/api/health` vrací `fixture: true`, demo tak nikdy neběží).

Browserový průchod (headless, desktop + 390 px):

```bash
PLAYWRIGHT_BROWSERS_PATH=…/ms-playwright PLAYWRIGHT_MODULE=…/playwright/index.js BASE=http://localhost:3060 \
  OUT=/Volumes/TraceDecayKingston/techsio-demo/v2/shots/storefront node apps/eshop-storefront/scripts/verify-flow.mjs
```

## Architektura (E00)

- Rsbuild + React SPA (`src/`) a malý Node BFF (`server/`) na jednom portu. Prohlížeč volá jen `/api/*`.
- BFF drží `ONTOS_STOREFRONT_API_KEY` (z `app/.env.demo.local`, principal `kavarna-storefront`, kind service).
  Klíč se nikdy neposílá do prohlížeče: JS bundle, HTML ani odpovědi `/api/*` ho neobsahují.
- Volání OntOS stejnou cestou jako `tools/ontos-agent-mcp`: `POST /shell-super-app-api/auth/api-key/gateway-context`
  (audience `merchandise`, legalEntityId 0023) → jednorázová assertion → governed Read/Action přes shell.
  Core vyhodnocuje oprávnění a rozsah právnické osoby; URL ani host nejsou autorizace.

| Obrazovka | BFF | OntOS Read / Action | Chybové stavy |
| --- | --- | --- | --- |
| Úvod, kategorie, výpis, hledání, filtry | `GET /api/home`, `/api/categories`, `/api/products?q&kategorie&cena_od&cena_do&dostupnost&razeni` | merchandise `reads/records` `{view:{storefront:true}}` (jen publikované a aktivní) | načítám, prázdný výsledek, chyba + Zkusit znovu, 403 nepovoleno |
| Detail produktu, varianty | `GET /api/products/:slug` | totéž; `variantRecords[].grossPriceMinor/availability/sku` | 404 neznámý produkt, „Cena není dostupná“, „Dostupnost nelze ověřit“ |
| Košík (lokální, `localStorage`) | `POST /api/cart/validate` | čerstvý records read při každé kontrole | změna ceny → „Přijmout novou cenu“, nedostupné, nelze ověřit |
| Odeslání DEMO objednávky | `POST /api/orders` | `merchandise/actions/apply-command` `PlaceStorefrontOrder` (`clientRequestId` = submissionId) | 400 formulář, 409 změna ceny/dostupnosti, 5xx bez potvrzení |
| Potvrzení (i po obnovení) | `GET /api/orders/:submissionId` | records `{view:{storefront:true, orderClientRequestId}}` | 404, chyba |
| Obrázky | `GET /img/<slug>[--2,--3].svg` | názvy z katalogu; `images: []` → „Bez obrázku“ | – |

Jednou odeslat: submissionId vzniká jednou za pokladnu a opakuje se při dvojkliku i opakování. BFF slučuje souběžné
požadavky, Idempotency-Key = submissionId + hash payloadu a vlastník merchandise ukládá podle `clientRequestId` právě
jednou (`REPLAYED` vrátí totéž číslo).

## Živé / simulace / chybí

- **Živé z OntOS:** katalog, varianty, ceny s DPH (počítá server vlastníka), dostupnost, uložení DEMO objednávky,
  její číslo a stav; změna ceny nebo skladu v administraci (`/cs/provoz/produkty`) se projeví po obnovení.
- **Simulace:** doprava (4 ukázkoví dopravci), platba „neplatíte nic“, žádné e-maily, rezervace ani expedice.
- **Není součástí:** produkční košík/checkout, platby, dopravci, doklady, SEO (stránky mají `noindex`).

## Scénář pro obchodníka (5–8 min)

1. `http://localhost:3060` – štítek DEMO, katalog z OntOS.
2. Kategorie → filtr ceny/dostupnosti (parametry v URL přežijí obnovení) → detail → přepnout variantu (cena, SKU, dostupnost).
3. Administrace (`eshop@kavarna.demo` / `password1234`, `http://localhost:3020/cs/provoz/produkty`): změnit cenu varianty.
4. Obnovit detail na storefrontu → nová cena. Pokud byla v košíku: košík ukáže „Cena se změnila“ a vyžádá potvrzení.
5. Dvě položky do košíku, upravit množství, Pokračovat.
6. Pokladna → „Vyplnit ukázkové údaje“ → doprava → přečíst upozornění → „Potvrdit DEMO objednávku“.
7. Potvrzení „DEMO objednávka č. OBJ-2026-… byla uložena do administrace“; obnovit stránku = stejné číslo.
8. Administrace → Objednávky → najít číslo → upravit položky/dopravu → stavy až „Předáno dopravci (simulace)“ a „Dokončená“.
