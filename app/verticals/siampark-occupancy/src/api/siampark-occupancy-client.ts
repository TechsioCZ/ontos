// Published client operations; runtime execution belongs to the browser adapter.
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { siamparkOccupancyApi, siamparkOccupancyApiContract } from '../../shared/api.ts';

// <generated-action-http-client-exports>
export { executeApplyCommand, executeApplyCommandWithAuthorization } from './apply-command-action-client.ts';
export type { ApplyCommandActionClientOptions } from './apply-command-action-client.ts';
// </generated-action-http-client-exports>

// <generated-module-api-client-exports>
export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';
export type { RecordsClientOptions } from './records-client.ts';
// </generated-module-api-client-exports>
const readinessClient = Effect.cached(
  makeEffectHttpApiClient(siamparkOccupancyApi, { baseUrl: siamparkOccupancyApiContract.apiPrefix }),
);
export const getSiamparkOccupancyReadiness = Effect.fn('SiamparkOccupancy.readiness')(function* readiness() {
  const cached = yield* readinessClient;
  const client = yield* cached;
  return yield* client.foundation.readiness({});
});
