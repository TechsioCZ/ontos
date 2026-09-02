# Effect Error and HTTP Contracts

This document defines the error contract from backend Effect programs, through HTTP, into generated Backend for Frontend (BFF) clients and frontend feature code.

Governed context, read denial/evidence, and isolation failures follow
[Governed Data Access and Operation Scope](./DATA_ACCESS.md). Context or authorization uncertainty
is a declared retryable `503`; business handlers and adapters must not receive database executors or
leak database/SpiceDB diagnostics.

## Non-Negotiable Rules

- Model every expected failure as a tagged, typed Effect error.
- Model BFF contracts with Effect HttpApi and declare each endpoint's input, success, and error schemas.
- Declare every public backend error in the BFF endpoint's Effect Schema error contract.
- Assign every declared public error its semantically correct HTTP status with the Effect HttpApi schema annotation.
- Implement handlers as Effect programs that fail with declared errors. Do not hand-build error `Response` objects.
- Serialize HTTP errors as RFC 9457 Problem Details using `application/problem+json`.
- Derive the BFF client from the same contract. The client must decode declared backend failures back into its typed Effect error channel.
- Keep client transport and response-decoding failures typed as well.
- Handle typed client failures exhaustively in route or feature code before mapping them to a UI state.

An endpoint is incomplete when any path can return an undeclared error shape, an incorrect status, a thrown expected error, or an untyped Promise rejection.

## Backend Error Flow

Use this flow for every backend request:

```text
typed domain/infrastructure error
  → exhaustive endpoint mapping
  → declared public Effect error schema + status
  → RFC 9457 HTTP response
  → generated client decoding
  → typed client Effect error
  → feature/UI-state mapping
```

Internal domain and infrastructure errors may be more detailed than the public contract. Map them at the BFF endpoint to the smallest useful public error union. Never expose secrets, stack traces, internal identifiers, authorization details, or persistence errors.

Module entrypoint failures from [Module Entrypoints and Tenant State](./MODULE_ENTRYPOINTS.md) remain typed and sanitized across every boundary. A definite tenant-state denial normally maps to a declared `403`; an unavailable/indeterminate gate check maps to a declared retryable `503`. Frontend integrations must handle both explicitly before any private implementation or remote is loaded.

Shell composition uses `401` for a missing session, `409` when legal-entity selection is required,
`403` for definite module/resource denial, `404` for safely undiscoverable targets, retryable `503`
for catalog/state/context/authorization/provider uncertainty, and a redacted declared `500` only
after logging an unexpected Effect cause. HTTP status and Problem Details `status` must match.

Unexpected defects are not expected failures. At the outer HTTP seam, log the full Effect cause with correlation context, then convert it to a declared, non-sensitive typed `InternalServerError` with status `500`. No defect may escape as an unstructured backend response.

Generated Action BFF endpoints must also map the complete Core Action error union. `ActionPolicyDenied` carries a stable Policy reason code and safe human-readable reason, but Core deliberately assigns no HTTP status: the endpoint maps the Policy's declared semantics to the correct public Problem Details schema, such as `403` for authorization-like denial, `409` for current-state conflict, or `422` for semantic ineligibility. `ActionPolicyEvaluationError` represents a sanitized evaluator defect or unavailable required capability and must map to the endpoint's declared operational failure, commonly a retryable `503` when appropriate. Neither error may fall through to an exception, generic Action endpoint, or ad hoc response.

For the Shell-user MicroVertical Action identity boundary, the generated verifier keeps expected
failures typed as missing, invalid, expired, scope-invalid, configuration, or verification
unavailable errors. The owning endpoint must map missing, invalid, expired, and scope-invalid
credentials to its declared `401` Problem Details schema and attach `WWW-Authenticate: Bearer`.
Configuration or verification capability failures map to a declared retryable `503`. Never expose
the assertion, a JWK, signature diagnostics, or claim contents in Problem Details or logs. A verified
assertion supplies authentication context only; SpiceDB denial remains `403` and Policy failures
retain their endpoint-specific semantics.

## Status Code Semantics

Choose the status from the meaning of the failure, not from a generic domain-error default.

| Status | Use when                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| `400`  | The request cannot be decoded or structurally validated against its schema.                                         |
| `401`  | Credentials are missing, invalid, expired, revoked, or otherwise unusable. Include a `WWW-Authenticate` challenge.  |
| `403`  | Authentication succeeded, but the principal is not permitted to perform the operation.                              |
| `404`  | The requested resource is absent and revealing that fact is allowed.                                                |
| `409`  | The operation conflicts with the current mutable state or a concurrency invariant and may succeed after resolution. |
| `422`  | The request is structurally valid but semantically ineligible, and the failure is not authorization or conflict.    |
| `429`  | The caller exceeded a rate or quota limit.                                                                          |
| `500`  | An unexpected internal defect was caught at the outer HTTP seam.                                                    |
| `503`  | A required capability is temporarily unavailable and retry may succeed later.                                       |
| `504`  | A required upstream operation did not complete before its deadline.                                                 |

Identity endpoints apply the same meanings exhaustively. Missing or unusable Shell credentials use
`401` with a Bearer challenge; the API-key exchange uses an API-key challenge. A definite permission
denial or active credential bound to a forbidden tenant/principal/legal entity is `403`; lifecycle
state races are `409`; missing runtime records are `404`; ineligible targets are `422`; a missing
required idempotency key is `428`; provider throttling is `429`. Structurally invalid operation
payloads are `400`. Database,
SpiceDB, resolver, evidence, or provider uncertainty is retryable `503`, while only caught defects
at the outer handler seam become sanitized `500`. Problem Details never include keys, hashes,
cookies, provider diagnostics, identifiers, or signature details.

`ActionAlreadyCommitted` is a terminal idempotency conflict (`409`) at identity transports, not a
retryable capability outage. The internal stopped-impersonation recovery path treats that exact
outcome as successful checkpoint replay, then retries deletion of its Auth-owned recovery record.
If any work after provider restoration remains pending, Shell forwards the restored cookie first
and returns the declared retryable `503` without exposing recovery data.
Requested and started checkpoint failures preserve their typed Action error: definite permission
denial maps to `403`, invalid identity state maps to `422`, and authorization or persistence
uncertainty maps to `503`. A stopped checkpoint that fails after mechanical termination is reported
only as pending recovery and never reactivates the impersonated session.

Use other RFC 9110 statuses when they are a more accurate semantic match. Do not disguise authentication or authorization failures as validation errors, and do not use `500` for declared business rejections.

## Core Action Permission Failures

Core keeps its Action errors transport-neutral. A future Action BFF endpoint
must exhaustively map `ActionPermissionDenied` to a declared `403` Problem
Details schema and `ActionPermissionCheckError` to a declared `503` Problem
Details schema. The denial exposes only its stable code and safe reason. The
absence of an executor relationship is a definite `NO_PERMISSION` denial, not
an unavailable configuration state. The check error covers timeout,
unavailability, authentication or schema failure, and any conditional or
otherwise indeterminate SpiceDB decision; it must never be reclassified as a
permission denial or an unconfigured-Action allow. Do not introduce a generic
Action HTTP endpoint to perform this mapping.

## Problem Details

Every error response must contain a Problem Details body whose schema is declared in the endpoint contract. It must include:

- a stable URI reference in `type`;
- a human-readable `title`;
- a safe, useful `detail`; and
- `status`, equal to the actual HTTP response status.

Add structured extension members only when clients need them to recover, such as safe field issues, a retry hint, or a stable domain reason code. Keep those extensions typed in Effect Schema.

## Generated Client Contract

Every generated BFF client operation is an Effect interface:

```text
Effect<Success, DeclaredBackendError | TransportError | DecodeError, Requirements>
```

The precise error union is operation-specific. Do not weaken it to `unknown`, `Error`, a string, or an unchecked JSON object.

Frontend loaders and feature/data hooks compose the client Effect and map its typed errors exhaustively. Reusable presentation components receive plain UI states and semantic callbacks; they do not receive or execute BFF client Effects.

If a framework integration requires a Promise, bridge to it only at a thin outer adapter after deciding how every typed failure is retained or mapped. Do not redesign the BFF client itself as an untyped Promise interface.

## Review Checklist

Before completing backend or BFF client work, verify:

1. Every expected failure is represented in an Effect error channel.
2. Every returned backend error is declared by the endpoint schema.
3. Every declared error has the correct status annotation.
4. The HTTP response status and Problem Details `status` are identical.
5. Unexpected defects become a typed, safe `500` response after the full cause is logged.
6. The generated client decodes backend, transport, and decoding failures into typed errors.
7. Frontend integration handles the client error union exhaustively before rendering.
8. Action endpoints exhaustively translate `ActionPolicyDenied` and `ActionPolicyEvaluationError`, choosing denial status by Policy semantics rather than applying one universal Policy status.
