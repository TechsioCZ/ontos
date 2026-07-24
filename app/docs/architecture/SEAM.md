# MicroVertical Data Boundaries

Each MicroVertical owns its complete domain flow, including its database schema and repositories, Effect services, BFF endpoints, and UI.

## Deployment Invariants

The frontend and backend of one MicroVertical do not require a hard REST-style separation. Their interface is a generated BFF client that conforms to a typed contract:

- Frontend and backend code may be deployed together or separately.
- Frontend and feature code must call the BFF client, not the backend implementation.
- The deployment composition seam selects a local or network adapter for the BFF client. Adapter selection and configuration must not change callers.
- A local adapter must not import backend implementation into frontend code or the browser bundle.
- Local and network adapters must expose equivalent observable contract behavior. Deployment mode must not weaken authentication or authorization.

Boundaries between MicroVerticals are strict:

- Each MicroVertical must remain independently deployable to a separate server.
- A MicroVertical must not import another MicroVertical’s implementation, access its database or repositories, call its internal Effect services, or participate in its database transaction.
- MicroVerticals may communicate only through published BFF clients that conform to typed contracts or through Outbox Messages.
- Every synchronous cross-MicroVertical request must propagate its tenant, principal or service identity, and correlation context. The receiving MicroVertical must authenticate and authorize the request independently in both local and network adapter modes; an in-process caller is not implicitly trusted.
- Moving a MicroVertical from a shared deployment to a separate server must require adapter selection and configuration only, not changes to consuming business logic.

Within a MicroVertical, maintain clear seams between:

- domain operations
- client data coordination
- reusable presentation

## Data Flow

Requests and responses follow these paths:

```text
Query:    route loader or feature/data hook → BFF client → BFF endpoint → Effect services → Database
Mutation: feature/data hook → BFF client → BFF endpoint → Action runtime → Action handler → Effect services → Database
Response: BFF client → feature model → reusable UI
```

- Implement business logic in Effect services.
- Expose typed domain operations through the MicroVertical’s BFF.
- Use Effect Schema for BFF inputs, outputs, and expected errors.
- Call the BFF client from route loaders, feature hooks, or data hooks.
- Map domain results into view models before passing them to reusable UI.

Route data loaders are useful for route-level initial data. Use a client query library when the UI requires caching, refetching, pagination, polling, invalidation, or optimistic updates.

Use local component state only for temporary UI state.

## Effect Boundaries

Keep the following outside reusable UI components:

- BFF clients
- Effect programs and runtimes
- Effect service dependencies
- query and loader result objects
- domain-specific errors
- raw persistence or BFF models

Preserve typed Effect errors within the domain and data layers. Convert them to UI states or user-facing messages in the feature model.

```tsx
function UsersFeature() {
  const model = useUsersModel();

  return <SummaryList {...model} />;
}
```

```tsx
function useUsersModel(): SummaryListProps {
  const query = useUsersQuery();

  return {
    items: query.data?.map(toSummaryItem) ?? [],
    loading: query.isPending,
    errorMessage: mapUsersError(query.error),
    onRetry: query.refetch,
  };
}
```

The reusable component knows only about its visual contract:

```tsx
type SummaryListProps = {
  items: SummaryItem[];
  loading: boolean;
  errorMessage?: string;
  onRetry(): void;
};
```

Different MicroVerticals may map their domain models to the same UI contract:

```tsx
const userToSummaryItem = (user: User): SummaryItem => ({
  id: user.id,
  title: user.fullName,
  description: user.email,
});

const invoiceToSummaryItem = (invoice: Invoice): SummaryItem => ({
  id: invoice.id,
  title: invoice.number,
  description: invoice.customerName,
});
```

Do not create separate UI components solely because their data originates from different MicroVerticals.

BFF methods should return typed domain data or use-case results. They should not return React components, query objects, or UI kit components.
