import { v1 } from '@authzed/authzed-node';
import { Effect, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { capabilityObjectId } from '../../src/access/compiler/object-id.ts';
import { planAccessProjection } from '../../src/access/compiler/plan.ts';
import type { AccessRelationship } from '../../src/access/compiler/relationship.ts';
import { makeAccessProjectionCompiler } from '../../src/access/compiler/spice-db-compiler.ts';
import type { AccessProjectionTransport } from '../../src/access/compiler/spice-db-compiler.ts';
import { toSpiceDbRelationship } from '../../src/access/compiler/spicedb-relationship.ts';
import { CAP_NOTE, CAP_PAY, SCOPE, TENANT, cell, projectionIntent, revision } from './access-compiler-fixtures.ts';

/*
 * Reads never wait on the tenant's fence, so they can observe a projection half-written. A projection therefore sends
 * every revocation before any grant: a reader may briefly be denied a right being granted, but never sees a revoked
 * right still standing beside a new one.
 */
const relationshipsOf = (intent: ReturnType<typeof projectionIntent>): readonly AccessRelationship[] => {
  const planned = planAccessProjection(intent);
  return Result.isSuccess(planned) ? planned.success.units.flatMap((unit) => unit.relationships) : [];
};

/** An engine holding `current`, answering each read with the tuples its filter names, recording every write. */
const engineHolding = (
  current: readonly AccessRelationship[],
  written: v1.RelationshipUpdate_Operation[][],
): AccessProjectionTransport => ({
  close: () => {},
  readRelationships: (request) =>
    Effect.succeed(
      current
        .filter(
          (relationship) =>
            relationship.resourceType === request.relationshipFilter?.resourceType &&
            relationship.relation === request.relationshipFilter.optionalRelation,
        )
        .map((relationship) =>
          v1.ReadRelationshipsResponse.create({ relationship: toSpiceDbRelationship(relationship) }),
        ),
    ),
  writeRelationships: (request) =>
    Effect.sync(() => {
      written.push(request.updates.map((update) => update.operation));
      return v1.WriteRelationshipsResponse.create({});
    }),
});

it.effect('sends every revocation before any grant, in one atomic request when the difference fits', () =>
  Effect.gen(function* revocationsFirst() {
    const stale: AccessRelationship = {
      relation: 'run_all_grant',
      resourceId: capabilityObjectId(TENANT, SCOPE, CAP_NOTE),
      resourceType: 'access_capability',
      subject: { objectId: 'gr_stale', objectType: 'access_grant' },
    };
    const written: v1.RelationshipUpdate_Operation[][] = [];
    const compiler = makeAccessProjectionCompiler(
      engineHolding([...relationshipsOf(projectionIntent()), stale], written),
    );
    // The role gains a cell (five grants) while a stale grant is revoked.
    const edited = projectionIntent({
      roleRevisions: [
        revision({
          cells: [cell({ capabilityKey: CAP_PAY, mode: 'run' }), cell({ capabilityKey: CAP_NOTE, mode: 'run' })],
        }),
      ],
    });
    yield* Effect.result(compiler.reconcile(edited, { fence: () => Effect.void }));
    const { DELETE, TOUCH } = v1.RelationshipUpdate_Operation;
    expect(written).toEqual([[DELETE, TOUCH, TOUCH, TOUCH, TOUCH, TOUCH]]);
  }),
);
