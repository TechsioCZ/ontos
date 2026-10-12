// Public readiness transport; business operations retain their governed generated clients.
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { siamparkPropertyFoundationApi, siamparkPropertyApiContract } from '../../shared/api.ts';

const readinessClient = Effect.cached(
  makeEffectHttpApiClient(siamparkPropertyFoundationApi, { baseUrl: siamparkPropertyApiContract.apiPrefix }),
);
export const getSiamparkPropertyReadiness = Effect.fn('SiamparkProperty.readiness')(function* readiness() {
  const cached = yield* readinessClient;
  const client = yield* cached;
  return yield* client.foundation.readiness({});
});

// <generated-action-http-client-exports>
export { executeApplyCommand, executeApplyCommandWithAuthorization } from './apply-command-action-client.ts';
export type { ApplyCommandActionClientOptions } from './apply-command-action-client.ts';
// </generated-action-http-client-exports>

// <generated-module-api-client-exports>
export { executeRecords, executeRecordsWithAuthorization } from './records-client.ts';
export type { RecordsClientOptions } from './records-client.ts';
// </generated-module-api-client-exports>
