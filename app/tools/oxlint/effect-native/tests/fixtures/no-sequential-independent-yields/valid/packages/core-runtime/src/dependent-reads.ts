// Genuine data dependencies (including through a destructuring pattern) and reads separated by
// control flow or by a non-declaration statement. None of these are "adjacent and independent".
import { Effect } from 'effect';

declare const repository: {
  readonly findCustomer: (id: string) => Effect.Effect<{ readonly id: string }>;
  readonly findContacts: (id: string) => Effect.Effect<readonly string[]>;
};
declare const tenants: { readonly forContact: (contact: string) => Effect.Effect<{ readonly tenantId: string }> };
declare const settingsStore: { readonly forTenant: (tenantId: string) => Effect.Effect<string> };
declare const alpha: { readonly read: () => Effect.Effect<string | undefined> };
declare const beta: { readonly read: () => Effect.Effect<string> };
declare const gamma: { readonly read: () => Effect.Effect<string> };

export const chained = Effect.fn('chained')(function* (id: string) {
  const customer = yield* repository.findCustomer(id);
  const contacts = yield* repository.findContacts(customer.id);
  const { tenantId } = yield* tenants.forContact(contacts[0] ?? '');
  const settings = yield* settingsStore.forTenant(tenantId);
  return { contacts, customer, settings, tenantId };
});

export const separated = Effect.gen(function* () {
  const first = yield* alpha.read();
  if (first === undefined) {
    return null;
  }
  const second = yield* beta.read();
  yield* Effect.annotateCurrentSpan('step', 'between');
  const third = yield* gamma.read();
  return { first, second, third };
});

export const fannedOut = Effect.gen(function* () {
  const outer = yield* alpha.read();
  const results = yield* Effect.forEach(
    [1, 2],
    (item) =>
      Effect.gen(function* () {
        const inner = yield* beta.read();
        const derived = yield* gamma.read(inner + String(item));
        return { derived, inner };
      }),
    { concurrency: 2 },
  );
  return { outer, results };
});
