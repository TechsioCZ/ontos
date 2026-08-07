# MicroVertical Architecture

Each MicroVertical is a complete, independently deployable business module. It owns its domain model, database schema and migrations, repositories, Effect services, Backend for Frontend (BFF) contract and implementation, generated BFF client, and feature UI.

The UltraModern topology `appId` identifies that deployment. Its OntOS `moduleId` identifies the
business capability and owns Actions, resources, events, Outbox contracts, Policies, and tenant
module state. Follow [OntOS Module Manifests](./MODULE_MANIFESTS.md); never infer one identity from
the other.

## Seam Model

OntOS has two different kinds of seams. Do not treat them as equivalent.

| Seam       | Location                                     | Meaning                                                                                 |
| ---------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Vertical   | Between MicroVerticals                       | A strict physical deployment seam that must always be preserved.                        |
| Horizontal | Between frontend and backend in one vertical | A virtual seam represented by the generated, Effect-based BFF client—not a domain seam. |

## Vertical Seams: Strict and Independently Deployable

The vertical seam between MicroVerticals is non-negotiable:

- Every MicroVertical must be deployable to its own server or process independently of every other MicroVertical.
- Moving a MicroVertical from a shared host to a separate host must require deployment configuration or adapter selection only. It must not require changes to consuming business logic.
- A MicroVertical must not import another MicroVertical's implementation, access its database or repositories, call its internal Effect services, or participate in its database transaction.
- Shell/Core and other MicroVerticals must not import another deployment's `vertical.manifest.ts`
  or `vertical.registration.ts`. The serialized allowlisted module contract is the metadata seam;
  executable registration remains inside its owning deployment.
- Shared packages may contain stable contracts and genuinely cross-cutting infrastructure. They must not become a back door for sharing MicroVertical business logic or persistence models.
- Executable Policies owned by a MicroVertical are private, owner-local business behavior. Another MicroVertical must not import, register, or execute them. The only cross-module Policy reference exception is the narrow global Policy contract implemented and owned by Shell/Core; an Action may reference a global Policy without gaining access to Core repositories or another module's services.
- Synchronous communication may cross the seam only through the provider's published, contract-derived Effect client.
- Asynchronous communication may cross the seam only through Outbox Messages and their published schemas, using the lifecycle in [Outbox Worker Architecture](./OUTBOX_WORKERS.md).
- Every synchronous request must propagate tenant, principal or service identity, and correlation context. The receiving MicroVertical authenticates and authorizes the request independently; co-location never implies trust.
- Contract adapters must have equivalent observable behavior whether communication is in-process or over the network.

The published client is the calling MicroVertical's interface to the provider. The provider's backend implementation remains private.

## Horizontal Seam: A Virtual Effect BFF Interface

Frontend and backend code inside one MicroVertical belong to the same business module. Their horizontal seam is virtual and exists only at the generated BFF client interface:

- The generated client is derived from the BFF contract and its methods return Effect values with typed success and error channels.
- Route loaders, feature code, and data hooks call the generated BFF client. They never import a backend handler or Effect service and never use ad hoc `fetch` calls for BFF operations.
- The same client interface is used from the browser, SSR code, tests, and server-side composition. An adapter may execute locally or over HTTP, but callers do not change.
- A local server adapter may bind to the backend implementation, but it must never pull that implementation into frontend code or a browser bundle.
- Local and network adapters must decode the same schemas, preserve the same typed errors, and enforce the same authentication and authorization behavior.
- The frontend and backend are not separate domain modules. Do not duplicate domain rules, contracts, or error definitions to simulate a hard frontend/backend split.

## Effect-First Data Flow

Use Effect throughout domain, transport, and frontend integration code:

- Implement business logic in Effect services.
- Define BFF inputs, success values, and public errors with Effect Schema.
- Implement BFF endpoints as Effect programs.
- Expose generated client operations as Effect values. Transport failures, decoding failures, and declared backend failures remain typed in the client's error channel.
- Compose client calls, retries, cancellation, timeouts, and error recovery with Effect in route and feature integration code.
- Run an Effect only at the framework integration edge. If a router or query library requires a Promise, use a thin adapter that handles the typed error channel deliberately instead of erasing it into `unknown`.
- Convert domain results to view models and typed errors to explicit UI states before passing them to reusable presentation.

```text
Query:
route loader or feature/data hook
  → generated Effect BFF client
  → BFF endpoint
  → Effect services
  → database

Mutation:
feature/data hook
  → generated Effect BFF client
  → BFF endpoint
  → Action runtime
  → Action handler
  → Effect services
  → database

Response:
typed Effect success/error
  → feature view model
  → reusable UI
```

## Frontend Integration

Route and feature integration preserves the BFF client's typed Effect success and error channels, then maps them to view models and explicit UI states. Reusable presentation does not receive BFF clients, Effect programs, query objects, or domain errors.

Follow [Frontend Architecture Rules](../frontend/FRONTEND.md) for the complete frontend module and presentation interfaces.

## Authentication Boundary

Authentication is a cross-cutting Shell/Core capability, never a MicroVertical. The
Shell owns credentials, Better Auth sessions and cookies, the strict Effect
authentication BFF, and the private `auth` schema. Core owns only non-secret
principal auth bindings and active principal/tenant resolution. Do not create an
Auth vertical, remote, package, delivery unit, or Module Federation boundary.

### Shell-user Action identity

For a Shell-authenticated user calling an Action owned by an independently deployed
MicroVertical, the Shell resolves the current Better Auth session and issues one short-lived,
audience-scoped EdDSA assertion. The Shell alone owns the private Ed25519 signing JWK. The
receiving BFF receives only a public JWKS and independently verifies the signature, protected
header, issuer, exact topology app ID audience, times, version, subject consistency, and trusted
principal schema for every request.

The assertion is authentication context, not authorization. It contains only the safe
`TrustedPrincipalContext` fields and never contains credentials, cookies, session tokens, display
data, Action keys, permissions, Policy decisions, or business payload. After verification, Core's
Action runtime still performs the Action-specific SpiceDB permission check and executable Policy
evaluation. Co-location with the Shell never bypasses this boundary.

Prepare an existing MicroVertical once with
`pnpm scaffold:microvertical-action-boundary -- --vertical <vertical>` before its BFF accepts
Shell-user Action calls. The generated server verifier and client acquisition adapter embed the
vertical's authoritative topology app ID. Actions remain independently generated, and adding an
Action must never require a new Shell endpoint or a hand-maintained audience registry.
