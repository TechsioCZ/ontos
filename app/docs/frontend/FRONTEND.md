# Frontend Architecture Rules

Follow these rules for user-facing frontend work with Modern.js, React 19, TypeScript, Effect, and `@techsio/ui-kit`.

Also follow:

- [MicroVertical Architecture](../architecture/MICROVERTICALS.md) for vertical deployment seams and the virtual horizontal BFF seam;
- [Effect Error and HTTP Contracts](../architecture/ERRORS.md) for BFF client and error behavior.
- [Module Entrypoints and Tenant State](../architecture/MODULE_ENTRYPOINTS.md) for lazy route/component loads, request batching, and explicit unavailable/forbidden UI states.

Do not introduce React Server Components unless the developer explicitly requests them.

## Frontend Module Structure

Separate frontend code by responsibility:

- **Route and feature integration** owns routing, permissions, analytics, application state, Backend for Frontend (BFF) client Effects, loading, mutations, and error-to-UI mapping.
- **View models** convert typed domain success and error values into reusable presentation contracts.
- **Reusable presentation** renders UI kit components from typed props and emits semantic callbacks.

Frontend and backend code inside one MicroVertical are not separate domain modules. Their horizontal seam is virtual and represented only by the generated Effect-based BFF client.

## Effect BFF Client

All frontend-originated backend operations must use the MicroVertical's generated BFF client:

- Route loaders, feature code, and data hooks call client methods that return Effect values.
- Compose client calls, cancellation, timeouts, retries, and recovery with Effect.
- Preserve declared backend errors, transport failures, and decoding failures in typed Effect error channels.
- Handle the operation-specific error union exhaustively in route or feature code.
- Map typed errors to explicit loading, empty, unavailable, forbidden, validation, conflict, retry, or other UI states before rendering reusable presentation.
- Let the Shell/Core gateway decide a structured page or public-component entrypoint before invoking its lazy Module Federation loader. Do not call raw `loadRemote(...)`, eagerly import another vertical's implementation, or issue one module-state request per composed component.
- Do not use ad hoc `fetch`, import backend implementations, throw expected failures, or hide client failures behind `Promise<unknown>`.

Run an Effect only at the framework integration edge. When a router or query library requires a Promise, use a thin adapter that deliberately retains or maps every typed failure. Reusable presentation components do not receive or execute Effects.

```text
Initial route query:
loader → generated Effect BFF client → BFF endpoint → Effect services → view model → UI

Client query:
data hook → generated Effect BFF client → BFF endpoint → Effect services → view model → UI

Client mutation:
data hook → generated Effect BFF client → BFF endpoint → Action runtime → Effect services → view model → UI
```

## Design System

`@techsio/ui-kit` is the source of truth for components, tokens, typography, spacing, colors, icons, forms, accessibility, and interaction patterns.

Before creating UI:

1. Check whether the UI kit already provides it.
2. Compose existing kit components where possible.
3. Before introducing any new component definition, stop and discuss the component-creation strategy with the developer.
4. Explain the requirement, existing components considered, proposed composition, ownership location, intended interface, and reuse scope.
5. Introduce the component only after the developer approves the strategy.
6. Do not recreate or restyle existing primitives.
7. Do not hardcode values when a kit token or property exists.

Never write plain CSS. Use the installed version of Tailwind CSS.

Keep domain-specific presentation inside its feature.

## Internationalization

Always use the application internationalization (i18n) runtime for user-facing text. Never hardcode user-facing strings in TypeScript, TSX, route metadata, or configuration.

This includes visible copy and accessibility text such as labels, descriptions, placeholders, validation messages, errors, empty and loading states, notifications, `aria-label` values, page titles, and SEO descriptions.

- Add translation keys to the owning shell or MicroVertical namespace.
- Add or update every supported locale in the same change.
- Use i18n interpolation and pluralization instead of concatenating translated fragments.
- Keep each MicroVertical's translations with that MicroVertical; do not share domain translation catalogs across vertical seams.
- Run `mise exec -- pnpm i18n:boundaries` before completing the change.

## Presentation Components

Reusable presentation components may:

- render UI kit components;
- receive typed props;
- emit semantic callbacks;
- own local visual state; and
- use domain-independent UI hooks.

Reusable presentation components must not directly:

- fetch or mutate domain data;
- run BFF client Effects;
- use route loaders or application query hooks;
- access application stores;
- read authentication or permissions;
- perform navigation;
- trigger application analytics; or
- depend on raw persistence, BFF response, or error types.

Reusable presentation must be renderable with props and mock callbacks.

## Reusing UI Across Domains

Reuse components by visual and interaction contract, not by domain type. When different domain objects have the same visual representation, use one shared presentation component and map each object to a shared view model.

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

Use:

- view models for shared visual semantics;
- typed accessors for tables, lists, selectors, and trees;
- slots or children when parts of the layout vary; and
- headless UI hooks when behavior is shared but markup differs.

Never guess domain fields inside a reusable component:

```tsx
// Forbidden
const title = item.name ?? item.title ?? item.label;
```

Require an explicit view model or accessor.

## Data Loading and State

Choose the data mechanism according to when and where data is needed:

1. Use route loaders for route-level initial data.
2. Use feature/data hooks and a client query library when the UI needs caching, refetching, pagination, polling, invalidation, or optimistic updates.
3. In both cases, use the generated Effect BFF client and keep its backend implementation out of the browser bundle.
4. Return only serializable, route-oriented data from loaders.
5. Use local component state only for temporary visual and interaction state.

Keep loaders, BFF clients, Effect runtimes, query objects, and typed domain errors outside reusable presentation.

```tsx
// Avoid: presentation depends on data infrastructure
<UserList query={useUsersQuery()} />
```

```tsx
// Prefer: feature code adapts typed data and errors to the UI contract
function UsersFeature() {
  const model = useUsersModel();

  return <UserList {...model} />;
}
```

Use Suspense and error boundaries only when the selected data library provides documented Suspense integration and an error-reset mechanism. Otherwise, represent loading, error, empty, and success states explicitly.

Keep state in the lowest appropriate owner:

- Visual state stays in the presentation component.
- Shareable navigation state belongs in the URL.
- Server data belongs in loaders or query caches.
- Cross-feature interactive state belongs in an application store.

The authenticated Shell is server-composed. Its layout receives plain navigation and legal-entity
view models, keeps search persistent, and uses full document reloads after successful tenant or
legal-entity switches. Direct module, search, and ResourceRef routes map typed loader results to
explicit selection-required, empty, partial, forbidden, not-found, unavailable/retry, and resolved
states. Disabled module and media affordances remain semantic, non-interactive content with an
accessible explanation; inaccessible items are never guessed into links.

## Hooks and React Effects

Classify hooks by responsibility:

- **UI hooks** manage reusable visual interaction.
- **Application hooks** compose BFF client Effects, routes, stores, permissions, or workflows.
- **View-model hooks** convert application success and error state into presentation props.

Reusable presentation may use UI hooks. Application and view-model hooks belong in feature or route code.

Use React effects only to synchronize with external systems. Do not use them to:

- derive values from props;
- copy props into state;
- handle user events;
- map domain data or typed errors;
- perform ordinary route fetching; or
- synchronize two React states.

## React 19

Use a React 19 feature when it replaces custom state or effect plumbing while keeping data and error flow explicit:

- React Actions for asynchronous mutations;
- `useActionState` for action state and results;
- `useFormStatus` inside reusable form controls;
- `useOptimistic` for reversible optimistic updates;
- `ref` as a normal prop in new components; and
- `<Context value={...}>` for new providers.

Use `use` only with stable, cached resources supported by the chosen framework or data library. Do not create Promises during rendering.

## Component Interfaces

Prefer typed props, composition, view models, and semantic callbacks:

```tsx
onSelectUser(userId);
onRequestDeletion(itemId);
onRetry();
onSubmit(values);
```

Avoid exposing DOM events from higher-level components unless a low-level UI primitive requires them. Do not create an abstraction without a concrete reuse case.

## Review Checklist

Before completing a frontend change, verify:

1. The MicroVertical's generated Effect BFF client is the only backend interface used.
2. Client operations preserve typed success and error channels until the feature integration maps them.
3. Backend, transport, and decoding errors are handled exhaustively as explicit UI states.
4. Existing `@techsio/ui-kit` components and tokens were reused.
5. Any new component strategy received developer approval before implementation.
6. Reusable presentation has no application, Effect, routing, query, or domain dependencies.
7. Shared UI across domains uses one presentation contract.
8. Domain data is mapped through a view model or typed accessor.
9. Local visual state was not lifted unnecessarily.
10. No unnecessary React effect or Promise created during rendering was added.
11. Props describe a clear visual and interaction contract.
