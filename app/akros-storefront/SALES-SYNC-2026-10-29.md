# AKROS: aktualizace sales větve a dostupnost backendu

Pracovní větev: `demo/sales-crm-updated`. Aktualizace připojuje
`demo/sales-crm` na `0a9629a6a433667e22de2bc9e61bd7b8d301578c`
k původnímu UI checkpointu `bcac625fa`.

## Backend poskytuje, storefront dosud nepoužívá

| Funkce                         | Existující backend                                                                                    | Mezera storefrontu                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zapomenuté heslo               | `shared/portal-auth/recovery-api.ts`: `request-password-reset`, `reset-password` a tokenový callback. | Chybí požadavek na obnovu, stránka nastavení hesla z tokenu a napojení tohoto callbacku. Nejde o změnu hesla přihlášeného zákazníka se současným heslem.          |
| Dvoufázové ověření             | `shared/portal-auth/mfa-api.ts`: OTP, TOTP, záložní kódy a správa MFA.                                | Přihlášení přijímá jen `SESSION_CREATED`; jiný výsledek odmítne hláškou o zákaznickém portálu. Chybí dokončení MFA challenge. Není součástí původních TASK 01–20. |
| Hmotnost samostatného produktu | Merchandise má volitelné `weightGrams`; veřejná projekce produktu zachovává tento údaj.               | `catalog-projection.ts` hodnotu nemapuje. Před použitím je potřeba potvrdit vztah k prodejní jednotce; hmotnost kontejneru nelze přenášet na jeho různé varianty. |

Zákaznická správa adres má existující doménové čtení, akce a persistenci,
ale chybí zákaznický kontrakt, který vybere vlastní profil ze session.
`/api/portal-auth/customer-profile` obsahuje pouze jméno, telefon, kontaktní
e-mail a verzi. To je integrační závislost na backendu, nikoli důvod k mocku.

Pro plný TASK 07 a TASK 16 chybí normalizovaná hmotnost konkrétní varianty
za prodejní jednotku. Pro TASK 15 chybí vystavená přímá změna hesla v účtu.
Hlídání dostupnosti variant nemá v dosud ověřeném zákaznickém API smluvený
kontrakt. Tyto položky tato aktualizace neoznačuje jako dokončené.

## Již zapojené části

- Nativní katalog, ceny, dostupnost, balení, přepočet košíku a objednávky.
- Zákaznické přihlášení, registrace, opětovné odeslání ověřovacího e-mailu
  a průběh registrace. Z cílové větve přichází další opravy dokončování registrace.
- Kontaktní profil zákazníka a skutečné newsletterové souhlasy.
- Historie a detail objednávek; opakování objednávky přes aktuální katalog
  a ověření košíku. Přítomná implementace sama nepotvrzuje úspěšný živý test účtu.
- Produktové dotazy a reklamace přes nativní evidenci požadavků.
- Stav e-mailů k objednávce; cílová větev jej nově zobrazuje také na potvrzení objednávky.

## Řešení konfliktů aktualizace

- `with-demo-env.mjs`: převzaté startovní naslouchání na `127.0.0.1` z cílové větve.
- `account-orders.tsx`: zachované naše akce opakování a vzhled, odstraněný nepoužitý reexport podle cílové větve.
- `add-to-cart-button.tsx`: zachované předávání cenových hladin a blokové tělo callbacku z cílové větve.
- `pnpm-lock.yaml`: nové závislosti cílové větve a původní lokální oprava React klíčů Comboboxu pro UI-kit 0.57.0.
- `.gitattributes`: LF pro patche a generované Shell UI kandidáty. Příprava
  commitu na Windows je jinak převáděla na CRLF a blokovala instalaci i hooky.

## Validace

- Instalace s `--frozen-lockfile`: prošla.
- Lint storefrontu: prošel s existujícími varováními.
- Produkční build storefrontu včetně jeho typové kontroly: prošel.
- Testy storefrontu: 541/541 prošlo. Nové testy potvrzení objednávky používají
  stejný `CartProvider` jako skutečný layout; původní aserce zůstávají zachované.
- Prohlížeč: 104 rozložení ve 13 šířkách a scénáře dialogu variant, adres,
  profilu a opakování objednávky; žádná chyba ani neúspěšná kontrola.
  Používá izolované testovací fixture, nepotvrzuje živý zápis objednávky do BE.
- Windows generátor module contractů: 13/13 testů prošlo.
- Shell UI kandidáty: regenerace a kontrola všech 27 modulů prošla po
  doplnění LF pravidla; obsah generovaných kandidátů se nezměnil.
- Plný `pnpm check`: neprošel. V testech lint pravidel prošlo 309/320 testů.
  Selhání zahrnují Windows ESM cesty a tři nálezy `effect-native(no-instanceof)`
  v `scripts/ci/release-ledger.mts` a `scripts/ci/deploy-plan.mts`.
  Tyto skripty i testy pravidel jsou shodné s připojenou cílovou větví.
  Diagnostiky ani kontrolní pravidla nejsou vypnuté; další fáze tohoto gate
  se po selhání nespustily.

První samostatná typová kontrola workspace nedoběhla; souběžná validace
kontraktů skončila `VirtualAlloc ... errno=1455`, `fatal error: out of memory`.
Opakovaná typová kontrola bez souběžné validace také skončila stejnou chybou
alokace paměti Windows a kódem 2. Nebyla ručně ukončená a neběžel vlastní
paměťový watchdog. Úspěch workspace typechecku není doložený.
Samostatná opakovaná validace kontraktů prošla (`UltraModern workspace
validated`, návratový kód 0).
Logy této revize jsou v ignorovaném `test-results/visual-parity/sales-sync-*`.
Historické reporty z 27. 10. zůstávají důkazy tehdejší revize, nikoli potvrzením
aktuálního stavu všech funkcí. Tato aktualizace nespouštěla nové živé backendové
end-to-end ověření.

## Stav commitu

Konflikty merge jsou vyřešené. Merge zatím není commitnutý ani pushnutý.
Pre-commit formátování prošlo; lint zablokoval nezměněný převzatý
`scripts/demo/mcp-oauth-e2e/browser.mts:38` pravidlem
`effect-native(no-promise-shaped-port)`.

`SharedClient.openTab` je deklarace externího mostu načítaného z pevné macOS
cesty `/Volumes/TraceDecayKingston/techsio-demo/shared-browser/client.mjs`.
Soubor na tomto Windows počítači není dostupný. Model v
`tools/oxlint/effect-native/shared/foreign-decoded-port-proof.ts` vyžaduje
skutečný soubor mimo stejný Git repozitář a ověřitelný async export;
nevyřešenou cestu záměrně odmítá. Test `foreign-decoded-port.test.mts`
obsahuje pozitivní reprodukci tohoto skriptu s existujícím externím modulem
i negativní kontrolu chybějícího modulu.

Pravidlo ani negativní kontrola nebyly změněné. Pro dokončení commitu je
potřeba přenositelné řešení tohoto externího demo driveru v cílové větvi;
nebyl vytvořen fiktivní modul, lokální výjimka ani obejit Git hook.
