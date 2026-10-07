import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { OperationContextUnavailable, defineScopedRoutine } from '@app/core-runtime';
import type { Option } from 'effect';
import { Effect, Schema } from 'effect';
import {
  AcceptPaymentTermSourceStatementResultSchema,
  ConfigurePaymentTermSourceAuthorityResultSchema,
} from '../../shared/domain/payment-term-source.ts';
import type {
  AcceptPaymentTermSourceStatementPayload,
  AcceptPaymentTermSourceStatementResult,
  ConfigurePaymentTermSourceAuthorityPayload,
  ConfigurePaymentTermSourceAuthorityResult,
  PaymentTermSourceKey,
} from '../../shared/domain/payment-term-source.ts';
import { PaymentTermCatalogPersistenceUnavailable } from './errors.ts';

type Transaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
interface MutationContext {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
}
const DecisionSchema = Schema.Struct({
  canonicalCreated: Schema.Boolean,
  changed: Schema.Boolean,
  result: AcceptPaymentTermSourceStatementResultSchema,
});
const routine = (name: string) =>
  defineScopedRoutine({
    name,
    ownerModuleKey: 'payment.term-catalog',
    parameters: [
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
      { source: 'input', type: 'jsonb' },
    ],
    resultSchema: Schema.Struct({ payload: Schema.Unknown }),
    routineKey: `catalog.${name}`,
    schema: 'payment_term_catalog',
  });
export const configureSourceAuthorityRoutine = routine('configure_source_authority');
export const acceptSourceStatementRoutine = routine('accept_source_statement');
export const getSourceStatementRoutine = routine('get_source_statement');
const unavailable = (cause?: unknown) => {
  const failure = new PaymentTermCatalogPersistenceUnavailable({
    code: 'payment_term_catalog_persistence_unavailable',
    reason: 'Payment Term source persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};
export interface PaymentTermSourcePersistence {
  readonly acceptSourceStatement: (
    input: AcceptPaymentTermSourceStatementPayload & MutationContext,
  ) => Effect.Effect<typeof DecisionSchema.Type, PaymentTermCatalogPersistenceUnavailable>;
  readonly configureSourceAuthority: (
    input: ConfigurePaymentTermSourceAuthorityPayload & MutationContext,
  ) => Effect.Effect<ConfigurePaymentTermSourceAuthorityResult, PaymentTermCatalogPersistenceUnavailable>;
  readonly getSourceStatement: (
    input: PaymentTermSourceKey,
  ) => Effect.Effect<Option.Option<AcceptPaymentTermSourceStatementResult>, PaymentTermCatalogPersistenceUnavailable>;
}
export const paymentTermSourcePersistenceForScope = (
  transaction: Transaction,
  scope: OperationalScope,
): Effect.Effect<PaymentTermSourcePersistence, OperationContextUnavailable> => {
  if (scope.legalEntityId === undefined) {
    return Effect.fail(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Payment Term source operations require a trusted legal entity',
      }),
    );
  }
  const invoke = <A>(
    selected: ReturnType<typeof routine>,
    input:
      | PaymentTermSourceKey
      | (ConfigurePaymentTermSourceAuthorityPayload & MutationContext)
      | (AcceptPaymentTermSourceStatementPayload & MutationContext),
    schema: Schema.ConstraintDecoder<A>,
  ): Effect.Effect<A, PaymentTermCatalogPersistenceUnavailable> =>
    transaction.invoke(selected, [input]).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined
          ? Effect.fail(unavailable())
          : Schema.decodeUnknownEffect(schema)(row.payload).pipe(Effect.mapError(unavailable));
      }),
    );
  return Effect.succeed(
    Object.freeze({
      acceptSourceStatement: (input: AcceptPaymentTermSourceStatementPayload & MutationContext) =>
        invoke(acceptSourceStatementRoutine, input, DecisionSchema),
      configureSourceAuthority: (input: ConfigurePaymentTermSourceAuthorityPayload & MutationContext) =>
        invoke(configureSourceAuthorityRoutine, input, ConfigurePaymentTermSourceAuthorityResultSchema),
      getSourceStatement: (input: PaymentTermSourceKey) =>
        invoke(getSourceStatementRoutine, input, Schema.OptionFromNullOr(AcceptPaymentTermSourceStatementResultSchema)),
    }),
  );
};
