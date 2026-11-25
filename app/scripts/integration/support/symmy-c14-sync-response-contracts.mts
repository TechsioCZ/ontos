import { GatewayInternalProblemSchema, GatewayUnavailableProblemSchema } from '@app/shared-contracts';
import { AdmitSymmySyncActionUnavailableProblemSchema } from '@app/symmy-integration/api/admit-symmy-sync-action';
import { Effect, Option, Schema } from 'effect';

import {
  SymmyStockDependencyNotReadyProblemSchema,
  SymmyStockInputProblemSchema,
  SymmyStockSourceUnavailableProblemSchema,
  SymmyUnavailableProblemSchema,
} from '../../../apps/shell-super-app/api/symmy/contract.ts';

const unavailable = Schema.Union([GatewayUnavailableProblemSchema, SymmyUnavailableProblemSchema]);
export const syncNegativeResponseSchemas = {
  stockDependency: SymmyStockDependencyNotReadyProblemSchema,
  stockInput: SymmyStockInputProblemSchema,
  stockSourceUnavailable: SymmyStockSourceUnavailableProblemSchema,
  unavailable,
};

const phaseSchema = Schema.Literals([
  'group-revoked-writer',
  'stock-before-provisioning',
  'stock-unprovisioned-row',
  'stock-unenrolled-location',
  'stock-unenrolled-unit',
  'stock-foreign-unit-tenant',
  'group-without-lifecycle-policy',
  'group-unconfigured-lifecycle-policy',
  'stock-revoked-writer',
  'stock-cancelled-replay',
]);
const envelopeSchema = Schema.Struct({
  _tag: Schema.optionalKey(Schema.Unknown),
  code: Schema.optionalKey(Schema.Unknown),
  retryable: Schema.optionalKey(Schema.Unknown),
});
const tagSchema = Schema.Union([
  GatewayInternalProblemSchema.fields._tag,
  GatewayUnavailableProblemSchema.fields._tag,
  SymmyUnavailableProblemSchema.fields._tag,
  SymmyStockDependencyNotReadyProblemSchema.fields._tag,
  SymmyStockInputProblemSchema.fields._tag,
  SymmyStockSourceUnavailableProblemSchema.fields._tag,
  AdmitSymmySyncActionUnavailableProblemSchema.fields._tag,
]);

export const decodeInternalSyncProblem = <A,>(input: {
  readonly body: unknown;
  readonly phase: typeof phaseSchema.Type;
  readonly schema: Schema.ConstraintDecoder<A>;
  readonly status: number;
}) =>
  Schema.decodeUnknownEffect(input.schema, { onExcessProperty: 'error' })(input.body).pipe(
    Effect.tapError(() => {
      const envelope = Schema.decodeUnknownOption(envelopeSchema)(input.body);
      const metadata = Option.getOrElse(envelope, () => ({
        _tag: null,
        code: null,
        retryable: null,
      }));
      return Effect.logError('Internal C14 negative response contract mismatch', {
        code: Option.getOrNull(
          Schema.decodeUnknownOption(AdmitSymmySyncActionUnavailableProblemSchema.fields.code)(metadata.code),
        ),
        phase: input.phase,
        retryable: Option.getOrNull(Schema.decodeUnknownOption(Schema.Boolean)(metadata.retryable)),
        status: input.status,
        tag: Option.getOrElse(Schema.decodeUnknownOption(tagSchema)(metadata._tag), () => 'unrecognized'),
      }).pipe(Effect.ignoreCause);
    }),
  );
