# React Architecture Rules

Follow these rules when working with **Modern.js, React 19, TypeScript, and `@techsio/ui-kit`**.

Do not introduce React Server Components unless the developer explicitly requests them.

## Core Rules

- Build UI from `@techsio/ui-kit`.
- Reuse components by visual and interaction contract, not domain type.
- Keep data access and application behavior outside reusable UI.
- Prefer typed props, composition, view models, and semantic callbacks.
- Do not create abstractions without a concrete reuse case.

## Design System

`@techsio/ui-kit` is the source of truth for components, tokens, typography, spacing, colors, icons, forms, accessibility, and interaction patterns.

Before creating UI, follow this sequence:

1. Check whether the UI kit already provides it.
2. Compose existing kit components where possible.
3. Before introducing any new component definition, stop and discuss the component-creation strategy with the developer.
4. Explain the requirement, the existing components considered, the proposed composition, the proposed ownership location, and the intended API and reuse scope.
5. Introduce the component only after the developer approves the strategy.
6. Do not recreate or restyle existing primitives.
7. Do not hardcode values when a kit token or property exists.

Never write plain CSS. Use the installed version of Tailwind CSS.

Keep domain-specific components inside their feature.

## Component Boundaries

Reusable UI components may:

- render UI kit components
- receive typed props
- emit semantic callbacks
- own local visual state
- use domain-independent UI hooks

Reusable UI components must not directly:

- fetch or mutate domain data
- use route loaders or query hooks
- access application stores
- read authentication or permissions
- perform navigation
- trigger application analytics
- depend on raw API response types

Reusable components must be renderable with props and mock callbacks.

Feature and route code own:

- data loading and mutations
- routing
- permissions
- analytics
- business rules
- application state
- loading and error handling
- mapping domain data into UI contracts

## Reusing UI Across Domains

When different domain objects have the same visual representation, use a single shared component and map each domain object to a shared view model.

```tsx
type SummaryItem = {
  id: string;
  title: string;
  description?: string;
  status?: string;
};

const userItems: SummaryItem[] = users.map(user => ({
  id: user.id,
  title: user.fullName,
  description: user.email,
  status: user.accountStatus,
}));

const invoiceItems: SummaryItem[] = invoices.map(invoice => ({
  id: invoice.id,
  title: invoice.number,
  description: invoice.customerName,
  status: invoice.paymentStatus,
}));

<SummaryList items={userItems} />
<SummaryList items={invoiceItems} />
```

Do not create separate domain components when the UI and interactions are identical.

Use:

- view models for shared visual semantics
- typed accessors for tables, lists, selectors, and trees
- slots or children when parts of the layout vary
- headless hooks when behavior is shared but markup differs

Never guess domain fields inside reusable components:

```tsx
// Forbidden
const title = item.name ?? item.title ?? item.label;
```

Require an explicit view model or accessor.

## Data Handling

Choose the data mechanism according to when and where the data is needed.

1. Use route loaders for route-level initial data.
2. In SSR loaders, call the MicroVertical's server-side Effect service or use case directly. Do not call the same application's HTTP BFF client unless you are crossing an intentional deployment or MicroVertical boundary.
3. Use data hooks and the generated BFF client for browser-side fetching, mutations, refetching, pagination, polling, cache invalidation, and optimistic updates.
4. Use local component state only for temporary visual and interaction state.

```text
Initial route load:
loader → Effect use case → view data

Client interaction:
data hook → BFF client → Effect BFF
```

Loaders must return serializable data intended for the route.

Keep loaders, BFF clients, Effect programs, query objects, and domain errors outside reusable UI components.

```tsx
// Avoid: reusable UI depends on data infrastructure
<UserList query={useUsersQuery()} />
```

```tsx
// Prefer: route or feature code adapts data to the UI contract
function UsersFeature() {
  const query = useUsersQuery();

  return (
    <UserList
      items={query.data?.map(toUserItem) ?? []}
      loading={query.isPending}
      errorMessage={mapUsersError(query.error)}
      onRetry={query.refetch}
    />
  );
}
```

Reusable components receive plain view data and semantic callbacks. They must remain unaware of whether the data came from a route loader, BFF client, Effect service, query cache, or test fixture.

Use Suspense and error boundaries only when the selected data library provides documented Suspense integration and an error-reset mechanism. Otherwise, represent loading, error, empty, and success states explicitly.

## React 19

Use a React 19 feature when it replaces custom state or effect plumbing while keeping data and error flow explicit. Do not add a React 19 feature solely because it is available:

- React Actions for asynchronous mutations
- `useActionState` for action state and results
- `useFormStatus` inside reusable form controls
- `useOptimistic` for reversible optimistic updates
- `ref` as a normal prop in new components
- `<Context value={...}>` for new providers

Use `use` only with stable, cached resources supported by the chosen framework or data library.

Do not create Promises during rendering.

## Hooks

Classify hooks by responsibility:

- **UI hooks** manage reusable visual interaction.
- **Application hooks** access APIs, routes, stores, permissions, or workflows.
- **View-model hooks** convert application state into reusable component props.

Reusable components may use UI hooks.

Application and view-model hooks belong in feature or route code.

A hook does not make application behavior reusable merely by hiding that behavior.

## State and React Effects

Keep state in the lowest appropriate owner.

- Visual state stays in the UI component.
- Shareable navigation state belongs in the URL.
- Server data belongs in loaders or query caches.
- Cross-feature interactive state belongs in an application store.

Use effects only to synchronize with external systems.

Do not use effects to:

- derive values from props
- copy props into state
- handle user events
- map domain data
- perform ordinary route fetching
- synchronize two React states

## Component APIs

Prefer semantic callbacks:

```tsx
onSelectUser(userId);
onRequestDeletion(itemId);
onRetry();
onSubmit(values);
```

Avoid exposing DOM events from higher-level components unless a low-level UI primitive requires them.

## Review Checklist

Before completing a change, verify:

1. Existing `@techsio/ui-kit` components and tokens were reused.
2. Any new component strategy received developer approval before implementation.
3. Reusable UI has no application dependencies.
4. Shared UI across domains uses one component.
5. Domain data is mapped through a view model or typed accessor.
6. Data access stays in route or feature code.
7. Query and loader objects are not passed into reusable UI.
8. Local visual state was not lifted unnecessarily.
9. No unnecessary React effect was added.
10. React 19 features replace custom state or effect plumbing while keeping data and error flow explicit.
11. Props describe a clear visual and interaction contract.
