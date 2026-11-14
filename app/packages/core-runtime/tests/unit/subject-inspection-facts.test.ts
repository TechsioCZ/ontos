import { Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeDrizzleSubjectIdentityFacts } from '../../src/access/enforcement/inspection-facts.ts';
import { SubjectInspectionUnavailable } from '../../src/access/enforcement/inspection-contract.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const requesterId = '00000000-0000-4000-8000-000000000003';
const subjectId = '00000000-0000-4000-8000-000000000004';
const requesterScope: OperationalScope = Object.freeze({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000005',
    authContextRef: 'session:subject-inspection',
    authMethod: 'session',
    legalEntityId,
    principalId: requesterId,
    tenantId,
  }),
  correlationId: 'subject-inspection-requester',
});

const load = Effect.fn('SubjectFactsTest.load')(function* load(
  options: {
    readonly companyMissing?: boolean;
    readonly failure?: boolean;
    readonly foreignCompany?: boolean;
    readonly installedCompany?: string;
    readonly membershipMissing?: boolean;
    readonly principalMissing?: boolean;
    readonly tenantOnly?: boolean;
  } = {},
) {
  const queries: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
  const database = yield* makeTestDatabase((sql, params) => {
    queries.push({ params, sql });
    if (sql.includes('from "core"."principals"')) {
      if (options.failure === true) {
        return Effect.fail(new SqlError({ reason: new ConnectionError({ cause: 'controlled subject store outage' }) }));
      }
      return Effect.succeed(
        options.principalMissing === true ? [] : [{ principalStatus: 'active', tenantStatus: 'active' }],
      );
    }
    if (sql.includes('from "core"."legal_entities"')) {
      return Effect.succeed(options.companyMissing === true ? [] : [{ status: 'active' }]);
    }
    if (sql.includes('from "core"."principal_company_memberships"')) {
      return Effect.succeed(options.membershipMissing === true ? [] : [{ affiliation: 'external', status: 'active' }]);
    }
    return Effect.succeed([
      { legal_entity_id: options.installedCompany ?? legalEntityId, role: 'ontos_runtime', tenant_id: tenantId },
    ]);
  });
  const service = makeDrizzleSubjectIdentityFacts({
    enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
    executor: database,
  });
  const query = { principalId: subjectId, requesterScope };
  const result = yield* Effect.result(
    service.read(
      options.tenantOnly === true
        ? query
        : { ...query, legalEntityId: options.foreignCompany === true ? tenantId : legalEntityId },
    ),
  );
  return { queries, result };
});

it.effect('reads persisted subject/tenant/company/external-member facts in the actual requester SQL scope', () =>
  Effect.gen(function* persistedFacts() {
    const { queries, result } = yield* load();
    expect(Result.isSuccess(result) && Option.getOrUndefined(result.success)).toEqual({
      companyStatus: 'active',
      membership: { affiliation: 'external', status: 'active' },
      principalStatus: 'active',
      tenantStatus: 'active',
    });
    expect(queries.find(({ sql }) => sql.includes('set_config'))?.params).toEqual([tenantId, legalEntityId]);
    expect(queries.find(({ sql }) => sql.includes('from "core"."principals"'))?.params).toEqual([
      tenantId,
      subjectId,
      1,
    ]);
    expect(queries.find(({ sql }) => sql.includes('from "core"."principal_company_memberships"'))?.params).toEqual([
      tenantId,
      legalEntityId,
      subjectId,
      1,
    ]);
    expect(queries.every(({ sql }) => !/\b(?:insert|update|delete)\b/iu.test(sql))).toBe(true);
    expect(queries.some(({ params }) => params.includes(requesterId))).toBe(false);
  }),
);

for (const [name, options] of [
  ['missing subject', { principalMissing: true }],
  ['missing company', { companyMissing: true }],
] as const) {
  it.effect(`${name} yields no identity rather than a synthetic subject`, () =>
    Effect.gen(function* noIdentity() {
      const { result } = yield* load(options);
      expect(Result.isSuccess(result) && Option.isNone(result.success)).toBe(true);
    }),
  );
}

for (const [name, options] of [
  ['foreign company override', { foreignCompany: true }],
  ['wrong installed scope', { installedCompany: tenantId }],
  ['SQL outage', { failure: true }],
] as const) {
  it.effect(`fails closed on ${name}`, () =>
    Effect.gen(function* unsafeRead() {
      const { queries, result } = yield* load(options);
      expect(Result.isFailure(result) && Schema.is(SubjectInspectionUnavailable)(result.failure)).toBe(true);
      if (options.foreignCompany === true) {
        expect(queries.some(({ sql }) => sql.includes('from "core"'))).toBe(false);
      }
    }),
  );
}

it.effect('tenant-context inspection does not silently select or read another company', () =>
  Effect.gen(function* tenantInspection() {
    const { queries, result } = yield* load({ tenantOnly: true });
    expect(Result.isSuccess(result) && Option.getOrUndefined(result.success)).toEqual({
      principalStatus: 'active',
      tenantStatus: 'active',
    });
    expect(
      queries.some(
        ({ sql }) =>
          sql.includes('from "core"."legal_entities"') || sql.includes('from "core"."principal_company_memberships"'),
      ),
    ).toBe(false);
    expect(queries.find(({ sql }) => sql.includes('set_config'))?.params).toEqual([tenantId, legalEntityId]);
  }),
);

it.effect('does not invent a membership when a tenant owner has no company directory row', () =>
  Effect.gen(function* absentDirectoryRow() {
    const { result } = yield* load({ membershipMissing: true });
    expect(Result.isSuccess(result) && Option.getOrUndefined(result.success)).toEqual({
      companyStatus: 'active',
      principalStatus: 'active',
      tenantStatus: 'active',
    });
    // This is identity data only. resolveActorContext must still prove membership or the real owner exception.
  }),
);
