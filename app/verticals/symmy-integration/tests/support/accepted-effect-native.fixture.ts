import { makeOperationalScopeRepository, makePrincipalResolver, parseDatabaseConfig } from '@app/core-runtime';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { ProviderSubjectIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { requireOwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OwnedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { SymmyJobIdSchema } from '../../shared/domain/symmy-job-identities.ts';
import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([]);

const fixturePurpose = 'implementation-1096-registered-workload-gateway';
const effectKeySchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u)).pipe(
  Schema.brand('SymmyAcceptedEffectKey'),
);
const inputSchema = Schema.Struct({
  effectKey: effectKeySchema,
  jobId: SymmyJobIdSchema,
  legalEntityId: LegalEntityIdSchema,
  operatorPrincipalId: PrincipalIdSchema,
  operatorProviderUserId: ProviderSubjectIdSchema,
  purpose: Schema.Literal(fixturePurpose),
  tenantId: TenantIdSchema,
});

export interface AcceptedEffectIdNativeFixtureInput {
  readonly adminConnectionString: Redacted.Redacted;
  readonly effectKey: string;
  readonly jobId: string;
  readonly legalEntityId: string;
  readonly operatorPrincipalId: string;
  readonly operatorProviderUserId: string;
  readonly ownedDatabase: OwnedNativeDatabaseFixture;
  readonly purpose: typeof fixturePurpose;
  readonly tenantId: string;
}
export class AcceptedEffectIdNativeFixtureUnavailable extends Schema.TaggedError<AcceptedEffectIdNativeFixtureUnavailable>()(
  'AcceptedEffectIdNativeFixtureUnavailable',
  { code: Schema.Literal('accepted_effect_observation_unavailable') },
) {}
const unavailable = () =>
  new AcceptedEffectIdNativeFixtureUnavailable({ code: 'accepted_effect_observation_unavailable' });
const effectRowsSchema = Schema.Array(Schema.Struct({ effectId: SymmyEffectIdSchema }));
interface ConnectionFacts extends Record<string, unknown> {
  readonly database: string;
  readonly roleName: string;
  readonly sessionRoleName: string;
}

/**
 * TEST OBSERVATION ONLY. Returns one stored assigned ID in this exact live disposable clone.
 * It supplies no source classification, policy evidence, invocation proof or operational authority.
 */
export const observeAcceptedEffectIdNativeFixture = Effect.fn('SymmyAcceptedEffectNative.observe')(
  function* observeAcceptedEffectIdNativeFixture(input: AcceptedEffectIdNativeFixtureInput) {
    const pins = yield* Schema.decodeUnknownEffect(inputSchema)(input).pipe(Effect.mapError(unavailable));
    const ownership = requireOwnedNativeDatabaseFixture(input.ownedDatabase, {
      adminConnectionString: input.adminConnectionString,
      purpose: pins.purpose,
      runtimeConnectionString: Redacted.make(input.ownedDatabase.connections.runtime.connectionString),
    }).pipe(Effect.mapError(unavailable));
    yield* ownership;
    const configuration = yield* parseDatabaseConfig({
      DATABASE_URL: Redacted.value(input.adminConnectionString),
    }).pipe(Effect.mapError(unavailable));
    const scope = yield* stageScopeOf({
      legalEntityId: pins.legalEntityId,
      principalId: pins.operatorPrincipalId,
      tenantId: pins.tenantId,
    }).pipe(Effect.mapError(unavailable));
    const result = yield* Effect.scoped(
      Effect.gen(function* observeInOwnedClone() {
        const reactivity = yield* Reactivity.make;
        const client = yield* PgClient.make({ url: input.adminConnectionString }).pipe(
          Effect.provideService(Reactivity.Reactivity, reactivity),
        );
        const [adminConnection] = yield* client<ConnectionFacts>`
          select current_database()::text as database,current_user::text as "roleName",session_user::text as "sessionRoleName"`;
        if (
          adminConnection?.database !== configuration.database ||
          adminConnection.roleName !== configuration.user ||
          adminConnection.sessionRoleName !== configuration.user
        ) {
          return yield* unavailable();
        }
        const runtimeConfiguration = input.ownedDatabase.connections.runtime;
        const runtime = yield* PgClient.make({ url: Redacted.make(runtimeConfiguration.connectionString) }).pipe(
          Effect.provideService(Reactivity.Reactivity, reactivity),
        );
        const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
        const storage = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, client));
        yield* database.transaction(
          Effect.fn('SymmyAcceptedEffectNative.readOnlyTransaction')(function* readOnlyTransaction(transaction) {
            yield* ownership;
            yield* transaction.execute(sql`set transaction read only`, 'objects');
            const [connection] = yield* transaction.execute<ConnectionFacts>(
              sql`select current_database()::text as database,current_user::text as "roleName",session_user::text as "sessionRoleName"`,
              'objects',
            );
            if (
              connection?.database !== runtimeConfiguration.database ||
              connection.roleName !== runtimeConfiguration.user ||
              connection.sessionRoleName !== runtimeConfiguration.user
            ) {
              return yield* unavailable();
            }
            yield* installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
            const actor = yield* makePrincipalResolver(
              { executor: transaction },
              {
                authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
              },
            ).resolveBetterAuthUserForTenant(pins.operatorProviderUserId, pins.tenantId);
            const persisted = yield* makeOperationalScopeRepository(
              { executor: transaction },
              FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
            ).load(scope);
            if (
              actor.principalId !== pins.operatorPrincipalId ||
              actor.principalKind !== 'human' ||
              actor.tenantId !== pins.tenantId ||
              persisted.tenantStatus !== 'active' ||
              persisted.principalStatus !== 'active' ||
              persisted.principalTenantId !== pins.tenantId ||
              persisted.legalEntityStatus !== 'active' ||
              persisted.legalEntityTenantId !== pins.tenantId
            ) {
              return yield* unavailable();
            }
            yield* ownership;
            return yield* Effect.void;
          }),
        );
        return yield* storage.transaction(
          Effect.fn('SymmyAcceptedEffectNative.observeStorage')(function* observeStorage(administrative) {
            yield* ownership;
            yield* administrative.execute(sql`set transaction read only`, 'objects');
            const [connection] = yield* administrative.execute<ConnectionFacts>(
              sql`select current_database()::text as database,current_user::text as "roleName",session_user::text as "sessionRoleName"`,
              'objects',
            );
            if (
              connection?.database !== configuration.database ||
              connection.roleName !== configuration.user ||
              connection.sessionRoleName !== configuration.user
            ) {
              return yield* unavailable();
            }
            const rows = yield* administrative.execute<{ readonly effectId: string }>(
              sql`
              select e.effect_id::text as "effectId"
              from symmy_integration.import_jobs j
              join symmy_integration.job_effects e on e.tenant_id=j.tenant_id and e.job_id=j.job_id
              where j.tenant_id=${pins.tenantId}::uuid and j.legal_entity_id=${pins.legalEntityId}::uuid and j.job_id=${pins.jobId}::uuid
                and e.effect_key=${pins.effectKey} and j.phase='admitted'
                and j.admission_invocation_id is not null and j.execution_plan is not null
                and not exists(select 1 from symmy_integration.job_retention_tombstones t where t.tenant_id=j.tenant_id and t.job_id=j.job_id)
                and exists(select 1 from jsonb_array_elements(j.execution_plan->'items') i
                  cross join lateral jsonb_array_elements(i->'effects') p
                  where p#>>'{ref,effectId}'=e.effect_id::text and p->>'effectKey'=e.effect_key and p->>'itemId'=e.item_id::text)
              limit 2`,
              'objects',
            );
            const effects = yield* Schema.decodeUnknownEffect(effectRowsSchema)(rows);
            const [effect] = effects;
            if (effects.length !== 1 || effect === undefined) {
              return yield* unavailable();
            }
            yield* ownership;
            return effect.effectId;
          }),
        );
      }),
    ).pipe(Effect.mapError(unavailable));
    yield* ownership;
    return result;
  },
);
