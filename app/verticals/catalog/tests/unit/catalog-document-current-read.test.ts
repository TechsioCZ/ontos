import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  CallForbiddenSchema,
  CallNotFoundSchema,
  CallRejectedSchema,
  CallUnavailableSchema,
  RequestExecutionSchema,
  callOkSchema,
} from '@app/core-runtime/sdk';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { coreOperations } from '@app/core-runtime/sdk/core';
import { makeExecutionStandIn } from '@app/core-runtime/testing/sdk';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { catalogDocumentCurrentCalls, runCatalogDocumentCurrent } from '../../src/api/catalog-document-current.read.ts';
import type { CatalogDocumentCurrentRunContext } from '../../src/api/catalog-document-current.read.ts';
import type { catalogMediaAssignments } from '../../src/database/schema.ts';
import { catalogMediaAssignmentSets, products } from '../../src/database/schema.ts';
import { CatalogDocumentCurrentRequestSchema } from '../../shared/apis/catalog-document-current.ts';
import type { CatalogDocumentCurrentRequest } from '../../shared/apis/catalog-document-current.ts';
import { catalogDocumentReadsForScope } from '../../src/persistence/catalog-document-reads.ts';
import type { CatalogDocumentReads } from '../../src/persistence/catalog-document-reads.ts';

/*
 * The production binding of Catalog's owner-evidence port to Core Media's Current V1 (#1443, ADR-0031): what the read
 * asks Core, with no transaction open, and what it never lets through. Core's own answers (stat, tenant, authorization)
 * are proven in core-runtime against real PostgreSQL, SpiceDB and an S3-compatible emulator; here the owner is the
 * SDK stand-in, so every state Core can answer is reachable and every wrong answer is a controlled one.
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const assetA = '33333333-3333-4333-8333-33333333333a';
const assetB = '33333333-3333-4333-8333-33333333333b';
const at = '2026-11-20T00:00:00.000Z';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'session:catalog-document-current',
  authMethod: 'session',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
});
const scope: OperationalScope = { ...principal, correlationId: 'catalog-document-current-read' };
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const target0 = Schema.decodeUnknownSync(CatalogDocumentCurrentRequestSchema)({ target: productRef }).target;
const mediaRef = (resourceId: string) =>
  ({ moduleId: 'core.media', resourceId, resourceType: 'core.media.asset', tenantId }) as const;

const assignmentRow = (
  assignmentId: string,
  ownerResourceId: string,
  position: number,
  ownerModuleId = 'core.media',
) => ({
  assignmentId,
  assignmentSetId: '55555555-5555-4555-8555-555555555555',
  currentRevision: 1,
  ownerModuleId,
  ownerResourceId,
  ownerResourceType: ownerModuleId === 'core.media' ? 'core.media.asset' : `${ownerModuleId}.resource`,
  ownerTenantId: tenantId,
  position,
  purpose: 'brochure',
  resourceKind: 'DOCUMENT',
  state: 'ACTIVE',
  tenantId,
});
const setRow = (currentRevision: number) => ({
  assignmentSetId: '55555555-5555-4555-8555-555555555555',
  currentRevision,
  productId,
  tenantId,
  variantId: null,
});
const A = assignmentRow('66666666-6666-4666-8666-666666666661', assetA, 1);
const B = assignmentRow('66666666-6666-4666-8666-666666666662', assetB, 1);

interface Snapshot {
  readonly assignments: readonly (typeof A)[];
  readonly revision: number;
}
type Table = typeof products | typeof catalogMediaAssignmentSets | typeof catalogMediaAssignments;
const mock = (snapshot: Snapshot) => ({
  select: () => ({
    from: (table: Table) => ({
      where: () => {
        if (table === products) {
          return Effect.succeed([{ productId }]);
        }
        if (table === catalogMediaAssignmentSets) {
          // Revision 0 is a target that never had an assignment set.
          return Effect.succeed(snapshot.revision === 0 ? [] : [setRow(snapshot.revision)]);
        }
        return Effect.succeed(snapshot.assignments);
      },
    }),
  }),
});

type CoreAnswer = typeof coreOperations.assetCurrent.response.Type;
const answered = (value: CoreAnswer): CallOutcome<CoreAnswer> =>
  callOkSchema(coreOperations.assetCurrent.response).make({ value });
const entryOf = (resourceId: string, kind: 'ABSENT' | 'AVAILABLE' | 'CURRENT_UNVERIFIED' | 'UNAVAILABLE') =>
  kind === 'AVAILABLE'
    ? { current: { resourceRef: mediaRef(resourceId), revision: 1 as const }, kind, resourceRef: mediaRef(resourceId) }
    : { kind, resourceRef: mediaRef(resourceId) };

const kindsOf = (result: { readonly assignments: readonly { readonly kind: string }[] }) =>
  result.assignments.map(({ kind }) => kind);

/** Catalog's own reads, noting what the projection said per assignment, also when the public read then refuses it. */
const recording = (reads: CatalogDocumentReads, projections: (readonly string[])[]): CatalogDocumentReads => ({
  current: (target, ownerAnswers) =>
    reads.current(target, ownerAnswers).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          projections.push(Option.isSome(result) ? kindsOf(result.value) : []);
        }),
      ),
    ),
});

/** Drives the read's `run` with Core's stand-ins, which die on a call while a transaction is open. */
const harness = (input: {
  readonly core: (refs: readonly { readonly resourceId: string }[]) => CallOutcome<CoreAnswer>;
  /** The Catalog snapshot each transaction sees, by its sequence (1, 2, ...); the last one repeats. */
  readonly snapshots: readonly Snapshot[];
}) => {
  const projections: (readonly string[])[] = [];
  const standIn = makeExecutionStandIn(catalogDocumentCurrentCalls, {
    answers: { ownerCurrent: (payload) => Effect.succeed(input.core(payload.mediaAssetRefs)) },
    operationAt: DateTime.makeUnsafe(at),
    services: (sequence) =>
      recording(
        // @ts-expect-error Mock implements only exercised query chains.
        catalogDocumentReadsForScope(mock(input.snapshots[sequence - 1] ?? input.snapshots.at(-1)), scope),
        projections,
      ),
  });
  const context: CatalogDocumentCurrentRunContext = {
    access: {},
    call: standIn.call,
    execution: {
      compositionRevision: 'composition-revision-1',
      identity: RequestExecutionSchema.make({ via: 'person' }),
      operationKey: 'commerce.catalog.api.catalog-document-current',
      owningModuleKey: 'commerce.catalog',
    },
    readKey: 'commerce.catalog.api.catalog-document-current',
    scope,
    transaction: standIn.transaction,
  };
  return {
    projections,
    run: (target: CatalogDocumentCurrentRequest['target'] = target0) => runCatalogDocumentCurrent({ target }, context),
    steps: () =>
      standIn.steps.map((step) => (step.kind === 'call' ? { input: step.input, name: step.name } : step.kind)),
  };
};

const allAvailable = (refs: readonly { readonly resourceId: string }[]) =>
  answered({ entries: refs.map(({ resourceId }) => entryOf(resourceId, 'AVAILABLE')) });

describe('Catalog document Current bound to Core Media', () => {
  it.effect(
    'asks Core for the exact assigned refs with no transaction open and answers AVAILABLE with revision 1',
    () =>
      Effect.gen(function* available() {
        const fixture = harness({ core: allAvailable, snapshots: [{ assignments: [A], revision: 3 }] });
        const answer = yield* fixture.run();
        expect(kindsOf(answer.result)).toEqual(['AVAILABLE']);
        const [use] = answer.result.assignments;
        expect(use).toMatchObject({ current: { resourceRef: mediaRef(assetA), revision: 1 }, kind: 'AVAILABLE' });
        // The owner issued revision 1 and nothing else: no revisionId, no provider value, no pinned version.
        expect(use?.kind === 'AVAILABLE' ? Object.keys(use.current) : []).toEqual(['resourceRef', 'revision']);
        expect(answer.result.setRevision).toBe(3);
        expect(answer.evidence).toEqual({ resultCount: 1 });
        expect(fixture.steps()).toEqual([
          'begin',
          'end',
          { input: { mediaAssetRefs: [mediaRef(assetA)] }, name: 'ownerCurrent' },
          'begin',
          'end',
        ]);
      }),
  );

  it.effect('keeps every non-AVAILABLE owner state as itself and never promotes one to AVAILABLE', () =>
    Effect.gen(function* states() {
      for (const kind of ['ABSENT', 'CURRENT_UNVERIFIED', 'UNAVAILABLE'] as const) {
        const answer = yield* harness({
          core: (refs) => answered({ entries: refs.map(({ resourceId }) => entryOf(resourceId, kind)) }),
          snapshots: [{ assignments: [A], revision: 1 }],
        }).run();
        expect(kindsOf(answer.result)).toEqual([kind]);
        expect(answer.result.assignments[0]).not.toHaveProperty('current');
      }
    }),
  );

  it.effect('reports FORBIDDEN for every ref when the requester may not ask Core, never ABSENT or AVAILABLE', () =>
    Effect.gen(function* forbidden() {
      const two = { assignments: [A, { ...B, position: 2 }], revision: 1 };
      const answer = yield* harness({
        core: () => CallForbiddenSchema.make({ reason: 'denied' }),
        snapshots: [two],
      }).run();
      expect(kindsOf(answer.result)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    }),
  );

  it.effect('fails the whole read safely when Core is absent, rejected or unavailable: nothing is promoted', () =>
    Effect.gen(function* failures() {
      for (const outcome of [
        CallNotFoundSchema.make({ reason: 'absent' }),
        CallRejectedSchema.make({ code: 'conflict', reason: 'rejected' }),
        CallUnavailableSchema.make({ reason: 'down', retryable: true }),
      ]) {
        const failure = yield* Effect.flip(
          harness({ core: () => outcome, snapshots: [{ assignments: [A], revision: 1 }] }).run(),
        );
        expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
      }
    }),
  );

  const assetC = '33333333-3333-4333-8333-33333333333c';
  const twoAssets = { assignments: [A, { ...B, position: 2 }], revision: 1 };
  const coreAnswers = (entries: CoreAnswer['entries']) =>
    harness({ core: () => answered({ entries }), snapshots: [twoAssets] });

  it.effect('reports RESOURCE_MISMATCH for the entry that answers another ref, and keeps the exact one', () =>
    Effect.gen(function* mismatch() {
      const otherTenant = { ...mediaRef(assetB), tenantId: '99999999-9999-4999-8999-999999999999' };
      for (const wrong of [
        entryOf(assetC, 'AVAILABLE'),
        entryOf(assetC, 'ABSENT'),
        // Asset A again where B was asked: the exact proof of A is never a proof for B.
        entryOf(assetA, 'AVAILABLE'),
        {
          current: { resourceRef: otherTenant, revision: 1 as const },
          kind: 'AVAILABLE' as const,
          resourceRef: otherTenant,
        },
      ]) {
        const answer = yield* coreAnswers([entryOf(assetA, 'AVAILABLE'), wrong]).run();
        expect(kindsOf(answer.result)).toEqual(['AVAILABLE', 'RESOURCE_MISMATCH']);
        // Nothing of the other Resource reaches the caller: only the assignment Catalog owns, and its kind.
        expect(Object.keys(answer.result.assignments[1] ?? {})).toEqual(['assignment', 'kind']);
        expect(answer.result.assignments[1]?.assignment.resourceRef).toEqual(mediaRef(assetB));
      }
    }),
  );

  it.effect('never re-pairs swapped entries by identity: both assignments are mismatched, neither is AVAILABLE', () =>
    Effect.gen(function* swapped() {
      const answer = yield* coreAnswers([entryOf(assetB, 'AVAILABLE'), entryOf(assetA, 'AVAILABLE')]).run();
      expect(kindsOf(answer.result)).toEqual(['RESOURCE_MISMATCH', 'RESOURCE_MISMATCH']);
    }),
  );

  it.effect('keeps the assignment with no proof OWNER_CHECK_REQUIRED, which the public response cannot carry', () =>
    Effect.gen(function* missingProof() {
      for (const [entries, projected] of [
        [[entryOf(assetA, 'AVAILABLE')], ['AVAILABLE', 'OWNER_CHECK_REQUIRED']],
        [[], ['OWNER_CHECK_REQUIRED', 'OWNER_CHECK_REQUIRED']],
        // The first entry was dropped: B's proof sits where A was asked, so it proves neither.
        [[entryOf(assetB, 'AVAILABLE')], ['RESOURCE_MISMATCH', 'OWNER_CHECK_REQUIRED']],
      ] as const) {
        const fixture = coreAnswers([...entries]);
        const failure = yield* Effect.flip(fixture.run());
        expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
        expect(fixture.projections.at(-1)).toEqual(projected);
      }
    }),
  );

  it.effect('fails the whole read for an answer with entries nobody asked for', () =>
    Effect.gen(function* surplus() {
      const fixture = coreAnswers([
        entryOf(assetA, 'AVAILABLE'),
        entryOf(assetB, 'AVAILABLE'),
        entryOf(assetB, 'AVAILABLE'),
      ]);
      expect(Predicate.isTagged(yield* Effect.flip(fixture.run()), 'ReadHandlerUnavailable')).toBe(true);
    }),
  );

  it.effect('asks once for a Resource assigned twice, so one answer judges both assignments', () =>
    Effect.gen(function* assignedTwice() {
      const again = { ...assignmentRow('66666666-6666-4666-8666-666666666664', assetA, 2), purpose: 'manual' };
      for (const [entry, kind] of [
        [entryOf(assetA, 'AVAILABLE'), 'AVAILABLE'],
        [entryOf(assetC, 'AVAILABLE'), 'RESOURCE_MISMATCH'],
      ] as const) {
        const fixture = harness({
          core: () => answered({ entries: [entry] }),
          snapshots: [{ assignments: [A, again], revision: 1 }],
        });
        expect(kindsOf((yield* fixture.run()).result)).toEqual([kind, kind]);
        expect(fixture.steps()[2]).toEqual({ input: { mediaAssetRefs: [mediaRef(assetA)] }, name: 'ownerCurrent' });
      }
    }),
  );

  it.effect('never asks Core about a Resource another owner owns, and then fails safe instead of resolving it', () =>
    Effect.gen(function* foreignOwner() {
      const other = { ...assignmentRow('66666666-6666-4666-8666-666666666663', assetA, 1, 'documents.center') };
      const fixture = harness({ core: allAvailable, snapshots: [{ assignments: [other], revision: 1 }] });
      const failure = yield* Effect.flip(fixture.run());
      // Catalog's own logic keeps it OWNER_CHECK_REQUIRED, which the public response cannot carry: a safe 503.
      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
      expect(fixture.steps()).toEqual(['begin', 'end', 'begin', 'end']);
    }),
  );

  it.effect('keeps a new upload out of the assignment and an explicit reassignment bound to the new asset only', () =>
    Effect.gen(function* reassignment() {
      // Asset B was uploaded, but Catalog still assigns A: Core is asked about A alone, and B never appears.
      const beforeReassign = harness({ core: allAvailable, snapshots: [{ assignments: [A], revision: 1 }] });
      const first = yield* beforeReassign.run();
      expect(kindsOf(first.result)).toEqual(['AVAILABLE']);
      expect(first.result.assignments[0]?.assignment.resourceRef.resourceId).toBe(assetA);
      expect(beforeReassign.steps()[2]).toEqual({
        input: { mediaAssetRefs: [mediaRef(assetA)] },
        name: 'ownerCurrent',
      });

      // After an explicit Catalog reassignment to B: A is no longer asked, no fallback carries A's AVAILABLE over to B.
      const afterReassign = harness({
        core: (refs) =>
          answered({
            entries: refs.map(({ resourceId }) =>
              entryOf(resourceId, resourceId === assetB ? 'CURRENT_UNVERIFIED' : 'AVAILABLE'),
            ),
          }),
        snapshots: [{ assignments: [B], revision: 2 }],
      });
      const second = yield* afterReassign.run();
      expect(kindsOf(second.result)).toEqual(['CURRENT_UNVERIFIED']);
      expect(second.result.assignments[0]?.assignment.resourceRef.resourceId).toBe(assetB);
      expect(afterReassign.steps()[2]).toEqual({ input: { mediaAssetRefs: [mediaRef(assetB)] }, name: 'ownerCurrent' });
    }),
  );

  it.effect('is unavailable when the assignment set changed while the owner answered', () =>
    Effect.gen(function* superseded() {
      const fixture = harness({
        core: allAvailable,
        snapshots: [
          { assignments: [A], revision: 1 },
          { assignments: [B], revision: 2 },
        ],
      });
      expect(Predicate.isTagged(yield* Effect.flip(fixture.run()), 'ReadHandlerUnavailable')).toBe(true);
    }),
  );

  it.effect('makes no owner call for a foreign tenant, an empty set or an absent target', () =>
    Effect.gen(function* noCall() {
      const foreign = harness({ core: allAvailable, snapshots: [{ assignments: [A], revision: 1 }] });
      const foreignTarget = Schema.decodeUnknownSync(CatalogDocumentCurrentRequestSchema)({
        target: { ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      }).target;
      const failure = yield* Effect.flip(foreign.run(foreignTarget));
      expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
      expect(foreign.steps()).toEqual([]);
      const empty = harness({ core: allAvailable, snapshots: [{ assignments: [], revision: 0 }] });
      const answer = yield* empty.run();
      expect(answer.result).toEqual({ assignments: [], setRevision: 0 });
      expect(empty.steps()).toEqual(['begin', 'end']);
    }),
  );
});
