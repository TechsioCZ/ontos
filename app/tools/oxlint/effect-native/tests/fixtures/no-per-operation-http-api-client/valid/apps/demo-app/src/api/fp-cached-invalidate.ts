// Memoised construction that outlives the operation. effect 4.0.0-beta.107 exports three
// memoising constructors from `Effect` (`cached`, `cachedWithTTL`, `cachedInvalidateWithTTL`);
// all three are in `layerConstructorMembers`, so the remediation this rule prints
// ("memoise it with `Effect.cached`") is actually reachable. The memoised effect is the
// module-level factory's return value, so it escapes the call — see
// `invalid/evasion-per-request-layer.ts` for the same member used *inside* an operation.
import { Effect } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

export const makeInvalidatableClient = () =>
  Effect.cachedInvalidateWithTTL(HttpApiClient.make(contactsApi, { baseUrl: '/api' }), '5 minutes');
