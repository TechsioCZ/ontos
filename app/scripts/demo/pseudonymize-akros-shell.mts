import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Config, Effect, Ref, Schema } from 'effect';
import { Cookies, HttpClient, HttpClientRequest } from 'effect/http';

import {
  LegalEntityIdSchema,
  ShellAuthenticationApi,
  TenantIdSchema,
  shellAuthenticationApiContract,
} from '../../apps/shell-super-app/shared/browser-api.ts';
import { akrosDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { DemoSeedError } from './seed-client.mts';

/** Private cookie session; registered cleanup precedes sign-in, including partially failed sign-ins. */
export const connectPseudonymShell = Effect.gen(function* connectShell() {
  const shellUrl = yield* Config.schema(
    Schema.Literal('https://ontos-stage.web-revolution.cz'),
    'ONTOS_DEMO_SEED_URL',
  ).pipe(Config.withDefault('https://ontos-stage.web-revolution.cz'));
  const http = yield* HttpClient.HttpClient;
  const cookies = yield* Ref.make(Cookies.empty);
  const client = yield* makeEffectHttpApiClient(ShellAuthenticationApi, {
    baseUrl: `${shellUrl}${shellAuthenticationApiContract.apiPrefix}`,
    transformClient: () =>
      http.pipe(
        HttpClient.withCookiesRef(cookies),
        HttpClient.mapRequest(HttpClientRequest.setHeader('origin', shellUrl)),
      ),
  });
  yield* Effect.addFinalizer(() => client.authentication.signOut({}).pipe(Effect.ignore));
  const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
  yield* client.authentication.signIn({ payload: { email: 'obchod@demo.ontos', password } });
  yield* client.tenants.switchTenant({ payload: { tenantId: TenantIdSchema.make(demoTenantId) } });
  yield* client.legalEntities.switchLegalEntity({
    payload: { legalEntityId: LegalEntityIdSchema.make(akrosDemoLegalEntityId) },
  });
  const session = yield* client.authentication.currentSession({});
  if (
    session.state !== 'authenticated' ||
    session.identity.tenantId !== demoTenantId ||
    session.identity.legalEntityId !== akrosDemoLegalEntityId
  ) {
    return yield* new DemoSeedError({ reason: 'The operator must select the fixed demo company' });
  }
  return client;
});
