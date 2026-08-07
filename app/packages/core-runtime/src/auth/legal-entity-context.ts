/* eslint-disable max-classes-per-file, no-nested-ternary, unicorn/no-nested-ternary -- The legal-entity context owns one closed failure vocabulary and classification expression. */
import { and, eq } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import { legalEntities } from '../db/schema.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class LegalEntityContextMissingError extends Schema.TaggedErrorClass<LegalEntityContextMissingError>()(
  'LegalEntityContextMissingError',
  {},
) {}

export class LegalEntityContextInactiveError extends Schema.TaggedErrorClass<LegalEntityContextInactiveError>()(
  'LegalEntityContextInactiveError',
  {},
) {}

export class LegalEntityContextInvalidError extends Schema.TaggedErrorClass<LegalEntityContextInvalidError>()(
  'LegalEntityContextInvalidError',
  {},
) {}

export class LegalEntityContextAmbiguousError extends Schema.TaggedErrorClass<LegalEntityContextAmbiguousError>()(
  'LegalEntityContextAmbiguousError',
  {},
) {}

export class LegalEntityContextUnavailableError extends Schema.TaggedErrorClass<LegalEntityContextUnavailableError>()(
  'LegalEntityContextUnavailableError',
  { reason: Schema.String },
) {}

export type LegalEntityContextError =
  | LegalEntityContextMissingError
  | LegalEntityContextInactiveError
  | LegalEntityContextInvalidError
  | LegalEntityContextAmbiguousError
  | LegalEntityContextUnavailableError;

export interface LegalEntityContextRecord {
  readonly legalEntityId: string;
  readonly legalName: string;
  readonly status: string;
  readonly tenantId: string;
}

export interface SafeLegalEntity {
  readonly legalEntityId: string;
  readonly legalName: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const validRecord = (record: LegalEntityContextRecord, tenantId: string): boolean =>
  uuidPattern.test(record.legalEntityId) &&
  uuidPattern.test(record.tenantId) &&
  record.tenantId === tenantId &&
  record.legalName.trim().length > 0 &&
  ['active', 'suspended', 'archived'].includes(record.status);

const validateRecords = (
  records: readonly LegalEntityContextRecord[],
  tenantId: string,
): Effect.Effect<
  readonly LegalEntityContextRecord[],
  LegalEntityContextInvalidError | LegalEntityContextAmbiguousError
> => {
  if (!uuidPattern.test(tenantId) || records.some((record) => !validRecord(record, tenantId))) {
    return Effect.fail(new LegalEntityContextInvalidError());
  }

  if (new Set(records.map((record) => record.legalEntityId)).size !== records.length) {
    return Effect.fail(new LegalEntityContextAmbiguousError());
  }

  return Effect.succeed(records);
};

export const classifyActiveLegalEntities = (
  records: readonly LegalEntityContextRecord[],
  tenantId: string,
): Effect.Effect<
  readonly SafeLegalEntity[],
  LegalEntityContextInvalidError | LegalEntityContextAmbiguousError
> =>
  validateRecords(records, tenantId).pipe(
    Effect.map((validated) =>
      validated
        .filter((record) => record.status === 'active')
        .map(({ legalEntityId, legalName }) => ({ legalEntityId, legalName }))
        .toSorted(
          (left, right) =>
            compareText(left.legalName, right.legalName) ||
            compareText(left.legalEntityId, right.legalEntityId),
        ),
    ),
  );

export const classifySelectedLegalEntity = (
  records: readonly LegalEntityContextRecord[],
  tenantId: string,
  legalEntityId: string,
): Effect.Effect<
  SafeLegalEntity,
  Exclude<LegalEntityContextError, LegalEntityContextUnavailableError>
> =>
  Effect.gen(function* classifySelectedLegalEntityEffect() {
    const validated = yield* validateRecords(records, tenantId);
    if (!uuidPattern.test(legalEntityId)) {
      return yield* new LegalEntityContextInvalidError();
    }

    const matching = validated.filter((record) => record.legalEntityId === legalEntityId);
    if (matching.length === 0) {
      return yield* new LegalEntityContextMissingError();
    }
    if (matching.length !== 1) {
      return yield* new LegalEntityContextAmbiguousError();
    }

    const [selected] = matching;
    if (selected === undefined) {
      return yield* new LegalEntityContextMissingError();
    }
    if (selected.status !== 'active') {
      return yield* new LegalEntityContextInactiveError();
    }

    return {
      legalEntityId: selected.legalEntityId,
      legalName: selected.legalName,
    };
  });

export interface LegalEntityContextShape {
  readonly listActiveForTenant: (
    tenantId: string,
  ) => Effect.Effect<readonly SafeLegalEntity[], LegalEntityContextError>;
  readonly validateSelection: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<SafeLegalEntity, LegalEntityContextError>;
}

export class LegalEntityContext extends Context.Service<
  LegalEntityContext,
  LegalEntityContextShape
>()('@app/core-runtime/auth/legal-entity-context/LegalEntityContext') {}

export const makeLegalEntityContext = (
  database: Context.Service.Shape<typeof CoreDatabase>,
): LegalEntityContextShape => {
  const loadRecords = (
    tenantId: string,
    legalEntityId?: string,
  ): Effect.Effect<readonly LegalEntityContextRecord[], LegalEntityContextUnavailableError> =>
    Effect.tryPromise({
      catch: () =>
        new LegalEntityContextUnavailableError({
          reason: 'Unable to resolve the legal-entity context',
        }),
      try: () =>
        database.executor
          .select({
            legalEntityId: legalEntities.legalEntityId,
            legalName: legalEntities.legalName,
            status: legalEntities.status,
            tenantId: legalEntities.tenantId,
          })
          .from(legalEntities)
          .where(
            and(
              eq(legalEntities.tenantId, tenantId),
              ...(legalEntityId === undefined
                ? []
                : [eq(legalEntities.legalEntityId, legalEntityId)]),
            ),
          ),
    });

  return {
    listActiveForTenant: (tenantId) =>
      loadRecords(tenantId).pipe(
        Effect.flatMap((records) => classifyActiveLegalEntities(records, tenantId)),
      ),
    validateSelection: (tenantId, legalEntityId) =>
      loadRecords(tenantId, legalEntityId).pipe(
        Effect.flatMap((records) => classifySelectedLegalEntity(records, tenantId, legalEntityId)),
      ),
  };
};

export const LegalEntityContextLive = Layer.effect(
  LegalEntityContext,
  CoreDatabase.pipe(Effect.map(makeLegalEntityContext)),
);
