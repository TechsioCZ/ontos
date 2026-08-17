# Czech ARES lookup by IČO

Research date: 2026-08-17

## Recommendation

Use the public ARES REST API through an OntOS server-side integration:

1. Normalize the entered IČO to exactly eight digits, preserving or restoring leading zeroes.
2. Fetch the consolidated subject record with `GET /ekonomicke-subjekty/{ico}`.
3. Use its registration states to decide whether to fetch activity detail from the public register (VR), the Trade Licensing Register (RŽP), or both.
4. Cache/debounce lookups and map upstream errors into OntOS's typed BFF error contract.

Direct browser calls currently work, but a server-side adapter is the safer production boundary for centralized validation, caching, throttling, observability, and insulation from undocumented CORS/authentication changes.

## What “business subject” can mean

There are three different useful representations of what a subject does:

- `czNace` / `czNace2008` on the consolidated record are structured economic-activity classification codes.
- VR `cinnosti.predmetPodnikani`, `predmetCinnosti`, `doplnkovaCinnost`, and `ucel` are registered legal text from the public register.
- RŽP `zivnosti[].predmetPodnikani` and `zivnosti[].oboryCinnosti[].oborNazev` describe trade licences and their activity fields.

They are not interchangeable. For an identity/address autofill, the consolidated endpoint is enough. For a user-facing “předmět podnikání” field, collect source-specific VR and RŽP data and label its source. This distinction and the field contracts are defined in the current [official OpenAPI document](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs) and [Ministry of Finance technical catalogue, version 1.30](https://www.mfcr.cz/assets/attachments/2023-08-01_ARES-Technicka-dokumentace-Katalog-verejnych-sluzeb_v07.pdf).

## Required lookup: consolidated subject

```http
GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}
Accept: application/json
```

The path parameter must be an eight-digit string (`^\d{8}$`); there is no request body. The ARES website accepts omitted leading zeroes in its UI, but the REST contract requires all eight digits, so the client must pad before calling. See the [`GET /ekonomicke-subjekty/{ico}` OpenAPI operation](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs) and the [official ARES search help](https://ares.gov.cz/stranky/napoveda-ekonomicke-subjekty).

Example:

```http
GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/48039101
```

The current response includes these useful fields:

```json
{
  "ico": "48039101",
  "obchodniJmeno": "J.E.S., spol. s r.o.",
  "sidlo": {
    "textovaAdresa": "Pod špejcharem 1561, Zbraslav, 15600 Praha 5"
  },
  "pravniForma": "112",
  "datumVzniku": "1992-12-04",
  "datumZaniku": null,
  "czNace": ["43350", "800", "431"],
  "czNace2008": ["011", "016", "2572"],
  "seznamRegistraci": {
    "stavZdrojeVr": "AKTIVNI",
    "stavZdrojeRzp": "AKTIVNI"
  },
  "primarniZdroj": "ros"
}
```

Arrays are abbreviated in this example. Other useful fields defined by the schema include the structured parts of `sidlo`, `pravniFormaRos`, `dic`, `financniUrad`, `datumAktualizace`, `dalsiUdaje`, and `icoId`. `pravniForma`, `czNace`, and `czNace2008` are codes rather than display labels. These fields are documented in the [official OpenAPI schemas](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs); the example values were verified against the [live official endpoint](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/48039101).

## Optional registered-activity detail

### Public register (VR)

```http
GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-vr/{ico}
```

Read the primary record in `zaznamy[]` and its `cinnosti` object. In particular:

```text
zaznamy[].primarniZaznam
zaznamy[].stavSubjektu
zaznamy[].cinnosti.predmetPodnikani[].hodnota
zaznamy[].cinnosti.predmetPodnikani[].datumZapisu
zaznamy[].cinnosti.predmetPodnikani[].datumVymazu
zaznamy[].cinnosti.predmetCinnosti[]
zaznamy[].cinnosti.doplnkovaCinnost[]
zaznamy[].cinnosti.ucel[]
```

The arrays include historical values; an omitted `datumVymazu` indicates that the item has not been recorded as removed. Do not flatten historical and current text without preserving the dates. The structure is defined by the `EkonomickySubjektVr`, `ZaznamVr`, `CinnostiVr`, and `ObecnyTextVr` schemas in the [official OpenAPI document](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs).

### Trade Licensing Register (RŽP)

```http
GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty-rzp/{ico}
```

This source is important for sole traders and for trade-licence detail. Read:

```text
zaznamy[].primarniZaznam
zaznamy[].zivnostiStav
zaznamy[].zivnosti[].predmetPodnikani
zaznamy[].zivnosti[].druhZivnosti
zaznamy[].zivnosti[].datumVzniku
zaznamy[].zivnosti[].datumZaniku
zaznamy[].zivnosti[].platnostDo
zaznamy[].zivnosti[].oboryCinnosti[].oborNazev
zaznamy[].zivnosti[].oboryCinnosti[].platnostOd
zaznamy[].zivnosti[].oboryCinnosti[].platnostDo
```

The structure is defined by the `EkonomickySubjektRzp`, `ZaznamRzp`, `Zivnost`, and `ZivnostOborCinnosti` schemas in the [official OpenAPI document](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs). A source-specific call may return `404` when the IČO is not present in that register; use `seznamRegistraci.stavZdrojeVr` and `stavZdrojeRzp` from the consolidated response to avoid unnecessary calls.

## Resolving coded values

The consolidated API returns legal form and CZ-NACE as codes. ARES exposes its own code-list endpoint:

```http
POST https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ciselniky-nazevniky/vyhledat
Content-Type: application/json

{
  "start": 0,
  "pocet": 1000,
  "zdrojCiselniku": "res",
  "kodCiselniku": "PravniForma"
}
```

Use `CzNace` for CZ-NACE 2025 and `CzNace2008` for the older classification. Include `zdrojCiselniku`, because the same code-list name can exist for multiple sources. Fetch and cache code lists independently of an IČO lookup rather than requesting them on every keystroke. The endpoint and filter schema are part of the [official OpenAPI contract](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs); ARES documents the CZ-NACE 2025 transition in its [official API changelog](https://ares.gov.cz/stranky/changelog-api).

## Authentication

No API key, client registration, or user login is needed for these public lookup calls today. The Ministry says the API can be used by anyone who respects its operating conditions, and describes it as an interface for exposing public source-register data on its [official developer page](https://ares.gov.cz/stranky/vyvojar-info). Anonymous calls to the consolidated, VR, and RŽP endpoints returned `200` during this research.

There is a documentation inconsistency: the published OpenAPI document is titled `ARES: REST API - veřejné`, but also declares global Basic and Bearer security schemes and lists `401` among possible responses. Since the official public service currently accepts anonymous requests, the integration should send no credentials, but keep authentication/CORS behavior isolated behind the adapter rather than assuming this undocumented detail can never change. See the [raw OpenAPI document](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs) and [official Swagger UI](https://ares.gov.cz/swagger-ui/).

## Limits and operating terms

The Ministry of Finance may restrict or block access when a user:

- sends more than **500 requests per minute**;
- repeatedly sends identical or incorrectly filled requests;
- creates too many concurrent automated requests;
- evades limits through multiple IP addresses;
- probes the database automatically with random data or produces mostly invalid requests; or
- attempts to defeat server security.

These are blocking conditions, not a guaranteed quota protocol; the official API contract does not document rate-limit response headers or a structured `429` response. Debounce IČO input, call only once the normalized value is valid, cache results, limit concurrency, and apply bounded retry/backoff only to retryable failures. The authoritative wording is in the [official operating conditions](https://ares.gov.cz/stranky/podminky-provozu) and is repeated on the [developer page](https://ares.gov.cz/stranky/vyvojar-info) and [FAQ](https://ares.gov.cz/stranky/faq).

ARES data is informational only, is not an official document, and is not guaranteed to be current, complete, or continuously available. The Ministry disclaims liability for damage caused by use of the data; ARES also warns that source updates can lag, potentially by up to two weeks. The UI should identify ARES as the source and avoid presenting a lookup as authoritative verification. See the [official operating conditions](https://ares.gov.cz/stranky/podminky-provozu), [description of ARES](https://ares.gov.cz/stranky/popis), and [FAQ](https://ares.gov.cz/stranky/faq).

## Errors

The official contract documents these statuses for the lookup operations:

| Status | Meaning in ARES documentation |
| ------ | ----------------------------- |
| `200`  | OK                            |
| `400`  | Input error                   |
| `401`  | Authentication error          |
| `403`  | Access denied                 |
| `404`  | Resource not found            |
| `500`  | Unexpected error              |

Error responses use this JSON shape:

```json
{
  "kod": "CHYBA_VSTUPU",
  "popis": "...",
  "subKod": "VSTUP_NEVALIDNI_FORMAT_ICO"
}
```

The published error-code enum includes `OBECNA_CHYBA`, `CHYBA_VSTUPU`, `NENALEZENO`, `NENI_IMPLEMENTOVANO`, `NEPRIHLASENY_UZIVATEL`, and `NENI_OPRAVNENI`. A live invalid-format lookup returned `400` with `CHYBA_VSTUPU` / `VSTUP_NEVALIDNI_FORMAT_ICO`; a syntactically valid but nonexistent IČO returned `404` with `NENALEZENO` / `VYSTUP_SUBJEKT_NENALEZEN`. Statuses and the `Chyba` schema are documented by the [OpenAPI contract](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs) and [technical catalogue](https://www.mfcr.cz/assets/attachments/2023-08-01_ARES-Technicka-dokumentace-Katalog-verejnych-sluzeb_v07.pdf).

The OntOS adapter should distinguish at least invalid IČO (`400`), no subject (`404`), upstream denial/throttling, upstream unavailability, timeout, and response-decode failure. A source-detail `404` must not erase a successful consolidated record.

## Browser-direct and CORS assessment

Live checks on 2026-08-17 found:

- anonymous GET responses include `Access-Control-Allow-Origin: *`;
- an OPTIONS preflight allows `GET`, `HEAD`, and `POST`;
- the preflight allows the requested `content-type` header; and
- preflight caching is advertised for 1,800 seconds.

Therefore, credential-free browser GETs are technically possible today, and JSON POSTs can pass the current preflight. These headers were verified on the [live consolidated endpoint](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/48039101), but CORS behavior is not stated as a stability guarantee in the OpenAPI document or operating conditions. Production OntOS code should therefore call ARES server-side; a direct browser integration is reasonable only for a prototype or where loss of the feature after a CORS-policy change is acceptable.

## Minimal production data flow

```text
IČO input
  -> strip formatting, validate digits, pad to 8 characters
  -> GET consolidated subject
  -> show name, address, dates and decoded legal form
  -> inspect seznamRegistraci
      -> if VR active and legal registered text is needed: GET VR detail
      -> if RŽP active and trade detail is needed: GET RŽP detail
  -> preserve source and validity dates on activities
```

The current public API is version **1.30** on the [official developer page](https://ares.gov.cz/stranky/vyvojar-info), while its machine-readable OpenAPI `info.version` is written as **1.3.0**. Monitor the [official API changelog](https://ares.gov.cz/stranky/changelog-api) before upgrading the integration.
