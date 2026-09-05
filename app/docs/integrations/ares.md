# Czech ARES evidence lookup by IČO

Research verified: 2026-09-01

> [!IMPORTANT]
> This document owns the ARES provider protocol, normalized evidence, and adapter resilience. Party
> identity, matching, correction, and canonical writes follow
> [Party Registry](../architecture/PARTY_REGISTRY.md). ARES never writes Party state directly.

## Ownership

ARES is an External Evidence Provider. It can supply observations about a Czech economic subject,
but it is not the System of Record for an OntOS Party.

The `party.registry` MicroVertical owns:

- Party Matching and Party Create decisions;
- accepted `ICO` and `CZ_DIC` Official Identifier assertions;
- accepted Party name and registered-address assertions;
- conflict, confirmation, and Party Correction decisions;
- the Domain Events and Outbox Messages created by those Actions.

The owner-local Direct Provider Adapter owns:

- ARES request and response schemas;
- HTTP construction, timeout, retry, throttling, caching, and coalescing;
- provider error mapping and diagnostics;
- translation into the bounded provider-neutral evidence envelope.

Connector Registry owns a provider-issued record correlation when OntOS must retain one. ARES
record identifiers are not Party Official Identifiers merely because they are stable at the
provider.

## Supported V1 route

V1 performs a read-only lookup by an already normalized Czech IČO:

```http
GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}
Accept: application/json
```

The public provider contract is documented by the
[official OpenAPI document](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs) and
[Swagger UI](https://ares.gov.cz/swagger-ui/).

Input rules:

1. trim surrounding whitespace at the user-input boundary;
2. require exactly eight decimal digits;
3. preserve leading zeroes;
4. do not guess or pad shorter input;
5. never accept Tenant, Principal, Legal Entity, Party, or authorization identity from the lookup
   payload.

The browser calls a generated governed Read. Only the private server-side adapter calls ARES.

## Normalized evidence envelope

A successful lookup returns bounded external evidence, not a mutable Party object:

```text
AresSubjectEvidence {
  provider = "ares"
  queryIco
  observedAt
  providerRecordRef?
  subject {
    ico
    businessName?
    dic?
    registeredAddress?
    legalFormCode?
    establishedOn?
    dissolvedOn?
  }
  sourceStates?
}
```

The exact Effect Schemas belong to the owning MicroVertical. They must reject unknown unbounded
payload retention and preserve enough source metadata to explain when and from where each
observation was obtained.

Provider fields commonly used by the consolidated subject route include:

```text
ico
obchodniJmeno
dic
sidlo
pravniForma
pravniFormaRos
datumVzniku
datumZaniku
datumAktualizace
seznamRegistraci
primarniZdroj
icoId
```

Their presence in the provider response does not authorize Party Registry to apply them. The Party
contract owns the allowlist and fact-specific authority policy.

## Read outcomes

The governed Read distinguishes at least:

```text
FOUND
NOT_FOUND
INVALID_INPUT
AMBIGUOUS_PROVIDER_RESULT
PROVIDER_DENIED
PROVIDER_THROTTLED
PROVIDER_UNAVAILABLE
PROVIDER_TIMEOUT
PROVIDER_RESPONSE_INVALID
```

`NOT_FOUND` is a valid provider result. Timeout, denial, throttling, transport failure, response
decode failure, and unavailable provider are failures and must never be interpreted as `NOT_FOUND`
or `NO_MATCH`.

The BFF maps expected failures exhaustively to the repository's typed Problem Details contract. It
does not expose raw provider bodies, secrets, stack traces, or internal URLs.

## Adapter resilience

The Direct Provider Adapter must:

- use a bounded request timeout;
- retry only explicitly retryable provider failures with bounded backoff;
- coalesce concurrent lookups for the same normalized IČO;
- bound global concurrency and cache size;
- cache only successful immutable evidence envelopes for a bounded period;
- expose observation and cache age to the caller;
- never cache validation, denial, not-found, decode, or transport failures as successful evidence;
- respect the current
  [official operating conditions](https://ares.gov.cz/stranky/podminky-provozu);
- keep authentication and CORS assumptions private to the adapter so provider changes do not alter
  Party contracts.

A cache changes transport cost, not fact authority. Cached evidence remains external evidence with
its original `observedAt` and must pass the same Party policy as a fresh response.

The implemented adapter uses a three-second timeout covering response headers and body decoding,
at most two bounded exponential retries, a five-minute successful-result cache capped at 256
entries, same-IČO request coalescing, and four concurrent provider requests. These implementation
settings do not change the dated external research above.

## Canonical apply boundary

The supported flow is:

```text
Party Candidate or existing Party flow
  -> generated governed ARES lookup Read
  -> owner-local Direct Provider Adapter
  -> normalized AresSubjectEvidence
  -> user or Party policy evaluates individual facts
  -> standard Party Registry Actions apply accepted facts
  -> Party state, audit, events, outbox, and Action success commit atomically
```

Examples:

- matching IČO evidence may enter Party Matching under a versioned Match Rule;
- a valid accepted IČO uses the standard Official Identifier Add Action;
- a previously unknown accepted business name uses Party enrichment;
- an accepted registered address uses the standard Contact Point Action;
- a conflict with a current authoritative assertion produces confirmation, ambiguity, or Party
  Correction work;
- no provider response performs Party Merge.

V1 may prefill an explicit user-confirmed Party flow. Unattended bulk apply, automatic correction,
automatic merge, and whole-response overwrite remain excluded until their fact-specific policies and
behavioral conflict tests exist.

The implemented coordinator refreshes governed canonical state before applying selected facts.
Each accepted fact records bounded observation and decision evidence separately from the trusted
accepting Principal. Independent stable Action idempotency keys support explicit partial outcomes
and recovery: a retry skips already-satisfied facts and continues missing facts rather than
overwriting current assertions. There is no ARES-specific mutation Action or cross-module shared
transaction.

## Optional provider research

ARES also exposes source-specific public-register and trade-licensing routes and code-list routes.
They are not part of the V1 Party lookup contract. Add one only when a concrete owning business fact
requires it, then preserve its source-specific meaning and history rather than flattening it into the
consolidated subject response.

Useful official references:

- [ARES developer information](https://ares.gov.cz/stranky/vyvojar-info)
- [ARES API changelog](https://ares.gov.cz/stranky/changelog-api)
- [ARES search help](https://ares.gov.cz/stranky/napoveda-ekonomicke-subjekty)
- [ARES operating conditions](https://ares.gov.cz/stranky/podminky-provozu)

## Focused validation

Before publishing the lookup:

- an eight-digit IČO including a leading zero reaches the exact provider route;
- shorter, longer, or non-digit input fails before provider I/O;
- not-found and unavailable remain different typed outcomes;
- concurrent identical requests are coalesced without changing the evidence result;
- cached evidence retains its original observation time;
- response decode failure cannot produce partial accepted facts;
- the lookup writes no Party, Official Identifier, Contact Point, Action evidence, or Domain Event;
- applying accepted evidence uses Party Registry Actions and never a Contacts-owned create path;
- provider failure cannot invalidate or delete existing Party state.
