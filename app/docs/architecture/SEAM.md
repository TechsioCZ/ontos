# MicroVertical Data Boundaries

Each MicroVertical owns its complete domain flow, including the database, Effect services, BFF methods, and UI.

A REST-style frontend/backend separation is not required. However, maintain clear boundaries between:

- domain operations
- client data coordination
- reusable presentation

## Data Flow

Use the following structure:

```text
Database → Effect services → BFF methods → feature model → reusable UI
```

- Implement business logic in Effect services.
- Expose typed domain operations through the MicroVertical’s BFF.
- Use Effect Schema for BFF inputs, outputs, and expected errors.
- Call BFF methods from route loaders, feature hooks, or data hooks.
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
