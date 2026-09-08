// Building, piping and annotating Effects is untouched: only *running* them ad hoc is reported.
import { Effect, Layer, Schedule } from 'effect';

import { ContactsClient } from '../contacts-api.ts';

export const loadCustomer = (customerId: string) =>
  Effect.gen(function* loadCustomerProgram() {
    const client = yield* ContactsClient;
    const customer = yield* client.getCustomer({ customerId });
    return customer;
  }).pipe(
    Effect.retry(Schedule.exponential('100 millis')),
    Effect.timeout('5 seconds'),
    Effect.catchTag('Unauthorized', () => Effect.succeed(undefined)),
    Effect.withSpan('contacts.loadCustomer'),
    Effect.annotateLogs({ customerId }),
  );

export const ContactsClientLive = Layer.effect(ContactsClient, Effect.succeed({} as never));

export const bothCustomers = (left: string, right: string) =>
  Effect.all([loadCustomer(left), loadCustomer(right)], { concurrency: 2 });
