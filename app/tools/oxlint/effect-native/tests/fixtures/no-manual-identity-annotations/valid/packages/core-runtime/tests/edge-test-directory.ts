// A `tests/` directory (not just a `.test.ts` suffix) is still out of scope while includeTests is false.
import { Effect } from 'effect';

export const fixture = Effect.annotateLogs(Effect.logInfo('fixture'), {
	correlationId: 'c-1',
	readKey: 'contacts.customerList',
	tenantId: 't-1',
});
