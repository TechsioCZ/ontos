import type { CommunicationRequestScope } from '@app/communications-contracts/communication-request';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Context, Effect, Option } from 'effect';

import type { CommunicationOutcomeFeed } from '../../shared/communication-history.ts';
import type { CommunicationOutcomeFeedRequest } from '../../shared/apis/communication-outcome-feed.ts';
import { communicationRequests } from '../database/schema.ts';
import { CommunicationTenantIdSchema } from '../domain/catalog/vocabulary.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { scopeKey } from '../domain/recipient/original-binding.ts';
import { loadRequestHistories } from './message-history.service.ts';
import { SourceOutcomeUnavailable } from './source-outcome-unavailable.ts';
import type { RequestHistoryRecord } from './message-history.service.ts';

/**
 * What Communications tells a SOURCE workflow about the request it made (#1402 H-13, AC-07; #1394 PO 2A, #1396 AC-09). The feed is
 * the same derivation as the person-authorized history (`sourceOutcomeFeedOf`), so the source never learns more or less than the
 * history proves, and it carries references and closed codes only.
 *
 * A source reads ONLY its own requests: the source module is the VERIFIED calling module, never a field of the request. The
 * Tenant and Legal Entity are the trusted operation scope. A request of another source, scope or Tenant is the same answer as
 * an absent one, so a source cannot probe what another source asked for.
 */

/** The one exact request a source asks about: its identity (source module x scope x purpose x occurrence x revision). */
export interface SourceRequestIdentity {
  readonly occurrenceId: string;
  readonly occurrenceRevision: number;
  readonly purpose: string;
  readonly scope: CommunicationRequestScope;
  readonly sourceModule: string;
}

/** The owner-local lookup the service reads through; the PostgreSQL form is below, a test double stands in elsewhere. */
export type FindSourceRequest = (
  identity: SourceRequestIdentity,
) => Effect.Effect<Option.Option<RequestHistoryRecord>, SourceOutcomeUnavailable>;

export interface SourceOutcomeService {
  readonly outcomeOf: (
    sourceModule: string,
    input: CommunicationOutcomeFeedRequest,
  ) => Effect.Effect<Option.Option<CommunicationOutcomeFeed>, SourceOutcomeUnavailable>;
}

export class SourceOutcome extends Context.Service<SourceOutcome, SourceOutcomeService>()(
  '@app/communications/services/communication-outcome-feed.service/SourceOutcome',
) {}

const unavailable = (cause?: unknown) =>
  Object.defineProperty(new SourceOutcomeUnavailable({ reason: 'The source outcome is unavailable' }), 'cause', {
    enumerable: false,
    value: cause === undefined ? undefined : safeCauseOf(cause),
  });

interface ExactScopeDraft {
  counterpartyRef?: NonNullable<CommunicationRequestScope['counterpartyRef']>;
  legalEntityId?: NonNullable<CommunicationRequestScope['legalEntityId']>;
  profileRef?: NonNullable<CommunicationRequestScope['profileRef']>;
  storefrontRef?: NonNullable<CommunicationRequestScope['storefrontRef']>;
  tenantId: CommunicationRequestScope['tenantId'];
}

/** The exact scope of the request: the trusted Tenant and Legal Entity plus the source references the source selected. */
const exactScopeOf = (
  scope: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
  selection: NonNullable<CommunicationOutcomeFeedRequest['scope']> = {},
): CommunicationRequestScope => {
  const exact: ExactScopeDraft = { ...selection, tenantId: CommunicationTenantIdSchema.make(scope.tenantId) };
  if (scope.legalEntityId !== undefined) {
    exact.legalEntityId = scope.legalEntityId;
  }
  return exact;
};

/**
 * The outcome feed of ONE request of `sourceModule`, or none when Communications holds no such request. A record whose stored
 * source or scope is not exactly the asked one is never returned, whatever the store answered: the identity is checked again
 * here, so a store that matched too much cannot show a source another source's request.
 */
export const sourceOutcomeService = (
  findRequest: FindSourceRequest,
  scope: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
): SourceOutcomeService =>
  SourceOutcome.of({
    outcomeOf: Effect.fn('Communications.sourceOutcomeOf')(function* outcomeOf(sourceModule, input) {
      const exact = exactScopeOf(scope, input.scope);
      const found = yield* findRequest({
        occurrenceId: input.occurrence.occurrenceId,
        occurrenceRevision: input.occurrence.revision,
        purpose: input.purpose,
        scope: exact,
        sourceModule,
      });
      return found.pipe(
        Option.filter(
          (record) =>
            record.request.sourceModule === sourceModule && scopeKey(record.request.scope) === scopeKey(exact),
        ),
        Option.map((record) => record.feed),
      );
    }),
  });

/** The PostgreSQL form of the port, bound to one scoped Core Read transaction of the installed Tenant. */
export const postgresFindSourceRequest = (
  transaction: ScopedTransactionExecutor,
  tenantId: string,
): FindSourceRequest =>
  Effect.fn('Communications.findSourceRequest')(function* findRequest(identity) {
    const [row] = yield* transaction
      .select({ requestId: communicationRequests.requestId })
      .from(communicationRequests)
      .where(
        and(
          eq(communicationRequests.tenantId, tenantId),
          eq(communicationRequests.sourceModule, identity.sourceModule),
          eq(communicationRequests.purpose, identity.purpose),
          eq(communicationRequests.occurrenceId, identity.occurrenceId),
          eq(communicationRequests.occurrenceRevision, identity.occurrenceRevision),
          eq(communicationRequests.scopeKey, scopeKey(identity.scope)),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return Option.none<RequestHistoryRecord>();
    }
    const records = yield* loadRequestHistories(transaction, tenantId, [row.requestId]).pipe(
      Effect.mapError(unavailable),
    );
    // a request row whose history cannot be read is an inconsistent store: unavailable, never "no request"
    const record = records.get(row.requestId);
    if (record === undefined) {
      return yield* unavailable();
    }
    return Option.some(record);
  });

/** The source outcome service of one Core Read transaction. */
export const sourceOutcomeServiceForScope = (transaction: ScopedTransactionExecutor, scope: OperationalScope) =>
  Effect.succeed({ outcomes: sourceOutcomeService(postgresFindSourceRequest(transaction, scope.tenantId), scope) });
