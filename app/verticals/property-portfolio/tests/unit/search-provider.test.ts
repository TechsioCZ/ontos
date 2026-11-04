import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
} from '@app/core-runtime';
import type {
  ContextAccessDecision,
  ContextAccessService,
  CoreSearchProjectionHit,
  ReadRuntimeService,
} from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Cause, Context, Crypto, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { assetsRead } from '../../src/search/assets.provider.ts';
import { propertiesRead } from '../../src/search/properties.provider.ts';
import { unitsRead } from '../../src/search/units.provider.ts';

const scope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:property-search-provider-test',
  authMethod: 'session',
  correlationId: 'property-search-provider-test',
  legalEntityId: '20000000-0000-4000-8000-000000000001',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;

const ResourceSchema = Schema.Literals(['property', 'unit', 'asset']);
type Resource = typeof ResourceSchema.Type;
type ResourceCheck = ContextAccessService['resources'];

const request = {
  input: { query: 'Park' },
  principal: scope,
  transport: { correlationId: scope.correlationId },
};

// Keep the original generated registrations and the real Core Read lifecycle in every scenario.
const runProvider = (resource: Resource, runtime: ReadRuntimeService) =>
  Effect.gen(function* runSelectedProvider() {
    if (resource === 'property') {
      return yield* runtime.runRead({ ...request, registration: propertiesRead });
    }
    if (resource === 'unit') {
      return yield* runtime.runRead({ ...request, registration: unitsRead });
    }
    return yield* runtime.runRead({ ...request, registration: assetsRead });
  });

const hitFor = (resource: Resource, suffix: string, title: string, score: number) => {
  const candidate = {
    archived: false,
    facets: [],
    metadata: [],
    ref: {
      moduleId: 'property.portfolio',
      resourceId: `40000000-0000-4000-8000-00000000000${suffix}`,
      resourceType: `property.portfolio.${resource}`,
      tenantId: scope.tenantId,
    },
    selectedLegalEntityId: scope.legalEntityId,
    title,
  };
  return Schema.decodeUnknownEffect(CoreSearchProjectionHitSchema)(
    resource === 'asset' ? { ...candidate, relevance: { score, version: '1' } } : candidate,
  );
};

const candidatesFor = (resource: Resource) =>
  Effect.gen(function* candidates() {
    const high = yield* hitFor(resource, '1', 'Západní park', 900);
    const hidden = yield* hitFor(resource, '2', 'Malý park', 500);
    const low = yield* hitFor(resource, '3', 'Areál parku', 100);
    return {
      hidden,
      hits: [hidden, low, high],
      ordered: resource === 'asset' ? [high, hidden, low] : [low, hidden, high],
    };
  });

const rowFor = (hit: CoreSearchProjectionHit) => {
  const row = { ref: hit.ref, selectedLegalEntityId: hit.selectedLegalEntityId, title: hit.title };
  return hit.relevance === undefined ? row : { ...row, relevance: hit.relevance };
};

const decisionsFor = (input: Parameters<ResourceCheck>[0]) =>
  input.resources.map((ref) => ({
    decision: ref.resourceId.endsWith('2') ? ('denied' as const) : ('allowed' as const),
    key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
  }));

const testProvider = (
  resource: Resource,
  hits: readonly CoreSearchProjectionHit[],
  options: {
    readonly check?: ResourceCheck;
    readonly moduleDecision?: ContextAccessDecision;
    readonly ownerDecision?: ContextAccessDecision;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* providerScenario() {
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const crypto = Context.get(cryptoServices, Crypto.Crypto);
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.succeed([]),
        operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-01T09:00:00.000Z')),
        ownerAuthorizationDecision: options.ownerDecision ?? 'allowed',
        permissionDecision: 'allowed',
        scope,
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const services = yield* Layer.build(harness.layer);
      const access = Context.get(services, ContextAccess);
      const checked: Parameters<ResourceCheck>[0][] = [];
      const resourceCheck = rs.spyOn(access, 'resources').mockImplementation((input) => {
        checked.push(input);
        return options.check === undefined ? Effect.succeed(decisionsFor(input)) : options.check(input);
      });
      const moduleCheck = rs
        .spyOn(access, 'modules')
        .mockImplementation(({ moduleIds }) =>
          Effect.succeed(moduleIds.map((key) => ({ decision: options.moduleDecision ?? 'allowed', key }))),
        );
      let searchCalls = 0;
      const exit = yield* runProvider(resource, harness.runtime).pipe(
        Effect.provideService(CoreSearchQueryRuntime, {
          search: () => {
            searchCalls += 1;
            return Effect.succeed(hits);
          },
        }),
        Effect.exit,
        Effect.ensuring(
          Effect.sync(() => {
            resourceCheck.mockRestore();
            moduleCheck.mockRestore();
          }),
        ),
      );
      return { checked, exit, searchCalls, snapshot: harness.snapshot() };
    }),
  );

const failureFor = <Value, Failure>(exit: Exit.Exit<Value, Failure>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

for (const resource of ['property', 'unit', 'asset'] as const) {
  it.effect(
    `${resource} collections retain all readable rows from mixed candidates and check every candidate once`,
    () =>
      Effect.gen(function* mixedCandidates() {
        const { hidden, hits, ordered } = yield* candidatesFor(resource);
        const outcome = yield* testProvider(resource, hits);
        expect(outcome.exit).toEqual(Exit.succeed(ordered.filter((hit) => hit !== hidden).map(rowFor)));
        expect(outcome.checked).toEqual([
          {
            legalEntityId: scope.legalEntityId,
            permission: 'read',
            principalId: scope.principalId,
            resources: ordered.map(({ ref }) => ({
              moduleId: ref.moduleId,
              resourceId: ref.resourceId,
              resourceType: ref.resourceType,
            })),
            tenantId: scope.tenantId,
          },
        ]);
        expect(outcome.searchCalls).toBe(1);
        expect(outcome.snapshot.evidenceWrites).toBe(1);
        expect(outcome.snapshot.stages).toContain('evidence_persisted');
        expect(outcome.snapshot.ownerQueries).toEqual([]);
      }),
  );

  it.effect(`${resource} admitted hidden-only and nonexistent matches have the same successful empty result`, () =>
    Effect.gen(function* hiddenAndNonexistent() {
      const { hidden } = yield* candidatesFor(resource);
      const denied = yield* testProvider(resource, [hidden]);
      const empty = yield* testProvider(resource, []);
      expect(denied.exit).toEqual(Exit.succeed([]));
      expect(empty.exit).toEqual(denied.exit);
      expect(denied.checked).toHaveLength(1);
      expect(empty.checked).toEqual([]);
      expect(denied.searchCalls).toBe(1);
      expect(empty.searchCalls).toBe(1);
      expect(denied.snapshot.evidenceWrites).toBe(1);
      expect(empty.snapshot.evidenceWrites).toBe(1);
      expect(denied.snapshot.stages).toEqual(empty.snapshot.stages);
    }),
  );

  it.effect(`${resource} collections keep all allowed rows in owner order`, () =>
    Effect.gen(function* allowedCandidates() {
      const { hits, ordered } = yield* candidatesFor(resource);
      const outcome = yield* testProvider(resource, hits, {
        check: (input) =>
          Effect.succeed(decisionsFor(input).map((decision) => ({ ...decision, decision: 'allowed' as const }))),
      });
      expect(outcome.exit).toEqual(Exit.succeed(ordered.map(rowFor)));
      expect(outcome.checked).toHaveLength(1);
    }),
  );

  it.effect(`${resource} keyed decisions may arrive out of order without reordering readable results`, () =>
    Effect.gen(function* reversedDecisions() {
      const { hidden, hits, ordered } = yield* candidatesFor(resource);
      const outcome = yield* testProvider(resource, hits, {
        check: (input) => Effect.succeed(decisionsFor(input).toReversed()),
      });
      expect(outcome.exit).toEqual(Exit.succeed(ordered.filter((hit) => hit !== hidden).map(rowFor)));
      expect(outcome.checked).toHaveLength(1);
    }),
  );

  for (const malformed of [
    'missing',
    'duplicate',
    'foreign',
    'extra',
    'extra-field',
    'unknown',
    'unavailable',
  ] as const) {
    it.effect(`${resource} collections fail closed for ${malformed} resource decisions`, () =>
      Effect.gen(function* malformedDecisions() {
        const { hits } = yield* candidatesFor(resource);
        const outcome = yield* testProvider(resource, hits, {
          check: (input) => {
            const decisions = decisionsFor(input);
            const [first] = decisions;
            if (first !== undefined) {
              if (malformed === 'missing') {
                decisions.pop();
              } else if (malformed === 'duplicate') {
                decisions[1] = first;
              } else if (malformed === 'foreign') {
                decisions[0] = { ...first, key: 'foreign:resource:id' };
              } else if (malformed === 'extra') {
                decisions.push({ decision: 'allowed', key: 'foreign:resource:id' });
              } else if (malformed === 'extra-field') {
                Reflect.set(first, 'caveat', true);
              } else {
                Reflect.set(first, 'decision', malformed === 'unknown' ? 'conditional' : 'unavailable');
              }
            }
            return Effect.succeed(decisions);
          },
        });
        expect(Schema.is(ReadPermissionUnavailable)(failureFor(outcome.exit))).toBe(true);
        expect(outcome.checked).toHaveLength(1);
        expect(outcome.snapshot.evidenceWrites).toBe(0);
        expect(outcome.snapshot.stages).not.toContain('evidence_persisted');
      }),
    );
  }

  it.effect(`${resource} collections do not release results when resource authorization defects`, () =>
    Effect.gen(function* authorizationDefect() {
      const { hits } = yield* candidatesFor(resource);
      const outcome = yield* testProvider(resource, hits, {
        check: () => Effect.die('Resource authorization transport failed'),
      });
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      if (Exit.isFailure(outcome.exit)) {
        expect(outcome.exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
      }
      expect(outcome.checked).toHaveLength(1);
      expect(outcome.snapshot.evidenceWrites).toBe(0);
      expect(outcome.snapshot.stages).not.toContain('evidence_persisted');
    }),
  );

  for (const gate of ['module', 'owner'] as const) {
    for (const decision of ['denied', 'unavailable'] as const) {
      it.effect(
        `${resource} collections preserve ${gate} admission ${decision} instead of returning empty success`,
        () =>
          Effect.gen(function* admissionFailure() {
            const { hits } = yield* candidatesFor(resource);
            const outcome = yield* testProvider(
              resource,
              hits,
              gate === 'module' ? { moduleDecision: decision } : { ownerDecision: decision },
            );
            expect(
              decision === 'denied'
                ? outcome.exit.pipe(failureFor, Schema.is(ReadPermissionDenied))
                : outcome.exit.pipe(failureFor, Schema.is(ReadPermissionUnavailable)),
            ).toBe(true);
            expect(outcome.checked).toEqual([]);
            if (gate === 'module') {
              expect(outcome.searchCalls).toBe(0);
            }
            expect(outcome.snapshot.evidenceWrites).toBe(decision === 'denied' ? 1 : 0);
            expect(outcome.snapshot.stages).not.toContain('evidence_persisted');
          }),
      );
    }
  }
}
