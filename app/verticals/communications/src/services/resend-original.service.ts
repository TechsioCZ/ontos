import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { CommunicationDecisionUnavailable } from '../../shared/communication-intake-errors.ts';
import { CommunicationRequestIdSchema } from '../../shared/communication-intake.ts';
import { communicationRequests, messageIntents } from '../database/schema.ts';
import { effectBlockOf } from '../domain/history/unknown-effect.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import type { ResendOriginalPortContract } from '../domain/recovery/resend-admission.ts';
import { loadRequestHistory } from './message-history.service.ts';

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new CommunicationDecisionUnavailable({
      code: 'communication_decision_unavailable',
      reason: 'The original Message Intent of a resend could not be read',
    }),
    'cause',
    // REPLACED by its safe kind: a failed statement carries its bound parameters
    { enumerable: false, value: cause === undefined ? undefined : safeCauseOf(cause) },
  );

/**
 * The original intent of an Explicit Resend, read inside the Action's own scoped Core transaction (#1403). Row-level security
 * confines the read to the installed Tenant, so an intent of another Tenant is simply not found. It carries the source owner of
 * the original's request, its type and what its append-only history says about the external effect: never a recipient address.
 */
export const postgresResendOriginalPort = (
  transaction: ScopedTransactionExecutor,
  scope: Pick<OperationalScope, 'tenantId'>,
): ResendOriginalPortContract => ({
  findOriginal: Effect.fn('CommunicationIntake.findResendOriginal')(function* find(originalIntentId) {
    const { tenantId } = scope;
    const [original] = yield* transaction
      .select({
        requestId: messageIntents.requestId,
        sourceModule: communicationRequests.sourceModule,
        typeId: messageIntents.typeId,
      })
      .from(messageIntents)
      .innerJoin(
        communicationRequests,
        and(
          eq(communicationRequests.tenantId, messageIntents.tenantId),
          eq(communicationRequests.requestId, messageIntents.requestId),
        ),
      )
      .where(and(eq(messageIntents.tenantId, tenantId), eq(messageIntents.intentId, originalIntentId)))
      .pipe(Effect.mapError(unavailable));
    if (original === undefined) {
      return Option.none();
    }
    const history = yield* loadRequestHistory(
      transaction,
      tenantId,
      CommunicationRequestIdSchema.make(original.requestId),
    ).pipe(Effect.mapError(unavailable));
    const record = history.pipe(
      Option.flatMap(({ intents }) =>
        Option.fromNullishOr(intents.find(({ intentId }) => intentId === originalIntentId)),
      ),
    );
    // an original whose history cannot be read is not admitted on a guess
    return Option.isNone(record)
      ? yield* unavailable()
      : Option.some({
          effectBlock: effectBlockOf(record.value.facts),
          sourceModule: original.sourceModule,
          typeId: original.typeId,
        });
  }),
});
