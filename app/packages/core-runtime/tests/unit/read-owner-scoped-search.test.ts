import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { evaluateListAccessPredicate } from '../../src/access/decision/list-access.ts';
import { RecordKeySchema } from '../../src/access/ids.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { ContextAccess } from '../../src/permissions/context-access.ts';
import type { ReadLoadContext } from '../../src/reads/context.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { ReadPermissionDenied, ReadPermissionUnavailable } from '../../src/reads/errors.ts';
import { makeTestBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeReadTestHarness } from '../../src/testing/reads.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

const moduleId = 'demo.owner-ledger';
const readKey = 'demo.owner-ledger.search.records';
const accessKey = 'demo.owner-ledger.search-records.read';
const companyA = '71000000-0000-4000-8000-000000000020';
const companyB = '71000000-0000-4000-8000-000000000021';
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z'));
const descriptor = () => ({
  accessDeclaration: {
    key: accessKey,
    kind: 'read' as const,
    modes: ['run' as const],
    placement: { group: 'owner-ledger', level: 'basic' as const },
    risk: 'sensitive' as const,
    selectors: ['all' as const],
  },
  accessKind: 'search' as const,
  entrypoint: defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: readKey,
    moduleKey: moduleId,
    role: 'search',
  }),
  evidencePolicy: { captureMode: 'metadata_only' as const, policyKey: 'demo.owner-ledger.search.evidence.v1' },
  inputSchema: Schema.Struct({ query: Schema.String }),
  legalEntityScope: 'required' as const,
  owningModuleKey: moduleId,
  policies: [],
  readKey,
  resultSchema: Schema.Array(Schema.String),
  schemaVersion: '1',
});
const emptyHandler = { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: [] }) };
const emptyServices = () => Effect.succeed({});

it('rejects every retired result-authorization declaration, including an explicit undefined property', () => {
  expect(() => defineRead(descriptor(), emptyHandler, emptyServices)).not.toThrow();
  for (const metadata of [
    undefined,
    { accessFiltering: 'legal_entity_scope', kind: 'owner-legal-entity-scope', requiredModuleAccess: true },
    { kind: 'search-collection', select: () => Effect.die('Retired adapters must never execute') },
  ]) {
    const input = descriptor();
    Reflect.set(input, 'resultAuthorization', metadata);
    expect(() => defineRead(input, emptyHandler, emptyServices)).toThrow();
  }
});

it('freezes the canonical declaration independently of its authored input', () => {
  const input = descriptor();
  const registration = defineRead(input, emptyHandler, emptyServices);
  expect(Object.isFrozen(registration.descriptor.accessDeclaration)).toBe(true);
  Reflect.set(input.accessDeclaration, 'risk', 'routine');
  expect(registration.descriptor.accessDeclaration?.risk).toBe('sensitive');
  expect(Object.hasOwn(registration.descriptor, 'resultAuthorization')).toBe(false);
});

const runScopedSearch = (
  selectedCompany: string | undefined,
  outcome: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE',
  foreignOwner = false,
) =>
  Effect.scoped(
    Effect.gen(function* run() {
      let ownerRuns = 0;
      const registration = defineRead(
        descriptor(),
        {
          load: (_input, context: ReadLoadContext<Readonly<Record<string, never>>>) =>
            Effect.sync(() => {
              ownerRuns += 1;
              expect(context.listAccess).toEqual({ groups: [] });
              const key = 'current-company-invoice';
              const result =
                context.listAccess !== undefined &&
                evaluateListAccessPredicate(context.listAccess, {
                  recordKey: RecordKeySchema.make(key),
                  teamIds: [],
                })
                  ? [key]
                  : [];
              return { evidence: { resultCount: result.length }, result };
            }),
        },
        emptyServices,
      );
      const owner = foreignOwner
        ? makeTestOperationOwner({ moduleId: 'demo.foreign' })
        : makeTestOperationOwner({ moduleId, reads: [registration] });
      const claims: OperationalScope = {
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'session:owner-scoped-search',
        authMethod: 'session',
        correlationId: 'owner-scoped-search-test',
        principalId: '72000000-0000-4000-8000-000000000023',
        tenantId: '70000000-0000-4000-8000-000000000020',
      };
      if (selectedCompany !== undefined) {
        Object.assign(claims, { legalEntityId: selectedCompany });
      }
      const principal = trustVerifiedGatewayPrincipalContext(claims, owner.composition.revision);
      const gate = makeTestBoundAccessGate({ answers: { [accessKey]: { outcome, predicate: { groups: [] } } } });
      const harness = yield* makeReadTestHarness({
        accessDecision: gate.bound,
        applicationComposition: owner.applicationComposition,
        compositionRevision: owner.composition.revision,
        executeOwnerQuery: () => Effect.die('This owner has no SQL query in the fixture'),
        expectedDeployment: owner.expectedDeployment,
        operationTime,
        ownerAuthorizationDecision: 'allowed',
        ownerRegistration: owner.ownerRegistration,
        scope: principal,
      });
      Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
        modules: () => Effect.die('Retired module authority was invoked'),
        resources: () => Effect.die('Retired resource authority was invoked'),
      });
      const exit = yield* harness.runtime
        .runRead({
          input: { query: '2026' },
          principal,
          registration,
          transport: { correlationId: principal.correlationId },
        })
        .pipe(Effect.exit);
      return { exit, gate: gate.accessDecision, ownerRuns };
    }),
  );
const failureFor = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
it.layer(NodeCrypto.layer)('canonical owner-scoped search', (suite) => {
  suite.effect('preserves the exact original LIST declaration and selected-company scope', () =>
    Effect.gen(function* allowed() {
      const result = yield* runScopedSearch(companyA, 'ALLOWED');
      expect(result.exit).toEqual(Exit.succeed(['current-company-invoice']));
      expect(result.ownerRuns).toBe(1);
      expect(result.gate.askedLists).toHaveLength(1);
      expect(result.gate.askedLists[0]?.carrier.accessDeclaration?.key).toBe(accessKey);
      expect(result.gate.askedDecisions).toEqual([]);
    }),
  );
  for (const outcome of ['DENIED', 'UNAVAILABLE'] as const) {
    suite.effect(`keeps canonical ${outcome} before all owner work in either selected company`, () =>
      Effect.gen(function* denied() {
        for (const company of [companyA, companyB]) {
          const result = yield* runScopedSearch(company, outcome);
          expect(
            outcome === 'DENIED'
              ? result.exit.pipe(failureFor, Schema.is(ReadPermissionDenied))
              : result.exit.pipe(failureFor, Schema.is(ReadPermissionUnavailable)),
          ).toBe(true);
          expect(result.ownerRuns).toBe(0);
        }
      }),
    );
  }
  suite.effect('refuses a foreign receiving owner and a missing selected company before owner work', () =>
    Effect.gen(function* invalidOwnerOrScope() {
      const foreign = yield* runScopedSearch(companyA, 'ALLOWED', true);
      const missingCompany = yield* runScopedSearch(undefined, 'ALLOWED');
      expect(Exit.isFailure(foreign.exit)).toBe(true);
      expect(Exit.isFailure(missingCompany.exit)).toBe(true);
      expect(foreign.ownerRuns).toBe(0);
      expect(missingCompany.ownerRuns).toBe(0);
    }),
  );
});
