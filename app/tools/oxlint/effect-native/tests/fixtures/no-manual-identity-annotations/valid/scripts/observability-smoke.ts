// scripts/** is out of scope (includeScripts defaults to false).
import { Effect } from 'effect';

export const smoke = Effect.annotateLogs(Effect.logInfo('smoke'), {
	correlationId: 'c-1',
	invocationId: 'i-1',
	tenantId: 't-1',
});
