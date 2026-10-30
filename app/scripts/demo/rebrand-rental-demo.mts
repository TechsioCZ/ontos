#!/usr/bin/env node
import { demoCompanyTenantId, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { NodeServices } from '@effect/platform-node';
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { Config, Console, Effect, Exit, Layer, Option, Ref, Schema } from 'effect';
import type { Redacted } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';

import {
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
  TenantIdSchema,
} from '../../apps/shell-super-app/shared/api.ts';
import { validateSeedTarget } from './seed-client.mts';
import { DEFAULT_PASSWORD } from '../ops/stage-demo-verify.mjs';

export class RentalDemoRebrandError extends Schema.TaggedError<RentalDemoRebrandError>()('RentalDemoRebrandError', {
  step: Schema.String,
}) {}

export interface RentalDemoRebrandOptions {
  readonly apply?: boolean;
  readonly email?: string;
  readonly idempotencyKey?: string;
  readonly password?: Redacted.Redacted;
  /** Permit selecting the fixed demo tenant when this private session initially selects another tenant. */
  readonly selectTenant?: boolean;
  readonly shellUrl: string;
}

const failed = (step: string) => new RentalDemoRebrandError({ step });
const TENANT_SCOPE = 'tenant-scope';
const checked = <A, E, R>(step: string, operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError(() => failed(step)),
  );
const requireTargetCompany = (companies: readonly { readonly legalEntityId: string; readonly legalName: string }[]) => {
  const matches = companies.filter(({ legalEntityId }) => legalEntityId === rentalDemoCompany.legalEntityId);
  const [company] = matches;
  return matches.length === 1 && company !== undefined
    ? Effect.succeed(company)
    : Effect.fail(failed('rental-company-scope'));
};

/** One native Action at most, in an isolated cookie session that is closed even on failure or interruption. */
export const rebrandRentalDemo = (options: RentalDemoRebrandOptions) =>
  Effect.scoped(
    Effect.gen(function* rebrand() {
      const origin = yield* checked(
        'target-origin',
        validateSeedTarget({
          legalEntityId: rentalDemoCompany.legalEntityId,
          shellUrl: options.shellUrl,
          tenantId: demoCompanyTenantId,
        }),
      );
      if (
        options.apply === true &&
        !Schema.is(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)))(options.idempotencyKey)
      ) {
        return yield* failed('apply-requires-idempotency-key');
      }
      const http = yield* HttpClient.HttpClient;
      const cookies = yield* Ref.make(Cookies.empty);
      const client = yield* makeEffectHttpApiClient(ShellAuthenticationApi, {
        baseUrl: `${origin}${shellAuthenticationApiContract.apiPrefix}`,
        transformClient: () =>
          http.pipe(
            HttpClient.withCookiesRef(cookies),
            HttpClient.mapRequest(HttpClientRequest.setHeader('origin', origin)),
          ),
      });
      // Register before login: a lost/invalid login response may already have created the private cookie.
      yield* Effect.addFinalizer(() => checked('sign-out', client.authentication.signOut({})).pipe(Effect.orDie));
      const login = yield* checked(
        'sign-in',
        client.authentication.signIn({
          payload: {
            email: options.email ?? 'obchod@demo.ontos',
            password: options.password ?? DEFAULT_PASSWORD,
          },
        }),
      );
      if (login.identity.tenantId !== demoCompanyTenantId) {
        if (options.selectTenant !== true) {
          return yield* failed(TENANT_SCOPE);
        }
        const available = yield* checked('available-tenants', client.tenants.availableTenants({}));
        if (available.tenants.filter(({ tenantId }) => tenantId === demoCompanyTenantId).length !== 1) {
          return yield* failed(TENANT_SCOPE);
        }
        const switched = yield* checked(
          'select-tenant',
          client.tenants.switchTenant({ payload: { tenantId: TenantIdSchema.make(demoCompanyTenantId) } }),
        );
        if (switched.selectedTenantId !== demoCompanyTenantId) {
          return yield* failed(TENANT_SCOPE);
        }
      }
      const session = yield* checked('session', client.authentication.currentSession({}));
      if (
        session.state === 'anonymous' ||
        session.state === 'access_blocked' ||
        session.identity.tenantId !== demoCompanyTenantId
      ) {
        return yield* failed(TENANT_SCOPE);
      }
      const before = yield* checked('available-companies', client.legalEntities.availableLegalEntities({}));
      const company = yield* requireTargetCompany(before.legalEntities);
      if (!['Siampark', rentalDemoCompany.legalName].includes(company.legalName)) {
        return yield* failed('rental-company-name');
      }
      if (options.apply !== true) {
        return { applied: false, legalEntityId: company.legalEntityId, legalName: company.legalName };
      }
      const result = yield* checked(
        'configure-demo-companies-no-automatic-retry',
        client.identity.configureDemoCompanies({
          headers: { 'idempotency-key': options.idempotencyKey },
          payload: { configuration: 'sales-rental-v1' },
        }),
      );
      const configured = yield* requireTargetCompany(result.companies);
      if (configured.legalName !== rentalDemoCompany.legalName) {
        return yield* failed('action-result');
      }
      const after = yield* checked('readback', client.legalEntities.availableLegalEntities({}));
      const renamed = yield* requireTargetCompany(after.legalEntities);
      if (renamed.legalName !== rentalDemoCompany.legalName) {
        return yield* failed('readback-name');
      }
      return { applied: true, legalEntityId: renamed.legalEntityId, legalName: renamed.legalName };
    }),
  );

export const rentalDemoRebrandCommand = Command.make(
  'rebrand-rental-demo',
  {
    apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)),
    idempotencyKey: Flag.String('idempotency-key').pipe(Flag.optional),
    selectTenant: Flag.Boolean('select-tenant').pipe(Flag.withDefault(false)),
    shellUrl: Flag.String('shell-url'),
  },
  ({ apply, idempotencyKey, selectTenant, shellUrl }) =>
    Effect.gen(function* runOperatorCommand() {
      const email = yield* Config.String('ONTOS_DEMO_REBRAND_EMAIL').pipe(Config.withDefault('obchod@demo.ontos'));
      const password = yield* Config.Redacted('ONTOS_DEMO_REBRAND_PASSWORD').pipe(Config.withDefault(DEFAULT_PASSWORD));
      const result = yield* rebrandRentalDemo({
        apply,
        email,
        idempotencyKey: Option.getOrUndefined(idempotencyKey),
        password,
        selectTenant,
        shellUrl,
      });
      yield* Console.log(
        result.applied
          ? 'Nájempark rebrand applied and verified through the native Shell API.'
          : 'Read-only rental rebrand preflight passed. No company or account data changed; use --apply with --idempotency-key.',
      );
    }),
);

if (import.meta.main) {
  const runtime = Layer.effectDiscard(
    Command.run({ renderErrors: false, version: '1.0.0' })(rentalDemoRebrandCommand).pipe(
      Effect.catchCause(() =>
        Console.error(
          'Rental demo rebrand stopped. No automatic retry; inspect the native operation before rerunning.',
        ).pipe(Effect.andThen(Effect.fail(failed('operator-command')))),
      ),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
  const outcome = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtime)));
  process.exitCode = Exit.isFailure(outcome) ? 1 : 0;
}
