// A factory imported from another module carries no evidence in this file.
import { Effect } from 'effect';
import { createContactsClient } from './client-factory.ts';

export const readiness = () =>
  createContactsClient().pipe(Effect.flatMap((client) => client.foundation.readiness({})));
