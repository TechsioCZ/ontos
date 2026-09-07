import { DateTime, Effect, FileSystem, Result, Schema } from 'effect';
import { dedupe as dedupeArray, sort as sortArray } from 'effect/Array';
import { String as StringOrder } from 'effect/Order';

export const AUTHORIZATION_ROLLOUT_SCHEMA_VERSION = 1 as const;

const AuthorizationRolloutContractSchema = Schema.Struct({
  activatedAt: Schema.DateTimeUtcFromString,
  baselineInventoryHash: Schema.String,
  baselineSourceRevision: Schema.String,
  compatibilityEligibleEntrypoints: Schema.Array(Schema.String),
  decisionReference: Schema.String,
  expiresAt: Schema.DateTimeUtcFromString,
  mode: Schema.Literals(['enforced', 'report_only']),
  schemaVersion: Schema.Literal(AUTHORIZATION_ROLLOUT_SCHEMA_VERSION),
});

const BaselineSourceRevisionSchema = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9._-]{1,100}$/u),
);
const DecisionReferenceSchema = Schema.String.check(
  Schema.isPattern(/^(?:https:\/\/github\.com\/TechsioCZ\/ontos\/issues\/\d+|ADR-\d{4})$/u),
);

type DecodedAuthorizationRolloutContract = Schema.Schema.Type<
  typeof AuthorizationRolloutContractSchema
>;

export type AuthorizationRolloutContract = Schema.Codec.Encoded<
  typeof AuthorizationRolloutContractSchema
>;
type AuthorizationRolloutContractDocument =
  | boolean
  | null
  | number
  | string
  | readonly AuthorizationRolloutContractDocument[]
  | { readonly [key: string]: AuthorizationRolloutContractDocument };

export interface RolloutValidationContext {
  readonly entrypointKeys?: ReadonlySet<string>;
  readonly inventoryHash: string;
  readonly nowEpochMs: number;
}

export class AuthorizationRolloutContractError extends Schema.TaggedError<AuthorizationRolloutContractError>()(
  'AuthorizationRolloutContractError',
  {
    message: Schema.String,
  },
) {}

const invalidContract = (message: string): AuthorizationRolloutContractError =>
  new AuthorizationRolloutContractError({ message });

const malformedContract = (): AuthorizationRolloutContractError =>
  invalidContract('authorization rollout contract is malformed');

const encodeContract = (
  contract: DecodedAuthorizationRolloutContract,
): Result.Result<AuthorizationRolloutContract, AuthorizationRolloutContractError> =>
  Schema.encodeUnknownResult(AuthorizationRolloutContractSchema)(contract).pipe(
    Result.mapError(malformedContract),
  );

const validateContractActivity = (
  contract: DecodedAuthorizationRolloutContract,
  context: RolloutValidationContext,
): Result.Result<true, AuthorizationRolloutContractError> => {
  const activatedAtEpochMs = DateTime.toEpochMillis(contract.activatedAt);
  const expiresAtEpochMs = DateTime.toEpochMillis(contract.expiresAt);
  return activatedAtEpochMs >= expiresAtEpochMs ||
    context.nowEpochMs < activatedAtEpochMs ||
    (contract.mode === 'report_only' && context.nowEpochMs >= expiresAtEpochMs)
    ? Result.fail(invalidContract('authorization rollout contract is inactive or expired'))
    : Result.succeed(true);
};

const validateInventoryBinding = (
  contract: DecodedAuthorizationRolloutContract,
  context: RolloutValidationContext,
): Result.Result<true, AuthorizationRolloutContractError> =>
  contract.baselineInventoryHash !== context.inventoryHash ||
  !Schema.is(BaselineSourceRevisionSchema)(contract.baselineSourceRevision)
    ? Result.fail(
        invalidContract('authorization rollout contract does not match the classified inventory'),
      )
    : Result.succeed(true);

const validateDecisionReference = (
  contract: DecodedAuthorizationRolloutContract,
): Result.Result<true, AuthorizationRolloutContractError> =>
  Schema.is(DecisionReferenceSchema)(contract.decisionReference)
    ? Result.succeed(true)
    : Result.fail(
        invalidContract('authorization rollout contract requires an auditable decision reference'),
      );

const validateCompatibilityEntrypoints = (
  contract: DecodedAuthorizationRolloutContract,
  context: RolloutValidationContext,
): Result.Result<readonly string[], AuthorizationRolloutContractError> => {
  const entries = sortArray(StringOrder)(dedupeArray(contract.compatibilityEligibleEntrypoints));
  if (entries.length !== contract.compatibilityEligibleEntrypoints.length) {
    return Result.fail(
      invalidContract('authorization rollout compatibility baseline contains duplicates'),
    );
  }
  const { entrypointKeys } = context;
  if (
    entrypointKeys !== undefined &&
    entries.some((entrypoint) => !entrypointKeys.has(entrypoint))
  ) {
    return Result.fail(
      invalidContract(
        'authorization rollout compatibility baseline contains an unknown entrypoint',
      ),
    );
  }
  return Result.succeed(entries);
};

const validateDecodedContract = (
  contract: DecodedAuthorizationRolloutContract,
  context: RolloutValidationContext,
): Result.Result<AuthorizationRolloutContract, AuthorizationRolloutContractError> =>
  Result.gen(function* validateDecodedAuthorizationRolloutContract() {
    yield* validateContractActivity(contract, context);
    yield* validateInventoryBinding(contract, context);
    yield* validateDecisionReference(contract);
    const compatibilityEligibleEntrypoints = yield* validateCompatibilityEntrypoints(
      contract,
      context,
    );
    return yield* encodeContract({ ...contract, compatibilityEligibleEntrypoints });
  });

const decodeContract = (
  raw: AuthorizationRolloutContractDocument,
): Result.Result<DecodedAuthorizationRolloutContract, AuthorizationRolloutContractError> =>
  Schema.decodeUnknownResult(AuthorizationRolloutContractSchema, {
    onExcessProperty: 'error',
  })(raw).pipe(Result.mapError(malformedContract));

export const validateAuthorizationRolloutContract = (
  raw: AuthorizationRolloutContractDocument,
  context: RolloutValidationContext,
): AuthorizationRolloutContract =>
  Result.getOrThrow(
    Result.flatMap(decodeContract(raw), (contract) => validateDecodedContract(contract, context)),
  );

export const loadAuthorizationRolloutContract = (file: string, context: RolloutValidationContext) =>
  Effect.gen(function* loadAuthorizationRolloutContractEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const source = yield* fileSystem.readFileString(file);
    const contract = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(AuthorizationRolloutContractSchema),
      { onExcessProperty: 'error' },
    )(source).pipe(Effect.mapError(malformedContract));
    return yield* Effect.fromResult(validateDecodedContract(contract, context));
  });
