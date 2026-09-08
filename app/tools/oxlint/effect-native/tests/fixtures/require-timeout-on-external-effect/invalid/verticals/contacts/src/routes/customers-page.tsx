// expect-count: 2
import { Effect } from 'effect';

declare const client: { load: () => Promise<string>; save: (value: string) => Promise<void> };

export const loadCustomers = () => Effect.tryPromise(() => client.load());

export const saveCustomer = (value: string) =>
  Effect.tryPromise({ catch: () => new Error('save failed'), try: () => client.save(value) }).pipe(
    Effect.annotateLogs({ operation: 'save' }),
    Effect.withSpan('Contacts.saveCustomer'),
  );
