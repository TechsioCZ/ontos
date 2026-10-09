import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { ConfigurationUnitCurrent } from '../../shared/domain/configuration-unit.ts';
import { CONFIGURATION_UNIT_RESOURCE_TYPE } from '../../shared/domain/configuration-unit.ts';
import type { CreateConfigurationUnitPayload } from '../../shared/actions/create-configuration-unit.ts';
import type { ReviseConfigurationUnitPayload } from '../../shared/actions/revise-configuration-unit.ts';
import type { RetireConfigurationUnitPayload } from '../../shared/actions/retire-configuration-unit.ts';
import { ConfigurationUnitRefSchema } from '../../shared/resources/configuration-unit.ts';
import { configurationUnitRevisions, configurationUnits } from '../database/schema.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type UnitRevisionRow = typeof configurationUnitRevisions.$inferSelect;
interface MutationInput<Payload> {
  readonly actionInvocationId: string;
  readonly payload: Payload;
  readonly principalId: string;
}

export type ConfigurationUnitMutationOutcome =
  | {
      readonly revision: number;
      readonly status: 'CREATED' | 'REVISED' | 'RETIRED';
      readonly unit: typeof ConfigurationUnitRefSchema.Type;
    }
  | { readonly reason: string; readonly status: 'INVALID' }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'STALE' };

class ConfigurationUnitPersistenceUnavailable extends Schema.TaggedError<ConfigurationUnitPersistenceUnavailable>()(
  'ConfigurationUnitPersistenceUnavailable',
  { code: Schema.Literal('configuration_unit_persistence_unavailable'), reason: Schema.String },
) {}

const unavailable = (cause?: unknown) => {
  const failure = new ConfigurationUnitPersistenceUnavailable({
    code: 'configuration_unit_persistence_unavailable',
    reason: 'Authoritative Configuration Unit evidence is unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export interface ConfigurationUnitPersistence {
  readonly create: (
    input: MutationInput<CreateConfigurationUnitPayload>,
  ) => Effect.Effect<ConfigurationUnitMutationOutcome, ConfigurationUnitPersistenceUnavailable>;
  /** No/latest ambiguity is explicit; caller must fail closed unless status is CONFIRMED and ACTIVE. */
  readonly readCurrent: (
    unitId: string,
    assessedAt: Date,
  ) => Effect.Effect<ConfigurationUnitCurrent, ConfigurationUnitPersistenceUnavailable>;
  readonly retire: (
    input: MutationInput<RetireConfigurationUnitPayload>,
  ) => Effect.Effect<ConfigurationUnitMutationOutcome, ConfigurationUnitPersistenceUnavailable>;
  readonly revise: (
    input: MutationInput<ReviseConfigurationUnitPayload>,
  ) => Effect.Effect<ConfigurationUnitMutationOutcome, ConfigurationUnitPersistenceUnavailable>;
}

const validWindow = (from: string, to?: string) => {
  const start = DateTime.make(from);
  const end = to === undefined ? Option.none() : DateTime.make(to);
  return (
    Option.isSome(start) &&
    (to === undefined ||
      (Option.isSome(end) && DateTime.toEpochMillis(end.value) > DateTime.toEpochMillis(start.value)))
  );
};

const validHistory = (rows: readonly UnitRevisionRow[]) =>
  rows.every((row, index) => {
    const predecessor = rows[index - 1];
    return (
      row.revision === index + 1 &&
      Number.isFinite(row.effectiveFrom.getTime()) &&
      (row.effectiveTo === null || row.effectiveTo > row.effectiveFrom) &&
      (predecessor === undefined ||
        (row.effectiveFrom > predecessor.effectiveFrom &&
          (predecessor.effectiveTo === null || row.effectiveFrom >= predecessor.effectiveTo)))
    );
  });

/** The caller supplies Core's trusted assessment instant and scoped owner transaction. */
export const configurationUnitPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ConfigurationUnitPersistence => {
  const { tenantId } = scope;
  const getUnit = (unitId: string) =>
    transaction
      .select()
      .from(configurationUnits)
      .where(and(eq(configurationUnits.tenantId, tenantId), eq(configurationUnits.unitId, unitId)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
  const getHistory = (unitId: string) =>
    transaction
      .select()
      .from(configurationUnitRevisions)
      .where(and(eq(configurationUnitRevisions.tenantId, tenantId), eq(configurationUnitRevisions.unitId, unitId)))
      .orderBy(asc(configurationUnitRevisions.revision))
      .pipe(Effect.mapError(unavailable));
  const validRef = (ref: typeof ConfigurationUnitRefSchema.Type) =>
    Schema.is(ConfigurationUnitRefSchema)(ref) && ref.tenantId === tenantId;
  const append = (
    input: MutationInput<
      CreateConfigurationUnitPayload | ReviseConfigurationUnitPayload | RetireConfigurationUnitPayload
    >,
    revision: number,
    lifecycleState: 'ACTIVE' | 'RETIRED',
    meaning: string,
    dimension: string,
  ) =>
    transaction
      .insert(configurationUnitRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        dimension,
        effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe(input.payload.effectiveFrom)),
        effectiveTo:
          input.payload.effectiveTo === undefined
            ? null
            : DateTime.toDateUtc(DateTime.makeUnsafe(input.payload.effectiveTo)),
        evidenceRefs: [...input.payload.evidenceRefs],
        lifecycleState,
        meaning,
        reason: input.payload.reason,
        revision,
        tenantId,
        unitId: input.payload.unitRef.resourceId,
      })
      .pipe(Effect.mapError(unavailable));
  const create: ConfigurationUnitPersistence['create'] = Effect.fn('ConfigurationUnitPersistence.create')(
    function* create(input) {
      const { payload } = input;
      if (!validRef(payload.unitRef) || !validWindow(payload.effectiveFrom, payload.effectiveTo)) {
        return { reason: 'Configuration Unit identity or effective window is invalid', status: 'INVALID' };
      }
      const [existing] = yield* getUnit(payload.unitRef.resourceId);
      if (existing !== undefined) {
        return { reason: 'Configuration Unit identity already exists', status: 'INVALID' };
      }
      yield* transaction
        .insert(configurationUnits)
        .values({ code: payload.code, tenantId, unitId: payload.unitRef.resourceId })
        .pipe(Effect.mapError(unavailable));
      yield* append(input, 1, 'ACTIVE', payload.meaning, payload.dimension);
      return { revision: 1, status: 'CREATED', unit: payload.unitRef };
    },
  );
  const advance = Effect.fn('ConfigurationUnitPersistence.advance')(function* advance(
    input: MutationInput<ReviseConfigurationUnitPayload | RetireConfigurationUnitPayload>,
    status: 'REVISED' | 'RETIRED',
    meaning?: string,
    dimension?: string,
  ) {
    const { payload } = input;
    if (!validRef(payload.unitRef) || !validWindow(payload.effectiveFrom, payload.effectiveTo)) {
      return { reason: 'Configuration Unit identity or effective window is invalid', status: 'INVALID' } as const;
    }
    const [unit] = yield* getUnit(payload.unitRef.resourceId);
    if (unit === undefined) {
      return { status: 'NOT_FOUND' } as const;
    }
    const history = yield* getHistory(unit.unitId);
    if (!validHistory(history)) {
      return yield* unavailable();
    }
    const previous = history.at(-1);
    if (previous === undefined || previous.revision !== payload.expectedRevision) {
      return { status: 'STALE' } as const;
    }
    const nextFrom = DateTime.toDateUtc(DateTime.makeUnsafe(payload.effectiveFrom));
    if (
      previous.lifecycleState === 'RETIRED' ||
      nextFrom <= previous.effectiveFrom ||
      (previous.effectiveTo !== null && nextFrom < previous.effectiveTo)
    ) {
      return {
        reason: 'Unit revision cannot overlap, precede, or reactivate the previous revision',
        status: 'INVALID',
      } as const;
    }
    const revision = previous.revision + 1;
    yield* append(
      input,
      revision,
      status === 'RETIRED' ? 'RETIRED' : 'ACTIVE',
      meaning ?? previous.meaning,
      dimension ?? previous.dimension,
    );
    return { revision, status, unit: payload.unitRef } as const;
  });
  return {
    create,
    readCurrent: Effect.fn('ConfigurationUnitPersistence.readCurrent')(function* readCurrent(unitId, assessedAt) {
      if (
        !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(unitId) ||
        !Number.isFinite(assessedAt.getTime())
      ) {
        return { status: 'NO_CURRENT' } as const;
      }
      const [unit] = yield* transaction
        .select({ unitId: configurationUnits.unitId })
        .from(configurationUnits)
        .where(and(eq(configurationUnits.tenantId, scope.tenantId), eq(configurationUnits.unitId, unitId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (unit === undefined) {
        return { status: 'NOT_FOUND' } as const;
      }
      const revisions = yield* getHistory(unitId);
      if (!validHistory(revisions)) {
        return { status: 'CONFLICT' } as const;
      }
      const applicable = revisions.filter((row) => row.effectiveFrom <= assessedAt);
      if (applicable.length === 0) {
        return { status: 'NO_CURRENT' } as const;
      }
      const row = applicable.at(-1);
      const successor = revisions.find((candidate) => candidate.revision === (row?.revision ?? 0) + 1);
      if (row?.effectiveTo !== null && row?.effectiveTo !== undefined && assessedAt >= row.effectiveTo) {
        return { status: 'NO_CURRENT' } as const;
      }
      if (row === undefined || row.lifecycleState !== 'ACTIVE') {
        return { status: 'RETIRED' } as const;
      }
      if (row.evidenceRefs.length === 0 || row.evidenceRefs.some((ref) => ref.trim() !== ref || ref.length === 0)) {
        return yield* unavailable();
      }
      const revision = {
        dimension: row.dimension,
        effectiveFrom: row.effectiveFrom,
        evidenceRefs: row.evidenceRefs,
        lifecycleState: 'ACTIVE' as const,
        meaning: row.meaning,
        ref: {
          moduleId: 'commerce.catalog' as const,
          resourceId: unitId,
          resourceType: CONFIGURATION_UNIT_RESOURCE_TYPE,
          tenantId: scope.tenantId,
        },
        revision: row.revision,
      };
      const effectiveTo = row.effectiveTo ?? successor?.effectiveFrom;
      return {
        assessedAt,
        revision: effectiveTo === undefined ? revision : { ...revision, effectiveTo },
        status: 'CONFIRMED',
      } as const;
    }),
    retire: (input) => advance(input, 'RETIRED'),
    revise: (input) => advance(input, 'REVISED', input.payload.meaning, input.payload.dimension),
  };
};
