import { Effect, Option, Schema } from 'effect';

import { SYMMY_EFFECT_ASSIGNED_AT_ADMISSION } from '../../shared/domain/symmy-customer-batch.ts';
import {
  SYMMY_CUSTOMER_GROUP_REASON,
  SYMMY_CUSTOMER_GROUP_SOURCE_REVISION_STEM,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import type {
  SymmyCustomerGroupDefinitionFacts,
  SymmyCustomerGroupRow,
  SymmyCustomerGroupRows,
} from '../../shared/domain/symmy-customer-group-batch.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { uuidFromDigest } from './derived-identity.ts';
import type { SymmyCustomerSourceAuthority } from './symmy-customer-plan.ts';
import type { Digest } from './symmy-price-list-plan.ts';

const commerce = 'commerce.customer-context';
const createOperation = {
  entrypointKey: 'commerce.customer-context.create-customer-group',
  moduleId: commerce,
  schemaVersion: '1',
} as const;
const updateOperation = {
  entrypointKey: 'commerce.customer-context.update-customer-group',
  moduleId: commerce,
  schemaVersion: '1',
} as const;
type Operation = typeof createOperation | typeof updateOperation;
type TemplateSource = SymmyFixtureExecutionPlan['items'][number]['source'];
type Fact = SymmyCustomerGroupDefinitionFacts[number];

/**
 * A row revises the group its code is bound to only when it states that group's business code and meaning. Any
 * other row of a bound code is planned as a create, which the owner refuses as a conflict: a changed business
 * meaning never silently becomes an update of the same group.
 */
const revisedFact = (row: SymmyCustomerGroupRow, fact: Fact | undefined): Option.Option<Fact> =>
  fact !== undefined && fact.businessCode === row.businessCode && fact.meaningKey === row.meaningKey
    ? Option.some(fact)
    : Option.none();

const sameOperation = (
  left: { readonly entrypointKey: string; readonly moduleId: string; readonly schemaVersion: string },
  right: Operation,
) =>
  left.moduleId === right.moduleId &&
  left.entrypointKey === right.entrypointKey &&
  left.schemaVersion === right.schemaVersion;

/** The one group source the route enrolls every needed owner operation for, or none. */
const enrolledSource = (
  template: SymmyFixtureExecutionPlan,
  needed: readonly Operation[],
): Option.Option<TemplateSource> => {
  const sources = needed.map(
    (operation) =>
      template.items.find(({ effects }) => effects.some((effect) => sameOperation(effect.operation, operation)))
        ?.source,
  );
  const [first] = sources;
  return first !== undefined &&
    sources.every(
      (source) =>
        source !== undefined &&
        source.entityKind === first.entityKind &&
        source.issuerId === first.issuerId &&
        source.sourceNamespace === first.sourceNamespace,
    )
    ? Option.some(first)
    : Option.none();
};

export interface SymmyCustomerGroupPlanInput<Failure> {
  /** The authority of the source route: the route identity, its revision and the mapping every assertion cites. */
  readonly authority: SymmyCustomerSourceAuthority;
  /** A stable hex digest. Replays of one Idempotency-Key must reproduce every derived identity. */
  readonly digest: Digest<Failure>;
  /**
   * What the owner held for each code when the request arrived. A fence, never caller intent: without it nothing is
   * planned, so no group is planned against an owner that was not read.
   */
  readonly facts: SymmyCustomerGroupDefinitionFacts | undefined;
  readonly idempotencyKey: string;
  readonly rows: SymmyCustomerGroupRows;
  readonly template: SymmyFixtureExecutionPlan;
}

interface GroupItemInput<Failure> extends Omit<SymmyCustomerGroupPlanInput<Failure>, 'facts' | 'rows' | 'template'> {
  readonly fact: Fact | undefined;
  readonly index: number;
  readonly row: SymmyCustomerGroupRow;
  readonly source: TemplateSource;
}

const groupItem = Effect.fn('SymmyCustomerGroupPlan.item')(function* groupItem<Failure>(
  input: GroupItemInput<Failure>,
) {
  const { authority, digest, fact, idempotencyKey, index, row, source } = input;
  const itemKey = `customer-group-${index}`;
  const [occurrence, revisionDigest] = yield* Effect.all(
    [
      digest(`occurrence\u0000${idempotencyKey}\u0000${itemKey}`),
      digest(`customer-group-revision\u0000${idempotencyKey}\u0000${row.code}`),
    ],
    { concurrency: 1 },
  );
  const revision = `${SYMMY_CUSTOMER_GROUP_SOURCE_REVISION_STEM}-${revisionDigest}`;
  // The owner orders the assertions of one bound code: a revision follows the last one it holds, a new code starts.
  const definitionSource = {
    definitionEvidence: { kind: 'SOURCE_RECORD', reference: row.code, revision },
    effectId: SYMMY_EFFECT_ASSIGNED_AT_ADMISSION,
    issuer: source.issuerId,
    mappingRevision: authority.mappingRevision,
    namespace: source.sourceNamespace,
    order: fact === undefined ? 1 : fact.sourceOrder + 1,
    recordId: row.code,
    revision,
    route: { id: authority.routeId, revision: authority.routeRevision },
    sourceCode: row.code,
  };
  const definition = {
    description: row.description,
    membershipCriteria: row.membershipCriteria,
    name: row.name,
    purpose: row.purpose,
    reason: SYMMY_CUSTOMER_GROUP_REASON,
    source: definitionSource,
  };
  const effect = Option.match(revisedFact(row, fact), {
    onNone: () => ({
      effectKey: 'customer-group-create',
      intent: {
        _tag: 'CustomerGroupCreate',
        payload: { ...definition, businessCode: row.businessCode, initialState: 'ACTIVE', meaningKey: row.meaningKey },
      },
      operation: createOperation,
    }),
    onSome: ({ groupRef, revision: expectedRevision }) => ({
      effectKey: 'customer-group-update',
      intent: { _tag: 'CustomerGroupUpdate', payload: { ...definition, expectedRevision, groupRef } },
      operation: updateOperation,
      originalTarget: groupRef,
    }),
  });
  return {
    effects: [effect],
    itemKey,
    source: {
      entityKind: source.entityKind,
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: row.code,
    },
    sourceOccurrenceId: uuidFromDigest(occurrence),
  };
});

/**
 * Maps the public customer groups to one internal plan: per group one item with the create of a code the source has
 * not bound yet, or the revision-fenced update of the group its code is bound to. A route that does not enroll the
 * owner operations the rows need for one group source yields no plan at all, so nothing is admitted.
 */
export const buildSymmyCustomerGroupPlan = Effect.fn('SymmyCustomerGroupPlan.build')(
  function* buildSymmyCustomerGroupPlan<Failure>(input: SymmyCustomerGroupPlanInput<Failure>) {
    const { facts, rows, template } = input;
    if (facts === undefined) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const factOf = (row: SymmyCustomerGroupRow) => facts.find(({ code }) => code === row.code);
    const updates = rows.map((row) => Option.isSome(revisedFact(row, factOf(row))));
    const needed = [
      ...(updates.some((update) => !update) ? [createOperation] : []),
      ...(updates.some(Boolean) ? [updateOperation] : []),
    ];
    const source = enrolledSource(template, needed);
    if (Option.isNone(source)) {
      return Option.none<SymmyFixtureExecutionPlan>();
    }
    const items = yield* Effect.forEach(
      rows,
      (row, index) => groupItem({ ...input, fact: factOf(row), index, row, source: source.value }),
      { concurrency: 1 },
    );
    return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items });
  },
);
