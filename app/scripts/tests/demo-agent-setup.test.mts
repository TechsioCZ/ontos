import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ConfigureAgentResultSchema, ReplaceAgentOperatorsResultSchema } from '@app/core-runtime';
import {
  ActionAlreadyCommitted,
  ActionRuntime,
  ActionTransportMetadataSchema,
  AgentProfileSchema,
  ContextAccess,
  LegalEntityContext,
  companyManagedPrincipalsRead,
  ReadRuntime,
  ReplaceAgentOperatorsPayloadSchema,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { OperationalScopeResolver } from '@app/core-runtime/operations/context';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Option, Schema } from 'effect';
import { AccessPeopleDirectory } from '@app/core-runtime/access/intent/people-directory';
import { TenantIntentLoader } from '@app/core-runtime/access/intent/tenant-intent-loader';
import {
  AccessScopeIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '@app/core-runtime/access/ids';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { AuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';
import { coreRelations } from '../../packages/core-runtime/src/db/schema.ts';
import {
  AgentProfileReadDatabase,
  AgentProfileSetupError,
  AgentProfileSetupInputSchema,
  explicitProfileInputs,
  reviewedProfileInputs,
  runAgentProfileSetup,
} from '../demo/agent-profile-setup.mts';
import { requireAgentSetupAuthority, selectAgentOperatorCompany } from '../demo/agent-operator-session.mts';
import { AgentSeedIdentityWriter } from '../demo/agent-seed-identity.mts';
import { runAgentOperatorSetup } from '../demo/setup-agent-operators.mts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const secondCompanyId = '20000000-0000-4000-8000-000000000002';
const agentId = '30000000-0000-4000-8000-000000000001';
const secondAgentId = '30000000-0000-4000-8000-000000000002';
const humanId = '40000000-0000-4000-8000-000000000001';
const existingHumanId = '40000000-0000-4000-8000-000000000002';
const actor = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'session:script-unit-fixture',
  authenticationNamespaceId: 'test.staff',
  authMethod: 'session',
  principalId: humanId,
  tenantId,
});
const operator = { principal: actor, requestHeaders: new Headers({ cookie: 'fixture-session' }) };
const input = Schema.decodeUnknownSync(AgentProfileSetupInputSchema)({
  description: 'Reviewed profile display data',
  displayName: 'Reviewed agent',
  legalEntityId: companyId,
  modules: [{ access: 'write', moduleId: 'work.tasks' }],
  operation: 'create-agent',
  ownerPrincipalId: humanId,
  principalId: agentId,
  tenantId,
  writePolicy: 'direct',
});
const configureAgentOperation = 'configure-agent' as const;
const replaceAgentOperatorsKey = 'core.identity.replace-agent-operators';
/** The configure member of the Action payload: the only one the seed sends, naming the agent it seeded. */
const ConfiguredAgentPayloadSchema = Schema.Struct({
  ...AgentProfileSchema.fields,
  operation: Schema.Literal(configureAgentOperation),
  principalId: Schema.String.pipe(Schema.brand('PrincipalId')),
});

const configureAgentKey = 'core.identity.configure-agent';
const principalMembershipTable = '"principal_company_memberships"';
const persistedAgentName = 'Persisted agent name';
const source = createHash('sha256').update('reviewed-fixture').digest('hex');
const evidence = (row = input, revision = 1) => ({
  description: row.description,
  displayName: row.displayName,
  legalEntityId: row.legalEntityId,
  modules: row.modules,
  operation: row.operation,
  ownerPrincipalId: row.ownerPrincipalId,
  previousProfile: null,
  revision,
  targetPrincipalId: row.principalId,
  writePolicy: row.writePolicy,
});
const nativeCommand = (operators: readonly string[], revision = 1) => ({
  agentPrincipalId: agentId,
  context: 'operators-edited',
  desiredOperatorPrincipalIds: operators,
  legalEntityId: companyId,
  previousRevision: revision - 1,
  revision,
  revokedConnections: 0,
});

const directoryPerson = (principalId: string, kind: string) => ({
  displayName: principalId,
  kind,
  principalId: PrincipalIdSchema.make(principalId),
  status: 'active',
});

const fixture = (
  options: {
    readonly alreadyCommitted?: boolean;
    readonly denyCompany?: string;
    readonly directoryKind?: string;
    readonly existingOperators?: readonly string[];
    readonly mismatchBinding?: boolean;
    readonly missingMembership?: boolean;
    readonly newerAfterCommit?: boolean;
    readonly profile?: unknown;
    readonly target?: 'human' | 'agent';
  } = {},
) => {
  const profiles = new Map<string, unknown>();
  if (options.profile !== undefined) {
    profiles.set(agentId, options.profile);
  }
  const targets = new Set(options.target === undefined ? [] : [agentId]);
  let command: unknown = options.existingOperators === undefined ? undefined : nativeCommand(options.existingOperators);
  let selectedCompanyId = companyId;
  let selectedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    ...actor,
    legalEntityId: companyId,
  });
  const writes: {
    readonly actionKey: string;
    readonly idempotencyKey: string | undefined;
    readonly payload: unknown;
    readonly principal: unknown;
  }[] = [];
  const selections: string[] = [];
  const scopes: unknown[] = [];
  const queries: string[] = [];
  const database = Layer.effect(
    AgentProfileReadDatabase,
    Effect.gen(function* scriptedReadDatabase() {
      const executor = yield* makeWithDefaults({ relations: coreRelations });
      return { executor };
    }),
  ).pipe(
    Layer.provide(
      scriptedPgClientLayer(
        Effect.succeed(
          testSqlConnection((text, params) => {
            queries.push(text);
            if (text.includes('"audit_events"')) {
              const isOperators = params.includes(replaceAgentOperatorsKey);
              const current = isOperators
                ? command
                : profiles.get(params.includes(secondAgentId) ? secondAgentId : agentId);
              return Effect.succeed(
                current === undefined
                  ? []
                  : [isOperators ? { evidence: current, legalEntityId: companyId } : { evidence: current }],
              );
            }
            if (text.includes(principalMembershipTable)) {
              return Effect.succeed(
                options.missingMembership === true ? [] : [{ affiliation: null, status: 'active' }],
              );
            }
            if (text.includes('"principals"')) {
              const principalId = params.includes(secondAgentId) ? secondAgentId : agentId;
              if (!targets.has(principalId)) {
                return Effect.succeed([]);
              }
              const selected = text.slice(0, text.indexOf(' from '));
              const values = new Map(
                Object.entries({
                  display_name: persistedAgentName,
                  kind: options.target ?? 'agent',
                  principal_id: principalId,
                  status: 'active',
                }),
              );
              const columns = [...selected.matchAll(/"(?<column>[a-z_]+)"/gu)].map(
                (match) => match.groups?.column ?? '',
              );
              return Effect.succeed([Object.fromEntries(columns.map((column) => [column, values.get(column)]))]);
            }
            return Effect.die(`Unexpected SQL: ${text}`);
          }),
        ),
      ),
    ),
    Layer.provide(Reactivity.layer),
  );
  const tenantScopeId = AccessScopeIdSchema.make('70000000-0000-4000-8000-000000000001');
  const companyScopeId = AccessScopeIdSchema.make('70000000-0000-4000-8000-000000000002');
  const seeded: string[] = [];
  const layer = Layer.mergeAll(
    // The operator's own connection seeds a reviewed agent's fixed id; the Action then writes its profile.
    Layer.succeed(AgentSeedIdentityWriter, {
      seed: (identity) =>
        Effect.sync(() => {
          seeded.push(identity.principalId);
        }),
    }),
    database,
    Layer.mock(AuthenticationService, {
      resolveShellContext: () =>
        Effect.succeed({
          availableLegalEntities: [],
          identity: {
            displayName: 'Human',
            email: 'fixture@example.test',
            legalEntityId: selectedCompanyId,
            legalName: 'Company',
            principalId: humanId,
            tenantId,
          },
          principal: selectedPrincipal,
          setCookieHeaders: [],
          state: 'authenticated' as const,
        }),
      switchLegalEntity: (id, headers) =>
        Effect.sync(() => {
          expect(headers).toBe(operator.requestHeaders);
          selectedCompanyId = id;
          selectedPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
            ...actor,
            authBindingId:
              options.mismatchBinding === true ? '50000000-0000-4000-8000-000000000002' : actor.authBindingId,
            legalEntityId: id,
          });
          selections.push(id);
          return { selectedLegalEntityId: id, setCookieHeaders: [] };
        }),
    }),
    Layer.mock(ContextAccess, {}),
    Layer.mock(LegalEntityContext, {}),
    Layer.mock(AccessDecisionGate, {}),
    Layer.succeed(OperationalScopeResolver, {
      resolve: (request) =>
        Effect.sync(() => {
          expect(request.principal).toBe(selectedPrincipal);
          expect(request.legalEntityScope).toBe('required');
          const scope = { ...request.principal, correlationId: request.correlationId };
          scopes.push(scope);
          return scope;
        }),
    }),
    Layer.succeed(ActionAuthority, {
      checkActionAuthorities: ({ actionKeys, scope }) =>
        Effect.succeed(
          actionKeys.map((actionKey) => ({
            actionKey,
            execute: scope.legalEntityId === options.denyCompany ? ('denied' as const) : ('allowed' as const),
            propose: 'allowed' as const,
          })),
        ),
      checkActionProposalPermission: () => Effect.die('Setup must require run, never propose-only authority'),
    }),
    Layer.mock(ActionRuntime, {
      runAction: (request) => {
        const { actionKey } = request.registration.descriptor;
        writes.push({
          actionKey,
          idempotencyKey: Schema.decodeUnknownSync(ActionTransportMetadataSchema)(request.transport).idempotencyKey,
          payload: request.payload,
          principal: request.principal,
        });
        expect(request.principal).toBe(selectedPrincipal);
        let result: typeof ConfigureAgentResultSchema.Type | typeof ReplaceAgentOperatorsResultSchema.Type;
        if (actionKey === configureAgentKey) {
          const payload = Schema.decodeUnknownSync(ConfiguredAgentPayloadSchema)(request.payload);
          profiles.set(
            payload.principalId,
            evidence(
              { ...input, ...payload, legalEntityId: selectedCompanyId },
              options.newerAfterCommit === true ? 2 : 1,
            ),
          );
          if (options.newerAfterCommit === true) {
            profiles.set(payload.principalId, { ...evidence(), displayName: 'New administrator edit', revision: 2 });
          }
          targets.add(payload.principalId);
          result = { operation: payload.operation, principalId: payload.principalId, revision: 1, status: 'active' };
        } else {
          expect(actionKey).toBe(replaceAgentOperatorsKey);
          const payload = Schema.decodeUnknownSync(ReplaceAgentOperatorsPayloadSchema)(request.payload);
          command = nativeCommand(payload.operatorPrincipalIds, payload.expectedRevision + 1);
          result = { agentPrincipalId: agentId, projection: 'pending', revision: payload.expectedRevision + 1 };
        }
        return options.alreadyCommitted === true
          ? Effect.fail(
              new ActionAlreadyCommitted({
                code: 'action_already_committed',
                invocationId: '60000000-0000-4000-8000-000000000001',
                reason: 'Committed',
              }),
            )
          : Effect.sync(() => Schema.decodeUnknownSync(request.registration.descriptor.resultSchema)(result));
      },
    }),
    Layer.mock(ReadRuntime, {
      runRead: (request) => {
        expect(request.registration).toBe(companyManagedPrincipalsRead);
        expect(request.input).toMatchObject({ principalId: agentId, scope: 'company-agent' });
        return Effect.sync(() =>
          Schema.decodeUnknownSync(request.registration.descriptor.resultSchema)({
            items:
              options.profile === undefined || options.target !== 'agent'
                ? []
                : [{ kind: 'agent', principalId: agentId, principalStatus: 'active' }],
            nextOffset: null,
          }),
        );
      },
    }),
    Layer.mock(AccessPeopleDirectory, {
      people: () =>
        Effect.succeed([
          directoryPerson(humanId, options.directoryKind ?? 'human'),
          directoryPerson(existingHumanId, 'human'),
        ]),
    }),
    Layer.mock(TenantIntentLoader, {
      loadScope: () =>
        Effect.succeed(
          options.missingMembership === true
            ? Option.none()
            : Option.some({
                deadlines: [],
                holderDeadlines: [],
                scope: {
                  _tag: 'LegalEntity' as const,
                  legalEntityId: LegalEntityIdSchema.make(selectedCompanyId),
                  tenantId: TenantIdSchema.make(tenantId),
                },
                scopeId: companyScopeId,
                tenantId: TenantIdSchema.make(tenantId),
              }),
        ),
      loadTenantContextScopeId: () => Effect.succeed(Option.some(tenantScopeId)),
    }),
  );
  return { layer, profiles, queries, scopes, seeded, selections, writes };
};

it.effect('creates only native profile metadata using selected-session provenance and exact scope', () =>
  Effect.gen(function* nativeProfile() {
    const f = fixture();
    const result = yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(Effect.provide(f.layer));
    expect(result).toMatchObject({ applied: 1, authority: 'not-provisioned', verified: true });
    expect(f.selections).toEqual([companyId, companyId]);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.actionKey).toBe(configureAgentKey);
    // The reviewed agent keeps its fixed id through the operator's seed; the Action names it, never creates it.
    expect(f.seeded).toEqual([agentId]);
    expect(f.writes[0]?.payload).toMatchObject({ operation: configureAgentOperation, principalId: agentId });
    expect(f.scopes).toHaveLength(1);
    expect(f.queries.every((query) => query.startsWith('select '))).toBe(true);
  }),
);

it.effect('does not replay a matching profile or change any credentials', () =>
  Effect.gen(function* idempotentProfile() {
    const f = fixture({ profile: evidence(), target: 'agent' });
    const result = yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(Effect.provide(f.layer));
    expect(result.applied).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.queries.join('\n')).not.toContain('principal_auth_bindings');
  }),
);

it.effect('keeps the same native idempotency identity for the same reviewed payload', () =>
  Effect.gen(function* retryIdentity() {
    const a = fixture();
    const b = fixture({ alreadyCommitted: true });
    yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(Effect.provide(a.layer));
    yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(Effect.provide(b.layer));
    expect(a.writes[0]?.idempotencyKey).toBe(b.writes[0]?.idempotencyKey);
  }),
);

it.effect('refuses a later administrator profile instead of overwriting it', () =>
  Effect.gen(function* newerProfile() {
    const f = fixture({ profile: { ...evidence(), displayName: 'Administrator name', revision: 2 }, target: 'agent' });
    const failure = yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(
      Effect.provide(f.layer),
      Effect.flip,
    );
    expect(Schema.is(AgentProfileSetupError)(failure)).toBe(true);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('rechecks current audit evidence after an idempotent commit', () =>
  Effect.gen(function* committedConflict() {
    const f = fixture({ alreadyCommitted: true, newerAfterCommit: true });
    const failure = yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(
      Effect.provide(f.layer),
      Effect.flip,
    );
    expect(Schema.is(AgentProfileSetupError)(failure)).toBe(true);
    expect(f.writes).toHaveLength(1);
  }),
);

it.effect('preflights every company before any write and never accepts propose-only authority', () =>
  Effect.gen(function* batchDenial() {
    const f = fixture({ denyCompany: secondCompanyId });
    const failure = yield* runAgentProfileSetup(
      operator,
      [input, { ...input, legalEntityId: secondCompanyId, principalId: secondAgentId }],
      'apply',
      source,
    ).pipe(Effect.provide(f.layer), Effect.flip);
    expect(Schema.is(AgentProfileSetupError)(failure)).toBe(true);
    expect(f.writes).toEqual([]);
    expect(f.selections).toEqual([companyId, secondCompanyId]);
  }),
);

it.effect('does not let profile writePolicy or module flags override denied role authority', () =>
  Effect.gen(function* metadataDoesNotGrant() {
    const f = fixture({ denyCompany: companyId, profile: evidence(), target: 'agent' });
    yield* runAgentProfileSetup(operator, [input], 'verify', source).pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('does not adopt a human identity as an agent', () =>
  Effect.gen(function* wrongKind() {
    const f = fixture({ target: 'human' });
    yield* runAgentProfileSetup(operator, [input], 'apply', source).pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('requires exact company membership before configuring an existing agent', () =>
  Effect.gen(function* membershipMissing() {
    const f = fixture({ missingMembership: true, target: 'agent' });
    yield* runAgentProfileSetup(operator, [{ ...input, operation: configureAgentOperation }], 'apply', source).pipe(
      Effect.provide(f.layer),
      Effect.flip,
    );
    expect(f.writes).toEqual([]);
  }),
);

it.effect('refuses another tenant and duplicate input without writing', () =>
  Effect.gen(function* invalidBatch() {
    for (const rows of [[input, input], [{ ...input, tenantId: '10000000-0000-4000-8000-000000000002' }]]) {
      const f = fixture();
      yield* runAgentProfileSetup(operator, rows, 'apply', source).pipe(Effect.provide(f.layer), Effect.flip);
      expect(f.writes).toEqual([]);
    }
  }),
);

it.effect('preserves persisted display names and rejects non-agent explicit setup input', () =>
  Effect.gen(function* explicitIdentity() {
    const f = fixture({ target: 'agent' });
    const rows = yield* explicitProfileInputs([input]).pipe(Effect.provide(f.layer));
    expect(rows[0]).toMatchObject({ displayName: persistedAgentName, operation: configureAgentOperation });
    const human = fixture({ target: 'human' });
    yield* explicitProfileInputs([input]).pipe(Effect.provide(human.layer), Effect.flip);
  }),
);

it.effect('keeps reviewed replay configure-only and preserves the persisted name', () =>
  Effect.gen(function* reviewedIdentity() {
    const f = fixture({ target: 'agent' });
    const rows = yield* reviewedProfileInputs({ profiles: [input], schemaVersion: 2 }).pipe(Effect.provide(f.layer));
    expect(rows[0]).toMatchObject({ displayName: persistedAgentName, operation: configureAgentOperation });
  }),
);

it.effect('rejects an authentication binding change during native company selection', () =>
  Effect.gen(function* selectionBinding() {
    const f = fixture({ mismatchBinding: true });
    yield* selectAgentOperatorCompany(operator, companyId).pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
    expect(f.scopes).toEqual([]);
  }),
);

it.effect('records the union of existing and requested native human oversight without materializing grants', () =>
  Effect.gen(function* nativeOperators() {
    const f = fixture({ existingOperators: [existingHumanId], profile: evidence(), target: 'agent' });
    const result = yield* runAgentOperatorSetup(
      operator,
      [{ agentPrincipalId: agentId, legalEntityId: companyId, operatorPrincipalIds: [humanId] }],
      'apply',
    ).pipe(Effect.provide(f.layer));
    expect(result).toEqual({ applied: 1, authority: 'not-provisioned', mode: 'apply', pending: 0 });
    expect(f.writes[0]?.payload).toMatchObject({
      expectedRevision: 1,
      operatorPrincipalIds: [humanId, existingHumanId].toSorted(),
      revokedConnections: 0,
    });
    expect(f.writes[0]?.actionKey).toBe(replaceAgentOperatorsKey);
    expect(f.queries.every((query) => query.startsWith('select '))).toBe(true);
  }),
);

it.effect('does not repeat matching native oversight commands', () =>
  Effect.gen(function* idempotentOperators() {
    const f = fixture({ existingOperators: [humanId], profile: evidence(), target: 'agent' });
    yield* runAgentOperatorSetup(
      operator,
      [{ agentPrincipalId: agentId, legalEntityId: companyId, operatorPrincipalIds: [humanId] }],
      'apply',
    ).pipe(Effect.provide(f.layer));
    expect(f.writes).toEqual([]);
  }),
);

it.effect('does not replace a human operator with a service identity', () =>
  Effect.gen(function* nonHumanOperator() {
    const f = fixture({ directoryKind: 'agent', profile: evidence(), target: 'agent' });
    yield* runAgentOperatorSetup(
      operator,
      [{ agentPrincipalId: agentId, legalEntityId: companyId, operatorPrincipalIds: [humanId] }],
      'apply',
    ).pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('fails before any write when the complete preserved operator set is invalid', () =>
  Effect.gen(function* missingPreservedOperator() {
    const f = fixture({ existingOperators: [secondAgentId], profile: evidence(), target: 'agent' });
    yield* runAgentOperatorSetup(
      operator,
      [{ agentPrincipalId: agentId, legalEntityId: companyId, operatorPrincipalIds: [humanId] }],
      'apply',
    ).pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('does not write in dry-run or turn missing native operator intent into verified success', () =>
  Effect.gen(function* previewOnly() {
    const f = fixture({ profile: evidence(), target: 'agent' });
    const rows = [{ agentPrincipalId: agentId, legalEntityId: companyId, operatorPrincipalIds: [humanId] }];
    const result = yield* runAgentOperatorSetup(operator, rows, 'dry-run').pipe(Effect.provide(f.layer));
    expect(result.pending).toBe(1);
    yield* runAgentOperatorSetup(operator, rows, 'verify').pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('requires the exact native Action authority rather than an unrelated allowed answer', () =>
  Effect.gen(function* exactAction() {
    const f = fixture();
    const selected = yield* selectAgentOperatorCompany(operator, companyId).pipe(Effect.provide(f.layer));
    const failure = yield* requireAgentSetupAuthority(selected, configureAgentKey).pipe(
      Effect.provideService(ActionAuthority, {
        checkActionAuthorities: () =>
          Effect.succeed([{ actionKey: 'other.action', execute: 'allowed', propose: 'allowed' }]),
        checkActionProposalPermission: () => Effect.succeed('allowed' as const),
      }),
      Effect.provide(f.layer),
      Effect.flip,
    );
    expect(Schema.is(AgentProfileSetupError)(failure)).toBe(true);
  }),
);

it('the active setup chain imports no retired materializer and writes no authorization tuples or consent tables', () => {
  for (const file of ['agent-profile-setup', 'agent-profile-operator', 'setup-agent-operators']) {
    const text = readFileSync(new URL(`../demo/${file}.mts`, import.meta.url), 'utf-8');
    for (const retired of [
      'agent-profile-lifecycle',
      'ScopedRoleMembershipLifecycle',
      'reconcilePrincipal(',
      'openDemoAccountGrants',
      'writeRelationships(',
      'replaceAgentGrants(',
      'accessAgentConnections',
      'accessConsentSnapshots',
      'checkActionPermission(',
      'companyAgentDirectoryRead',
    ]) {
      expect({ file, found: text.includes(retired), retired }).toEqual({ file, found: false, retired });
    }
  }
  const up = readFileSync(new URL('../demo/up.sh', import.meta.url), 'utf-8');
  expect(up).not.toContain('company-membership-hygiene.mts');
});

it.effect('does not accept an active directory label without live canonical company membership', () =>
  Effect.gen(function* noMembershipFromLabels() {
    const f = fixture({ missingMembership: true, profile: evidence(), target: 'agent' });
    const failure = yield* runAgentOperatorSetup(
      operator,
      [
        {
          agentPrincipalId: agentId,
          legalEntityId: companyId,
          operatorPrincipalIds: [humanId],
        },
      ],
      'apply',
    ).pipe(Effect.provide(f.layer), Effect.flip);
    expect(Schema.is(AgentProfileSetupError)(failure)).toBe(true);
    expect(f.writes).toEqual([]);
  }),
);

it.effect('keeps updated native session cookies across company selection without changing the principal binding', () =>
  Effect.gen(function* nativeCookies() {
    const session = {
      principal: actor,
      requestHeaders: new Headers({ cookie: 'fixture-session=old; unrelated=keep' }),
    };
    const selected = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({ ...actor, legalEntityId: companyId });
    const result = yield* selectAgentOperatorCompany(session, companyId).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(AuthenticationService, {
            resolveShellContext: (headers) => {
              expect(headers.get('cookie')).toBe('fixture-session=new; unrelated=keep');
              return Effect.succeed({
                availableLegalEntities: [],
                identity: {
                  displayName: 'Human',
                  email: 'fixture@example.test',
                  legalEntityId: companyId,
                  legalName: 'Company',
                  principalId: humanId,
                  tenantId,
                },
                principal: selected,
                setCookieHeaders: [],
                state: 'authenticated' as const,
              });
            },
            switchLegalEntity: (selectedLegalEntityId) =>
              Effect.succeed({ selectedLegalEntityId, setCookieHeaders: ['fixture-session=new; Path=/; HttpOnly'] }),
          }),
          Layer.mock(ContextAccess, {}),
          Layer.mock(LegalEntityContext, {}),
          Layer.mock(AccessDecisionGate, {}),
        ),
      ),
    );
    expect(result).toBe(selected);
    expect(session.requestHeaders.get('cookie')).toBe('fixture-session=new; unrelated=keep');
  }),
);

it.effect('does not write during profile dry-run or verify a missing audited profile', () =>
  Effect.gen(function* readOnlyProfileModes() {
    const f = fixture();
    const preview = yield* runAgentProfileSetup(operator, [input], 'dry-run', source).pipe(Effect.provide(f.layer));
    expect(preview.verified).toBe(false);
    yield* runAgentProfileSetup(operator, [input], 'verify', source).pipe(Effect.provide(f.layer), Effect.flip);
    expect(f.writes).toEqual([]);
  }),
);
