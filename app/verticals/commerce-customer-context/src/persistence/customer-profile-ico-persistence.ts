import {
  defineScopedRoutine,
  ReadHandlerUnavailable,
  ReadHandlerNotFound,
  requireModuleOperation,
} from '@app/core-runtime';
import type { ReadServiceFactory } from '@app/core-runtime';
import { normalizeOfficialIdentifier } from '@app/party-registry/domain/identifier-contracts';
import { DateTime, Effect, Match, Schema } from 'effect';
import { CustomerProfileIcoResponseSchema } from '../../shared/apis/customer-profile-ico.ts';
import type { CustomerProfileIcoRequest } from '../../shared/apis/customer-profile-ico.ts';
import {
  ChangeCustomerProfileIcoResultSchema,
  CustomerProfileIcoRejected,
} from '../../shared/domain/customer-profile-ico.ts';
import type { ChangeCustomerProfileIcoPayload } from '../../shared/domain/customer-profile-ico.ts';
import { CommerceSourceProcessingEligibility } from '../integrations/source-processing-eligibility.ts';

const rowSchema = Schema.Struct({ outcome: Schema.String, result: Schema.Unknown });
const stateRoutine = defineScopedRoutine({
  name: 'customer_profile_ico_state',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: rowSchema,
  routineKey: 'customer-profile-ico.state',
  schema: 'commerce_customer_context',
});
const changeRoutine = defineScopedRoutine({
  name: 'change_customer_profile_ico',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: rowSchema,
  routineKey: 'customer-profile-ico.change',
  schema: 'commerce_customer_context',
});
const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new CustomerProfileIcoRejected({ code: 'PERSISTENCE_UNAVAILABLE', reason: 'Profile IČO authority is unavailable' }),
    'cause',
    { configurable: true, value: cause },
  );
const readUnavailable = (cause: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Current Profile IČO evidence is unavailable',
    }),
    'cause',
    { configurable: true, value: cause },
  );
const allowedCodes = [
  'PROFILE_NOT_FOUND',
  'PROFILE_INELIGIBLE',
  'REVISION_CONFLICT',
  'EFFECT_CONFLICT',
  'INVALID_TRANSITION',
  'MIGRATION_REQUIRED',
] as const;
export interface CustomerProfileIcoServices {
  readonly changeIco: (
    input: ChangeCustomerProfileIcoPayload,
    invocationId: string,
  ) => Effect.Effect<typeof ChangeCustomerProfileIcoResultSchema.Type, CustomerProfileIcoRejected>;
  readonly readIco: (
    input: CustomerProfileIcoRequest,
  ) => Effect.Effect<typeof CustomerProfileIcoResponseSchema.Type, ReadHandlerUnavailable | ReadHandlerNotFound>;
}
export const customerProfileIcoServices: ReadServiceFactory<
  CustomerProfileIcoServices,
  CommerceSourceProcessingEligibility
> = Effect.fn('CustomerProfileIcoPersistence.services')(function* icoServices(transaction, scope) {
  const privacy = yield* CommerceSourceProcessingEligibility;
  const check = (
    provenance: Pick<ChangeCustomerProfileIcoPayload['provenance'], 'sourceContext'>,
    profile: CustomerProfileIcoRequest['profileRef'],
    operation: string,
    operationRequirementKey: string,
  ) =>
    privacy.check(
      scope,
      {
        operation,
        source: provenance.sourceContext,
        target: {
          kind: profile.kind === 'RETAIL' ? 'RETAIL_CUSTOMER_PROFILE' : 'COUNTERPARTY_PURCHASING_PROFILE',
          resourceId: profile.resourceId,
        },
      },
      operationRequirementKey,
    );
  return {
    changeIco: Effect.fn('CustomerProfileIco.change')(function* changeIco(input, invocationId) {
      yield* requireModuleOperation('commerce.customer-context.requirement.profile-ico-write-privacy').pipe(
        Effect.mapError(unavailable),
      );
      yield* check(
        input.provenance,
        input.profileRef,
        'customer-profile-ico.write',
        'commerce.customer-context.requirement.profile-ico-write-privacy',
      ).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new CustomerProfileIcoRejected({
              code: 'PRIVACY_DENIED',
              reason: 'Current Privacy authority does not permit the Profile IČO operation',
            }),
            'cause',
            { configurable: true, value: cause },
          ),
        ),
      );
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      const intent =
        input.operation === 'END'
          ? input
          : { ...input, normalizedValue: normalizeOfficialIdentifier(input.identifier).normalizedValue };
      const [row] = yield* transaction
        .invoke(changeRoutine, [scope.principalId, invocationId, recordedAt, intent])
        .pipe(Effect.mapError(unavailable));
      if (row === undefined) {
        return yield* unavailable();
      }
      if (row.outcome !== 'APPLIED' && row.outcome !== 'REPLAY') {
        const code = allowedCodes.find((candidate) => candidate === row.outcome);
        return yield* new CustomerProfileIcoRejected({
          code: code ?? 'PERSISTENCE_UNAVAILABLE',
          reason: 'The Profile IČO operation conflicts with current owner state',
        });
      }
      const result = yield* Schema.decodeUnknownEffect(ChangeCustomerProfileIcoResultSchema)(row.result).pipe(
        Effect.mapError(unavailable),
      );
      if (row.outcome === 'REPLAY') {
        yield* requireModuleOperation('commerce.customer-context.requirement.profile-ico-write-recovery-privacy').pipe(
          Effect.mapError(unavailable),
        );
        yield* check(
          result.assertion.provenance,
          input.profileRef,
          'customer-profile-ico.read',
          'commerce.customer-context.requirement.profile-ico-write-recovery-privacy',
        ).pipe(
          Effect.mapError((cause) =>
            Object.defineProperty(
              new CustomerProfileIcoRejected({
                code: 'PRIVACY_DENIED',
                reason: 'Current Privacy authority does not permit historical Profile IČO recovery',
              }),
              'cause',
              { configurable: true, value: cause },
            ),
          ),
        );
      }
      return result;
    }),
    readIco: Effect.fn('CustomerProfileIco.read')(function* readIco(input) {
      const [row] = yield* transaction.invoke(stateRoutine, [input]).pipe(Effect.mapError(readUnavailable));
      if (row?.outcome === 'EFFECT_NOT_FOUND') {
        return yield* new ReadHandlerNotFound({
          code: 'read_handler_not_found',
          reason: 'The exact profile IČO effect is not available',
        });
      }
      const result = yield* Schema.decodeUnknownEffect(CustomerProfileIcoResponseSchema)(row?.result).pipe(
        Effect.mapError(readUnavailable),
      );
      const assertions = Match.value(result).pipe(
        Match.tags({
          ABSENT: (available) => available.history,
          MIGRATION_REQUIRED: () => null,
          PRESENT: (available) => available.history,
          RECEIPT: (receipt) => [receipt.assertion],
        }),
        Match.exhaustive,
      );
      if (assertions !== null) {
        yield* requireModuleOperation('commerce.customer-context.requirement.profile-ico-read-privacy').pipe(
          Effect.mapError(readUnavailable),
        );
        yield* Effect.forEach(
          assertions,
          (assertion) =>
            check(
              assertion.provenance,
              input.profileRef,
              'customer-profile-ico.read',
              'commerce.customer-context.requirement.profile-ico-read-privacy',
            ),
          { concurrency: 1, discard: true },
        ).pipe(Effect.mapError(readUnavailable));
      }
      return result;
    }),
  };
});
