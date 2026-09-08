import { and, eq } from 'drizzle-orm';
import { Context, Duration, Effect, Layer } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import { legalEntities } from '../db/schema.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { LegalEntityContextAmbiguousError } from './legal-entity-context-ambiguous-error.ts';
import { LegalEntityContextInactiveError } from './legal-entity-context-inactive-error.ts';
import { LegalEntityContextInvalidError } from './legal-entity-context-invalid-error.ts';
import { LegalEntityContextMissingError } from './legal-entity-context-missing-error.ts';
import { LegalEntityContextUnavailableError } from './legal-entity-context-unavailable-error.ts';

export { LegalEntityContextAmbiguousError } from './legal-entity-context-ambiguous-error.ts';
export { LegalEntityContextInactiveError } from './legal-entity-context-inactive-error.ts';
export { LegalEntityContextInvalidError } from './legal-entity-context-invalid-error.ts';
export { LegalEntityContextMissingError } from './legal-entity-context-missing-error.ts';
export { LegalEntityContextUnavailableError } from './legal-entity-context-unavailable-error.ts';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const validRecord = (
  record: LegalEntityContextRecord,
  tenantId: string
): boolean =>
  uuidPattern.test(record.legalEntityId) &&
  uuidPattern.test(record.tenantId) &&
  record.tenantId === tenantId &&
  record.legalName.trim().length > 0 &&
  ['active', 'suspended', 'archived'].includes(record.status);

const validateRecords = (
  records: readonly LegalEntityContextRecord[],
  tenantId: string
): Effect.Effect<
  readonly LegalEntityContextRecord[],
  LegalEntityContextInvalidError | LegalEntityContextAmbiguousError
> => {
  if (
    !uuidPattern.test(tenantId) ||
    records.some((record) => !validRecord(record, tenantId))
  ) {
    return Effect.fail(new LegalEntityContextInvalidError());
  }

  if (
    new Set(records.map((record) => record.legalEntityId)).size !==
    records.length
  ) {
    return Effect.fail(new LegalEntityContextAmbiguousError());
  }

  return Effect.succeed(records);
};

export const classifyActiveLegalEntities = (
  records: readonly LegalEntityContextRecord[],
  tenantId: string
): Effect.Effect<
  readonly SafeLegalEntity[],
  LegalEntityContextInvalidError | LegalEntityContextAmbiguousError
> =>
  validateRecords(records, tenantId).pipe(
    Effect.map((validated) =>
      validated
        .flatMap(({ legalEntityId, legalName, status }) =>
          status === 'active' ? [{ legalEntityId, legalName }] : []
        )
        .toSorted(
          (left, right) =>
            compareText(left.legalName, right.legalName) ||
            compareText(left.legalEntityId, right.legalEntityId)
        )
    )
  );

export const classifySelectedLegalEntity = Effect.fn(
  'LegalEntityContext.classifySelectedLegalEntity'
)(function* classifySelectedLegalEntityEffect(
  records: readonly LegalEntityContextRecord[],
  tenantId: string,
  legalEntityId: string
): Effect.fn.Return<
  SafeLegalEntity,
  Exclude<LegalEntityContextError, LegalEntityContextUnavailableError>
> {
  const validated = yield* validateRecords(records, tenantId);
  if (!uuidPattern.test(legalEntityId)) {
    return yield* new LegalEntityContextInvalidError();
  }

  const matching = validated.filter(
    (record) => record.legalEntityId === legalEntityId
  );
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

export interface LegalEntityContextService {
  readonly listActiveForTenant: (
    tenantId: string
  ) => Effect.Effect<readonly SafeLegalEntity[], LegalEntityContextError>;
  readonly validateSelection: (
    tenantId: string,
    legalEntityId: string
  ) => Effect.Effect<SafeLegalEntity, LegalEntityContextError>;
}

export class LegalEntityContext extends Context.Service<
  LegalEntityContext,
  LegalEntityContextService
>()('@app/core-runtime/auth/legal-entity-context/LegalEntityContext') {}

type LegalEntityContextRecordLoadResult = Effect.Effect<
  readonly LegalEntityContextRecord[],
  LegalEntityContextUnavailableError
>;

interface LegalEntityContextRecordReader<
  Result extends LegalEntityContextRecordLoadResult,
> {
  readonly load: (tenantId: string, legalEntityId?: string) => Result;
}

const attachCause = <Failure extends object, FailureCause>(
  failure: Failure,
  cause?: FailureCause
): Failure =>
  cause === undefined
    ? failure
    : Object.defineProperty(failure, 'cause', { value: cause });

const unavailable = <FailureCause>(
  cause?: FailureCause
): LegalEntityContextUnavailableError =>
  attachCause(
    new LegalEntityContextUnavailableError({
      reason: 'Unable to resolve the legal-entity context',
    }),
    cause
  );

const DATABASE_OPERATION_TIMEOUT = Duration.seconds(30);

const legalEntityContextRepositoryFromDatabase = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): LegalEntityContextRecordReader<
  Effect.Effect<
    readonly LegalEntityContextRecord[],
    LegalEntityContextUnavailableError
  >
> => ({
  load: (tenantId, legalEntityId) =>
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
            : [eq(legalEntities.legalEntityId, legalEntityId)])
        )
      )
      .pipe(
        Effect.mapError(unavailable),
        Effect.timeoutOrElse({
          duration: DATABASE_OPERATION_TIMEOUT,
          orElse: () => Effect.fail(unavailable()),
        })
      ),
});

const legalEntityContextFromRepository = <
  Result extends LegalEntityContextRecordLoadResult,
>(
  repository: LegalEntityContextRecordReader<Result>
): LegalEntityContextService => {
  const loadRecords = (
    tenantId: string,
    legalEntityId?: string
  ): Effect.Effect<
    readonly LegalEntityContextRecord[],
    LegalEntityContextUnavailableError
  > => repository.load(tenantId, legalEntityId);

  return {
    listActiveForTenant: (tenantId) =>
      loadRecords(tenantId).pipe(
        Effect.flatMap((records) =>
          classifyActiveLegalEntities(records, tenantId)
        )
      ),
    validateSelection: (tenantId, legalEntityId) =>
      loadRecords(tenantId, legalEntityId).pipe(
        Effect.flatMap((records) =>
          classifySelectedLegalEntity(records, tenantId, legalEntityId)
        )
      ),
  };
};

export const makeLegalEntityContext = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): LegalEntityContextService =>
  legalEntityContextFromRepository(
    legalEntityContextRepositoryFromDatabase(database)
  );

export const LegalEntityContextLive = Layer.effect(
  LegalEntityContext,
  CoreDatabase.pipe(Effect.map(makeLegalEntityContext))
);
