// Tests are out of scope (includeTests defaults to false).
import { Effect } from 'effect';

export const traced = Effect.annotateLogs(Effect.logInfo('test'), {
	actionKey: 'contacts.createCustomer',
	correlationId: 'c-1',
	readKey: 'contacts.customerList',
	tenantId: 't-1',
});
