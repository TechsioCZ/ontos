import {
  ContextAccess,
  CoreSearchProjectionHitSchema,
  CoreSearchQueryRuntime,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
} from '@app/core-runtime';
import type { ContextAccessDecision, ResourceAccessTarget } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { Array as EffectArray, Cause, Context, Crypto, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { assetsRead } from '../../src/search/assets.provider.ts';
import { devicesRead } from '../../src/search/devices.provider.ts';
import { documentsRead } from '../../src/search/documents.provider.ts';
import { metersRead } from '../../src/search/meters.provider.ts';
import { buildFacilitySearchDocuments } from '../../src/services/facility-search-projection.ts';
import { company, otherCompany, scope, snapshot, tenantId } from './facility-search-fixtures.ts';

const FacilityResourceSchema = Schema.Literals(['asset', 'device', 'document', 'meter']);
type FacilityResource = typeof FacilityResourceSchema.Type;
const resourceKey = (ref: ResourceAccessTarget) => `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`;
const permit = (refs: readonly ResourceAccessTarget[]) =>
  refs.map((ref) => ({ decision: 'allowed', key: resourceKey(ref) }));
const deny = (refs: readonly ResourceAccessTarget[]) =>
  refs.map((ref) => ({ decision: 'denied', key: resourceKey(ref) }));

interface ScenarioOptions {
  readonly agendaDecision?: ContextAccessDecision;
  readonly candidateCount?: number;
  readonly decisions?: (refs: readonly ResourceAccessTarget[]) => readonly unknown[];
  readonly foreignCompany?: boolean;
  readonly moduleDecision?: ContextAccessDecision;
}

const runScenario = (resource: FacilityResource, options: ScenarioOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* facilityCollectionScenario() {
      const documents = yield* buildFacilitySearchDocuments({
        ...snapshot,
        rows: Array.from({ length: options.candidateCount ?? 3 }, (_, index) => ({
          archived: false,
          id: `${resource}-${index}`,
          legalEntityId: company,
          tenantId,
          text: [`Záznam ${index}`],
          title: `Záznam ${index}`,
          type: resource,
        })),
      });
      const hits = yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionHitSchema))(
        documents.map((document) => ({
          ...document,
          relevance: { score: 1000, version: '1' },
          selectedLegalEntityId: options.foreignCompany === true ? otherCompany : company,
        })),
      );
      const cryptoServices = yield* Layer.build(NodeCrypto.layer);
      const harness = yield* makeReadTestHarness({
        executeOwnerQuery: () => Effect.die('Facility collection reads must not execute direct owner SQL'),
        operationTime: new Date('2026-11-04T09:00:00Z'),
        ownerAuthorizationDecision: 'allowed',
        permissionDecision: 'allowed',
        scope,
      }).pipe(Effect.provideService(Crypto.Crypto, Context.get(cryptoServices, Crypto.Crypto)));
      const checked: ResourceAccessTarget[] = [];
      const agendaTargets: unknown[] = [];
      const moduleTargets: string[] = [];
      let searched = false;
      let resourceChecks = 0;
      Object.assign(Context.get(yield* Layer.build(harness.layer), ContextAccess), {
        contextPermissions: ({
          targets,
        }: {
          readonly targets: readonly { readonly moduleId: string; readonly permission: string }[];
        }) => {
          agendaTargets.push(...targets);
          return Effect.succeed(
            targets.map((target) => ({
              decision: options.agendaDecision ?? 'allowed',
              key: `${target.moduleId}:${target.permission}`,
            })),
          );
        },
        modules: ({ moduleIds }: { readonly moduleIds: readonly string[] }) => {
          moduleTargets.push(...moduleIds);
          return Effect.succeed(moduleIds.map((key) => ({ decision: options.moduleDecision ?? 'allowed', key })));
        },
        resources: ({ resources }: { readonly resources: readonly ResourceAccessTarget[] }) =>
          Effect.sync(() => {
            expect(searched).toBe(true);
            resourceChecks += 1;
            checked.push(...resources);
            return (options.decisions ?? permit)(resources);
          }),
      });
      const request = {
        input: { query: 'zaznam' },
        principal: scope,
        transport: { correlationId: scope.correlationId },
      };
      // Keep each owner's concrete registration type rather than weakening the Read test seam.
      const read = Effect.gen(function* executeFacilityRead() {
        if (resource === 'asset') {
          return yield* harness.runtime.runRead({ ...request, registration: assetsRead });
        }
        if (resource === 'device') {
          return yield* harness.runtime.runRead({ ...request, registration: devicesRead });
        }
        if (resource === 'document') {
          return yield* harness.runtime.runRead({ ...request, registration: documentsRead });
        }
        return yield* harness.runtime.runRead({ ...request, registration: metersRead });
      });
      const exit = yield* Effect.exit(
        read.pipe(
          Effect.provideService(CoreSearchQueryRuntime, {
            search: () =>
              Effect.sync(() => {
                searched = true;
                return hits;
              }),
          }),
        ),
      );
      return {
        agendaTargets,
        checked,
        exit,
        hits,
        moduleTargets,
        resourceChecks,
        searched,
        snapshot: harness.snapshot(),
      };
    }),
  );

for (const resource of ['asset', 'device', 'document', 'meter'] as const) {
  it.effect(`${resource}: filters a denied first candidate without losing later permitted rows or relevance`, () =>
    Effect.gen(function* mixedResults() {
      const outcome = yield* runScenario(resource, {
        decisions: (refs) =>
          EffectArray.reverse(
            refs.map((ref, index) => ({ decision: index === 0 ? 'denied' : 'allowed', key: resourceKey(ref) })),
          ),
      });
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      if (Exit.isSuccess(outcome.exit)) {
        expect(outcome.exit.value).toEqual(
          outcome.hits.slice(1).map(({ ref, relevance, selectedLegalEntityId, title }) => ({
            ref,
            relevance,
            selectedLegalEntityId,
            title,
          })),
        );
      }
      expect(outcome.checked.map(resourceKey)).toEqual(outcome.hits.map(({ ref }) => resourceKey(ref)));
      expect(outcome.resourceChecks).toBe(1);
      expect(outcome.snapshot.evidenceWrites).toBe(1);
      expect(outcome.snapshot.ownerQueries).toEqual([]);
    }),
  );

  it.effect(`${resource}: hidden-only and nonexistent matches return the same admitted empty success`, () =>
    Effect.gen(function* indistinguishableEmpty() {
      const hidden = yield* runScenario(resource, { decisions: deny });
      const missing = yield* runScenario(resource, { candidateCount: 0 });
      expect(hidden.exit).toEqual(Exit.succeed([]));
      expect(missing.exit).toEqual(hidden.exit);
      expect(hidden.searched).toBe(true);
      expect(missing.searched).toBe(true);
      expect(hidden.resourceChecks).toBe(1);
      expect(missing.resourceChecks).toBe(0);
      expect(hidden.snapshot.evidenceWrites).toBe(1);
      expect(missing.snapshot.evidenceWrites).toBe(1);
    }),
  );

  it.effect(`${resource}: preserves the full ordered result rather than imposing a candidate or output limit`, () =>
    Effect.gen(function* fullResults() {
      const outcome = yield* runScenario(resource, { candidateCount: 201 });
      expect(Exit.isSuccess(outcome.exit)).toBe(true);
      if (Exit.isSuccess(outcome.exit)) {
        expect(outcome.exit.value.map(({ ref }) => resourceKey(ref))).toEqual(
          outcome.hits.map(({ ref }) => resourceKey(ref)),
        );
        expect(outcome.exit.value.length).toBe(201);
      }
      expect(outcome.checked.length).toBe(201);
    }),
  );

  it.effect(`${resource}: unavailable, missing, duplicate, foreign and malformed decisions fail closed`, () =>
    Effect.gen(function* uncertainAuthorization() {
      const invalidDecisions: readonly NonNullable<ScenarioOptions['decisions']>[] = [
        (refs) => refs.map((ref) => ({ decision: 'unavailable', key: resourceKey(ref) })),
        (refs) =>
          permit(refs).map((decision, index) => (index === 0 ? { ...decision, decision: 'unavailable' } : decision)),
        (refs) => permit(refs).slice(1),
        (refs) => [...permit(refs), ...permit(refs).slice(0, 1)],
        (refs) => permit(refs).map((decision, _index, decisions) => decisions[0] ?? decision),
        (refs) => permit(refs).map((decision, index) => (index === 0 ? { ...decision, key: 'foreign' } : decision)),
        (refs) => refs.map((ref) => ({ decision: 'conditional', key: resourceKey(ref) })),
        (refs) => permit(refs).map((decision) => ({ ...decision, candidateCount: 3 })),
      ];
      for (const decisions of invalidDecisions) {
        const outcome = yield* runScenario(resource, { decisions });
        expect(Exit.isFailure(outcome.exit)).toBe(true);
        if (Exit.isFailure(outcome.exit)) {
          expect(
            Schema.is(ReadPermissionUnavailable)(Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))),
          ).toBe(true);
        }
        expect(outcome.snapshot.evidenceWrites).toBe(0);
      }
    }),
  );

  it.effect(`${resource}: retains canonical read_all and module admission before querying or resource checks`, () =>
    Effect.gen(function* admissionUnchanged() {
      for (const decision of ['allowed', 'denied', 'unavailable'] as const) {
        const outcome = yield* runScenario(resource, { agendaDecision: decision });
        expect(outcome.agendaTargets).toEqual([
          { moduleId: 'facility.operations', permission: 'facility.operations.read_all' },
        ]);
        expect(outcome.searched).toBe(decision === 'allowed');
        expect(outcome.checked.length).toBe(decision === 'allowed' ? 3 : 0);
        expect(Exit.isSuccess(outcome.exit)).toBe(decision === 'allowed');
        if (Exit.isFailure(outcome.exit)) {
          const failure = Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause));
          expect(
            decision === 'denied'
              ? Schema.is(ReadPermissionDenied)(failure)
              : Schema.is(ReadPermissionUnavailable)(failure),
          ).toBe(true);
        }
      }
      const moduleDenied = yield* runScenario(resource, { moduleDecision: 'denied' });
      expect(Exit.isFailure(moduleDenied.exit)).toBe(true);
      expect(moduleDenied.moduleTargets).toEqual(['facility.operations']);
      expect(moduleDenied.searched).toBe(false);
      expect(moduleDenied.checked).toEqual([]);
    }),
  );

  it.effect(`${resource}: does not hide invalid owner source scope behind a denied resource decision`, () =>
    Effect.gen(function* sourceVerificationUnchanged() {
      const outcome = yield* runScenario(resource, { decisions: deny, foreignCompany: true });
      expect(Exit.isFailure(outcome.exit)).toBe(true);
      if (Exit.isFailure(outcome.exit)) {
        expect(
          Schema.is(ReadHandlerUnavailable)(Option.getOrUndefined(Cause.findErrorOption(outcome.exit.cause))),
        ).toBe(true);
      }
      expect(outcome.searched).toBe(true);
      expect(outcome.checked).toEqual([]);
      expect(outcome.snapshot.evidenceWrites).toBe(0);
    }),
  );
}
