import { NodeCrypto } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Cause, DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { readPrincipalBinding } from '../../src/auth/external-identity/read.ts';
import {
  assertCurrentExternalIdentityBinding,
  CurrentExternalIdentityBindingSchema,
  ExternalIdentityBindingCurrentnessError,
} from '../../src/auth/external-identity/repository.ts';
import type {
  CurrentExternalIdentityBinding,
  ExternalIdentityBindingRecord,
} from '../../src/auth/external-identity/repository.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../src/auth/external-identity/verifier.ts';
import { AuthenticationNamespaceRegistrationSchema } from '../../src/auth/external-identity-contracts.ts';
import { installOperationalScopeAt } from '../../src/db/scoped-transaction.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeTestDatabase } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const uid = (value: number) => `76000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = uid(1);
const authBindingId = uid(2);
const principalId = uid(3);
const requester = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(4),
    authContextRef: 'better-auth-session:current-binding-requester',
    authMethod: 'session',
    principalId: uid(5),
    tenantId,
  }),
  correlationId: 'current-binding-requester',
};
const at = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T12:00:00.000Z'));
const namespace = Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
  allowedAudiences: ['test-binding-currentness'],
  authenticationNamespaceId: 'test.customer-identity',
  provider: 'test-customer-provider',
  requiresOperationAdmission: true,
  reservationPrincipalKind: 'human',
  subjectTypes: ['user'],
  trustedAttesterPrincipalIds: [requester.principalId],
});
const registry = makeAuthenticationNamespaceRegistry([namespace]);
const snapshot = Schema.decodeSync(CurrentExternalIdentityBindingSchema)({
  authBindingId,
  authenticationNamespaceId: namespace.authenticationNamespaceId,
  bindingRevision: 3,
  principalId,
  providerSubjectId: 'Case-Sensitive/Customer_01',
  subjectType: 'user',
  tenantId,
});

type BindingRow = Omit<
  ExternalIdentityBindingRecord,
  'bindingStatus' | 'principalKind' | 'principalStatus' | 'subjectType' | 'tenantStatus'
> & {
  readonly bindingStatus: string;
  readonly principalKind: string;
  readonly principalStatus: string;
  readonly subjectType: string;
  readonly tenantStatus: string;
};
const bindingRow = (overrides: Partial<BindingRow> = {}): BindingRow => ({
  authBindingId,
  authenticationNamespaceId: namespace.authenticationNamespaceId,
  bindingRevision: snapshot.bindingRevision,
  bindingStatus: 'active',
  createdByInvocationId: uid(6),
  lastTransitionRef: uid(7),
  principalId,
  principalKind: 'human',
  principalStatus: 'active',
  provider: namespace.provider,
  providerSubjectId: snapshot.providerSubjectId,
  revokedAt: null,
  subjectType: 'user',
  tenantId,
  tenantStatus: 'active',
  ...overrides,
});

interface Statement {
  readonly params: readonly unknown[];
  readonly sql: string;
}
interface AssertionOptions {
  readonly expected?: CurrentExternalIdentityBinding;
  readonly failLookup?: boolean;
  readonly rows?: readonly BindingRow[];
}

/** Installs a genuine branded transaction capability through the shipped Core scope installer. */
const assertion = (options: AssertionOptions = {}) =>
  Effect.gen(function* assertInRealTransaction() {
    const statements: Statement[] = [];
    const database = yield* makeTestDatabase((statement, params): Effect.Effect<readonly object[], SqlError> => {
      statements.push({ params, sql: statement });
      if (statement.includes('current_user')) {
        return Effect.succeed([{ legal_entity_id: '', operation_at: at, role: 'ontos_runtime', tenant_id: tenantId }]);
      }
      if (statement.includes('from "core"."principal_auth_bindings"')) {
        return options.failLookup === true
          ? Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'private binding database outage' }) }))
          : Effect.succeed(options.rows ?? [bindingRow()]);
      }
      return Effect.succeed([]);
    });
    let assertionStart = 0;
    const result = yield* Effect.exit(
      database.transaction((transaction) =>
        Effect.gen(function* ownerTransaction() {
          const { scoped } = yield* installOperationalScopeAt(
            transaction,
            requester,
            FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          );
          assertionStart = statements.length;
          yield* assertCurrentExternalIdentityBinding(scoped, options.expected ?? snapshot);
          // The assertion neither commits nor returns a scope/admission. The owner still controls
          // its transaction and any later journal/CAS work; this observation occurs before COMMIT.
          return yield* transaction.execute(sql`select 'owner-transaction-still-open'`, 'objects').pipe(Effect.asVoid);
        }),
      ),
    );
    return { assertionStatements: statements.slice(assertionStart), result, statements };
  });

const denied = (result: Exit.Exit<void, unknown>) => {
  expect(Exit.isFailure(result)).toBe(true);
  const error = Option.getOrUndefined(Exit.findErrorOption(result));
  expect(Schema.is(ExternalIdentityBindingCurrentnessError)(error)).toBe(true);
  if (Schema.is(ExternalIdentityBindingCurrentnessError)(error)) {
    expect(error.code).toBe('identity_forbidden');
  }
};
const noAssertionWrites = (statements: readonly Statement[]) => {
  expect(
    statements.every(
      (statement) => statement.sql.startsWith('select ') || statement.sql === 'COMMIT' || statement.sql === 'ROLLBACK',
    ),
  ).toBe(true);
  expect(statements.some((statement) => statement.sql.includes('SAVEPOINT'))).toBe(false);
};

it.effect('locks the joined current binding, human and tenant inside the original scoped owner transaction', () =>
  Effect.gen(function* currentSnapshotPasses() {
    const { assertionStatements, result, statements } = yield* assertion();
    expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toBe(true);
    const [lookup, ownerObservation, commit] = assertionStatements;
    expect(lookup?.sql).toContain('inner join "core"."principals"');
    expect(lookup?.sql).toContain('inner join "core"."tenants"');
    expect(lookup?.sql).toContain('"principals"."tenant_id" = "core"."principal_auth_bindings"."tenant_id"');
    expect(lookup?.sql).toContain('for update');
    expect(lookup?.params).toEqual([tenantId, authBindingId, 2]);
    expect(ownerObservation?.sql).toContain('owner-transaction-still-open');
    expect(commit?.sql).toBe('COMMIT');
    expect(statements.filter((statement) => statement.sql === 'BEGIN')).toHaveLength(1);
    expect(principalId).not.toBe(requester.principalId);
    noAssertionWrites(assertionStatements);
  }),
);

it.effect('rejects a foreign expected tenant before reading any target identity', () =>
  Effect.gen(function* refusesForeignRequesterTenant() {
    const otherTenant = yield* Schema.decodeEffect(CurrentExternalIdentityBindingSchema.fields.tenantId)(uid(99));
    const { assertionStatements, result } = yield* assertion({
      expected: { ...snapshot, tenantId: otherTenant },
    });
    denied(result);
    expect(assertionStatements.map((statement) => statement.sql)).toEqual(['ROLLBACK']);
  }),
);

for (const [field, value] of [
  ['authBindingId', uid(11)],
  ['authenticationNamespaceId', 'test.other-identity'],
  ['principalId', uid(12)],
  ['providerSubjectId', 'case-sensitive/customer_01'],
  ['subjectType', 'api_key'],
  ['bindingRevision', 2],
  ['tenantId', uid(13)],
] as const) {
  it.effect(`rejects persisted ${field} drift instead of trusting a prepared snapshot`, () =>
    Effect.gen(function* refusesChangedTarget() {
      const { assertionStatements, result } = yield* assertion({ rows: [bindingRow({ [field]: value })] });
      denied(result);
      noAssertionWrites(assertionStatements);
    }),
  );
}

for (const overrides of [
  { bindingStatus: 'pending' },
  { bindingStatus: 'disabled' },
  { bindingStatus: 'revoked' },
  { bindingStatus: 'expired' },
  { revokedAt: at },
  { principalStatus: 'disabled' },
  { principalStatus: 'archived' },
  { tenantStatus: 'suspended' },
  { tenantStatus: 'archived' },
  { principalKind: 'service' },
  { principalKind: 'integration' },
  { principalKind: 'agent' },
  { principalKind: 'system' },
] satisfies readonly Partial<BindingRow>[]) {
  it.effect(`rejects inactive or ineligible identity ${JSON.stringify(overrides)}`, () =>
    Effect.gen(function* refusesIneligibleTarget() {
      const { assertionStatements, result } = yield* assertion({ rows: [bindingRow(overrides)] });
      denied(result);
      noAssertionWrites(assertionStatements);
    }),
  );
}

it.effect('rejects a replayed snapshot after disable/reactivate advanced the persisted canonical revision', () =>
  Effect.gen(function* rejectsReactivationReplay() {
    const { result } = yield* assertion({ rows: [bindingRow({ bindingRevision: snapshot.bindingRevision + 2 })] });
    denied(result);
  }),
);

it.effect('rejects absent and ambiguous bindings without an alternate lookup or admission path', () =>
  Effect.gen(function* rejectsMissingIdentity() {
    denied((yield* assertion({ rows: [] })).result);
    denied((yield* assertion({ rows: [bindingRow(), bindingRow()] })).result);
  }),
);

it.effect('maps malformed persisted revision to unavailable and an invalid expected revision to denied', () =>
  Effect.gen(function* rejectsInvalidRevision() {
    const { result } = yield* assertion({ rows: [bindingRow({ bindingRevision: 0 })] });
    const error = Option.getOrUndefined(Exit.findErrorOption(result));
    expect(Schema.is(ExternalIdentityBindingCurrentnessError)(error)).toBe(true);
    if (Schema.is(ExternalIdentityBindingCurrentnessError)(error)) {
      expect(error.code).toBe('identity_unavailable');
    }
    const invalidExpected = yield* assertion({ expected: { ...snapshot, bindingRevision: 0 } });
    denied(invalidExpected.result);
    expect(invalidExpected.assertionStatements.map((statement) => statement.sql)).toEqual(['ROLLBACK']);
  }),
);

it.effect('returns only sanitized unavailable on SQL failure and rolls back without owner observation', () =>
  Effect.gen(function* unavailableBinding() {
    const { assertionStatements, result } = yield* assertion({ failLookup: true });
    const error = Option.getOrUndefined(Exit.findErrorOption(result));
    expect(Schema.is(ExternalIdentityBindingCurrentnessError)(error)).toBe(true);
    if (Schema.is(ExternalIdentityBindingCurrentnessError)(error)) {
      expect(error.code).toBe('identity_unavailable');
    }
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(error);
    expect(encoded).not.toContain('private binding database outage');
    expect(assertionStatements.at(-1)?.sql).toBe('ROLLBACK');
    expect(assertionStatements.some((statement) => statement.sql.includes('owner-transaction-still-open'))).toBe(false);
    noAssertionWrites(assertionStatements);
  }),
);

it.layer(NodeCrypto.layer)('published binding Read snapshot', (suite) => {
  suite.effect('uses the original registered Read result revision without deriving a replacement revision', () =>
    Effect.gen(function* originalReadProjection() {
      const harness = yield* makeReadTestHarness({
        access: 'allowed',
        executeOwnerQuery: (query) =>
          Effect.sync(() => {
            expect(query.sql).toContain('from "core"."principal_auth_bindings"');
            expect(query.params).toEqual([tenantId, authBindingId, 2]);
            return [bindingRow()];
          }),
        operationTime: at,
        ownerAuthorizationDecision: 'allowed',
        scope: requester,
      });
      const read = yield* harness.runtime
        .runRead({
          input: { authBindingId: snapshot.authBindingId, lookup: 'binding' },
          principal: requester,
          registration: readPrincipalBinding,
          transport: { correlationId: requester.correlationId },
        })
        .pipe(Effect.provideService(AuthenticationNamespaceRegistry, registry));
      expect(read.outcome).toBe('FOUND');
      if (read.outcome !== 'FOUND') {
        return yield* Effect.die('The actual registered Core binding Read must find this fixture');
      }
      const expected: CurrentExternalIdentityBinding = {
        authBindingId: read.authBindingId,
        authenticationNamespaceId: read.authenticationNamespaceId,
        bindingRevision: read.bindingRevision,
        principalId: read.principalId,
        providerSubjectId: snapshot.providerSubjectId,
        subjectType: snapshot.subjectType,
        tenantId: snapshot.tenantId,
      };
      expect(expected.bindingRevision).toBe(bindingRow().bindingRevision);
      const { result } = yield* assertion({ expected });
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toBe(true);
      expect(harness.snapshot().statements).toContain('COMMIT');
      return yield* Effect.void;
    }),
  );
});
