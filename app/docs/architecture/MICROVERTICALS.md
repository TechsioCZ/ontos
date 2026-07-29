# MicroVertical Architecture

Each MicroVertical is a complete, independently deployable business module. It owns its domain model, database schema and migrations, repositories, Effect services, Backend for Frontend (BFF) contract and implementation, generated BFF client, and feature UI.

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
- Shared packages may contain stable contracts and genuinely cross-cutting infrastructure. They must not become a back door for sharing MicroVertical business logic or persistence models.
- Synchronous communication may cross the seam only through the provider's published, contract-derived Effect client.
- Asynchronous communication may cross the seam only through Outbox Messages and their published schemas.
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
