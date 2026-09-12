import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Effect, Option, Schema } from 'effect';
import { findPostgresFailure } from '../database/postgres-failure.ts';
import { ScopedRoutineInvocationError } from './scoped-routine-error.ts';
import type { ScopedRoutineInvocationErrorCode } from './scoped-routine-error.ts';

export { SCOPED_ROUTINE_INVOCATION_ERROR_CODES } from './scoped-routine-error.ts';
export { ScopedRoutineInvocationError } from './scoped-routine-error.ts';
export type { ScopedRoutineInvocationErrorCode } from './scoped-routine-error.ts';

const scopedRoutineDeclaration: unique symbol = Symbol('@app/core-runtime/db/scoped-routine/declaration');

class ScopedRoutinePrivateStorage {
  declare readonly [scopedRoutineDeclaration]?: true;

  static create<PublicFields extends object>(
    publicFields: PublicFields,
  ): ScopedRoutinePrivateStorage & Readonly<PublicFields> {
    const storage = Object.assign(new ScopedRoutinePrivateStorage(), publicFields);
    Object.freeze(storage);
    return storage;
  }
}

export const SCOPED_ROUTINE_PARAMETER_TYPES = [
  'bigint',
  'bigint[]',
  'boolean',
  'boolean[]',
  'date',
  'date[]',
  'integer',
  'integer[]',
  'jsonb',
  'jsonb[]',
  'numeric',
  'numeric[]',
  'smallint',
  'smallint[]',
  'text',
  'text[]',
  'timestamptz',
  'timestamptz[]',
  'uuid',
  'uuid[]',
] as const;
export type ScopedRoutineParameterType = (typeof SCOPED_ROUTINE_PARAMETER_TYPES)[number];

export type ScopedRoutineContextParameter = Readonly<{
  readonly source: 'legalEntityId' | 'tenantId';
  readonly type: 'uuid';
}>;

export type ScopedRoutineInputParameter = Readonly<{
  readonly nullable?: boolean;
  readonly source: 'input';
  readonly type: ScopedRoutineParameterType;
}>;

export type ScopedRoutineParameter = ScopedRoutineContextParameter | ScopedRoutineInputParameter;

type ScalarValueByType = Readonly<{
  bigint: bigint | string;
  boolean: boolean;
  date: string;
  integer: number;
  jsonb: object | readonly unknown[];
  numeric: string;
  smallint: number;
  text: string;
  timestamptz: Date | string;
  uuid: string;
}>;

type ScopedRoutineParameterValue<Type extends ScopedRoutineParameterType> =
  Type extends `${infer Element extends keyof ScalarValueByType}[]`
    ? readonly ScalarValueByType[Element][]
    : Type extends keyof ScalarValueByType
      ? ScalarValueByType[Type]
      : never;

export type ScopedRoutineInputValues<Parameters extends readonly ScopedRoutineParameter[]> =
  Parameters extends readonly [
    infer Head extends ScopedRoutineParameter,
    ...infer Tail extends readonly ScopedRoutineParameter[],
  ]
    ? Head extends ScopedRoutineInputParameter
      ? readonly [
          Head['nullable'] extends true
            ? ScopedRoutineParameterValue<Head['type']> | null
            : ScopedRoutineParameterValue<Head['type']>,
          ...ScopedRoutineInputValues<Tail>,
        ]
      : ScopedRoutineInputValues<Tail>
    : readonly [];

export interface ScopedRoutineDefinitionInput<
  RowSchema extends Schema.ConstraintDecoder<object> = Schema.ConstraintDecoder<object>,
  Parameters extends readonly ScopedRoutineParameter[] = readonly ScopedRoutineParameter[],
> {
  readonly name: string;
  /** The public OntOS module key that owns the routine and its migration. */
  readonly ownerModuleKey: string;
  /** Exact PostgreSQL overload signature, including Core-injected context arguments. */
  readonly parameters: Parameters;
  /** Owner-declared decoder for the routine's object-row result. */
  readonly resultSchema: RowSchema;
  /** Stable, owner-local evidence key. This is safe to place in traces and typed failures. */
  readonly routineKey: string;
  readonly schema: string;
}

export type ScopedRoutineDefinition<
  RowSchema extends Schema.ConstraintDecoder<object> = Schema.ConstraintDecoder<object>,
  Parameters extends readonly ScopedRoutineParameter[] = readonly ScopedRoutineParameter[],
> = ScopedRoutinePrivateStorage &
  Readonly<ScopedRoutineDefinitionInput<RowSchema, Parameters>> & {
    readonly [scopedRoutineDeclaration]: true;
  };

export interface ScopedRoutineInvoker {
  readonly invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    values: ScopedRoutineInputValues<Parameters>,
  ) => Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError>;
}

/** Minimum verified context needed to inject owner-routine scope arguments. */
export interface ScopedRoutineScope {
  readonly legalEntityId?: string;
  readonly tenantId: string;
}

export type ScopedRoutineSqlExecution = (statement: SQL) => Effect.Effect<readonly object[], EffectDrizzleQueryError>;

const postgresIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;
const moduleKey = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)*$/u;
const evidenceKey = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const parameterTypes = new Set<string>(SCOPED_ROUTINE_PARAMETER_TYPES);

const parameterTypeSql: Readonly<Record<ScopedRoutineParameterType, SQL>> = Object.freeze({
  bigint: sql.raw('bigint'),
  'bigint[]': sql.raw('bigint[]'),
  boolean: sql.raw('boolean'),
  'boolean[]': sql.raw('boolean[]'),
  date: sql.raw('date'),
  'date[]': sql.raw('date[]'),
  integer: sql.raw('integer'),
  'integer[]': sql.raw('integer[]'),
  jsonb: sql.raw('jsonb'),
  'jsonb[]': sql.raw('jsonb[]'),
  numeric: sql.raw('numeric'),
  'numeric[]': sql.raw('numeric[]'),
  smallint: sql.raw('smallint'),
  'smallint[]': sql.raw('smallint[]'),
  text: sql.raw('text'),
  'text[]': sql.raw('text[]'),
  timestamptz: sql.raw('timestamptz'),
  'timestamptz[]': sql.raw('timestamptz[]'),
  uuid: sql.raw('uuid'),
  'uuid[]': sql.raw('uuid[]'),
});

const ScopedRoutineDefinitionInvariantError = Schema.TaggedError<Error>()('ScopedRoutineDefinitionInvariantError', {
  message: Schema.String,
});

const failRoutineDefinition = (message: string): never => {
  throw new ScopedRoutineDefinitionInvariantError({ message });
};

type ScopedRoutineContextSource = Exclude<ScopedRoutineParameter['source'], 'input'>;

const validateRoutineParameter = (parameter: ScopedRoutineParameter): ScopedRoutineContextSource | undefined => {
  if (!parameterTypes.has(parameter.type)) {
    return failRoutineDefinition('Scoped routine parameter type is not allowlisted');
  }
  if (parameter.source !== 'input' && parameter.type !== 'uuid') {
    return failRoutineDefinition('Scoped routine context parameters must use the uuid type');
  }
  if (parameter.source === 'tenantId' || parameter.source === 'legalEntityId') {
    return parameter.source;
  }
  if (parameter.source !== 'input') {
    return failRoutineDefinition('Scoped routine parameter source is invalid');
  }
  return undefined;
};

const countRoutineContextParameters = (parameters: readonly ScopedRoutineParameter[]) => {
  let tenantParameters = 0;
  let legalEntityParameters = 0;
  for (const parameter of parameters) {
    const source = validateRoutineParameter(parameter);
    if (source === 'tenantId') {
      tenantParameters += 1;
    } else if (source === 'legalEntityId') {
      legalEntityParameters += 1;
    }
  }
  return { legalEntityParameters, tenantParameters };
};

const assertRoutineDefinition = (definition: ScopedRoutineDefinitionInput): void => {
  if (!moduleKey.test(definition.ownerModuleKey)) {
    return failRoutineDefinition('Scoped routine ownerModuleKey is invalid');
  }
  if (!evidenceKey.test(definition.routineKey)) {
    return failRoutineDefinition('Scoped routine routineKey is invalid');
  }
  if (!postgresIdentifier.test(definition.schema) || !postgresIdentifier.test(definition.name)) {
    return failRoutineDefinition('Scoped routine schema or name is not a safe PostgreSQL identifier');
  }
  if (definition.parameters.length === 0 || definition.parameters[0]?.source !== 'tenantId') {
    return failRoutineDefinition('Scoped routines must receive the verified tenantId as their first argument');
  }
  const { legalEntityParameters, tenantParameters } = countRoutineContextParameters(definition.parameters);
  if (tenantParameters !== 1 || legalEntityParameters > 1) {
    return failRoutineDefinition('Scoped routine context parameters must be unique');
  }
};

/**
 * Declares one owner-controlled SECURITY DEFINER allowlist entry.
 * Definitions belong at module scope beside the owning persistence adapter, never in
 * request-derived code.
 */
export const defineScopedRoutine = <
  RowSchema extends Schema.ConstraintDecoder<object>,
  const Parameters extends readonly ScopedRoutineParameter[],
>(
  definition: ScopedRoutineDefinitionInput<RowSchema, Parameters>,
): ScopedRoutineDefinition<RowSchema, Parameters> => {
  assertRoutineDefinition(definition);
  for (const parameter of definition.parameters) {
    Object.freeze(parameter);
  }
  Object.freeze(definition.parameters);
  return ScopedRoutinePrivateStorage.create({
    ...definition,
    [scopedRoutineDeclaration]: true as const,
  });
};

const invocationError = (
  routine: ScopedRoutineDefinition,
  code: ScopedRoutineInvocationErrorCode,
  reason: string,
  failure?: EffectDrizzleQueryError,
): ScopedRoutineInvocationError => {
  const metadata = failure === undefined ? Option.none() : findPostgresFailure(failure);
  return new ScopedRoutineInvocationError({
    code,
    constraint: metadata.pipe(Option.flatMap(({ constraint }) => Option.fromUndefinedOr(constraint))),
    ownerModuleKey: routine.ownerModuleKey,
    postgresCode: metadata.pipe(Option.map(({ code: postgresCode }) => postgresCode)),
    reason,
    routineKey: routine.routineKey,
  });
};

const invalidDeclarationError = (): ScopedRoutineInvocationError =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_arguments_invalid',
    constraint: Option.none(),
    ownerModuleKey: 'unknown',
    postgresCode: Option.none(),
    reason: 'The scoped routine declaration is not an owner allowlist entry',
    routineKey: 'unknown',
  });

const AnyScopedRoutineDefinitionSchema = Schema.instanceOf(ScopedRoutinePrivateStorage).check(
  Schema.makeFilter((declaration) =>
    declaration[scopedRoutineDeclaration] === true && Object.isFrozen(declaration)
      ? undefined
      : 'Expected an immutable owner scoped-routine allowlist entry',
  ),
);

const resolveInvocationValues = <
  RowSchema extends Schema.ConstraintDecoder<object>,
  Parameters extends readonly ScopedRoutineParameter[],
>(
  routine: ScopedRoutineDefinition<RowSchema, Parameters>,
  inputValues: ScopedRoutineInputValues<Parameters>,
  scope: ScopedRoutineScope,
): Effect.Effect<readonly unknown[], ScopedRoutineInvocationError> => {
  const expectedInputCount = routine.parameters.filter(({ source }) => source === 'input').length;
  if (inputValues.length !== expectedInputCount) {
    return Effect.fail(
      invocationError(
        routine,
        'scoped_routine_arguments_invalid',
        'The scoped routine arguments do not match its declared signature',
      ),
    );
  }
  const values: unknown[] = [];
  let inputIndex = 0;
  for (const parameter of routine.parameters) {
    if (parameter.source === 'tenantId') {
      values.push(scope.tenantId);
    } else if (parameter.source === 'legalEntityId') {
      if (scope.legalEntityId === undefined) {
        return Effect.fail(
          invocationError(
            routine,
            'scoped_routine_scope_missing',
            'The scoped routine requires a verified legal entity',
          ),
        );
      }
      values.push(scope.legalEntityId);
    } else {
      values.push(inputValues[inputIndex]);
      inputIndex += 1;
    }
  }
  return Effect.succeed(Object.freeze(values));
};

const invocationStatement = (routine: ScopedRoutineDefinition, values: readonly unknown[]): SQL => {
  const parameters = routine.parameters.map(
    (parameter, index) => sql`${values[index]}::${parameterTypeSql[parameter.type]}`,
  );
  const separator = sql.raw(', ');
  return sql`select * from ${sql.identifier(routine.schema)}.${sql.identifier(routine.name)}(${sql.join(parameters, separator)})`;
};

/** Internal live adapter used only while Core owns the active transaction. */
export const scopedRoutineInvokerFromTransaction = (
  execute: ScopedRoutineSqlExecution,
  scope: ScopedRoutineScope,
): ScopedRoutineInvoker => ({
  invoke: <
    RowSchema extends Schema.ConstraintDecoder<object>,
    const Parameters extends readonly ScopedRoutineParameter[],
  >(
    routine: ScopedRoutineDefinition<RowSchema, Parameters>,
    inputValues: ScopedRoutineInputValues<Parameters>,
  ): Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError> => {
    if (!Schema.is(AnyScopedRoutineDefinitionSchema)(routine)) {
      return Effect.fail(invalidDeclarationError());
    }
    return resolveInvocationValues(routine, inputValues, scope).pipe(
      Effect.flatMap((values) =>
        execute(invocationStatement(routine, values)).pipe(
          Effect.mapError((failure) =>
            invocationError(
              routine,
              'scoped_routine_invocation_failed',
              'The scoped database routine could not be executed',
              failure,
            ),
          ),
        ),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.toType(routine.resultSchema)))),
      Effect.mapError((failure) =>
        Schema.is(ScopedRoutineInvocationError)(failure)
          ? failure
          : invocationError(
              routine,
              'scoped_routine_result_invalid',
              'The scoped database routine returned an invalid result',
            ),
      ),
      Effect.withSpan('ScopedTransactionExecutor.invoke', {
        attributes: {
          ownerModuleKey: routine.ownerModuleKey,
          routineKey: routine.routineKey,
        },
      }),
    );
  },
});
