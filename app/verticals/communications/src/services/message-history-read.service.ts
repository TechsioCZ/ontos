import type { CommunicationRequestScope } from '@app/communications-contracts/communication-request';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerExecutionError, ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DateTime, Effect } from 'effect';

import { MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { MESSAGE_HISTORY_MAX_PAGE_SIZE } from '../../shared/message-history-read.ts';
import type {
  HistorySourceScopeSelection,
  MessageHistoryCursor,
  MessageHistoryItem,
  MessageHistoryTimelineEntry,
} from '../../shared/message-history-read.ts';
import type { MessageHistoryListRequest } from '../../shared/apis/message-history-list.ts';
import { communicationRequests, messageIntents } from '../database/schema.ts';
import { CommunicationTenantIdSchema } from '../domain/catalog/vocabulary.ts';
import { scopeDemandsSourceVisibility, SourceScopeVisibility } from '../domain/access/source-visibility.ts';
import type { SourceScopeVisibilityUnavailable } from '../domain/access/source-visibility-errors.ts';
import { scopeKey } from '../domain/recipient/original-binding.ts';
import { projectMessageHistoryItem, projectTimeline } from '../history/message-history-projection.ts';
import { loadRequestHistories } from './message-history.service.ts';
import type { IntentHistoryRecord, RequestHistoryRecord } from './message-history.service.ts';

/**
 * The PostgreSQL side of the public history Reads (#1409). It reads the owner-internal safe record (`loadRequestHistory`)
 * and hands every message to the allow-list projection; it never returns a stored row, and it never writes: no statement
 * in this module inserts, updates or deletes anything, so reading, refusing or paging history cannot change it.
 *
 * Scope is exact and enforced in the query as well as by Core: the Tenant is the trusted operation Tenant (row-level
 * security also holds it), and the Legal Entity and every source reference are matched through the one scope key the intake
 * stored, so a request of another Legal Entity, or of a wider or narrower source scope, is never a row of this Read.
 */

const unavailable = (cause?: unknown) =>
  Object.defineProperty(
    new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The message history is temporarily unavailable',
    }),
    'cause',
    { enumerable: false, value: cause },
  );

/**
 * A source-scope visibility port that is not composed at all can never answer, so a retry cannot repair it: it is a
 * non-retryable failure of the deployment, never a retryable outage.
 */
const sourceVisibilityNotComposed = () =>
  new ReadHandlerExecutionError({
    code: 'read_handler_execution_failed',
    reason: 'The source scope visibility is not available in this deployment',
  });

/**
 * The scope-wide Reads cannot honour a record-scoped row filter: a predicate with a clause means the gate offered a record
 * scope this owner never declared, and an unrecognised restriction is never widened into "everything" (fail closed).
 */
const unsupportedRowFilter = () =>
  new ReadHandlerExecutionError({
    code: 'read_handler_execution_failed',
    reason: 'The history Reads are scope-wide and cannot apply a record-scoped row filter',
  });

/** Absent and not visible are one answer, so a caller cannot probe which other scopes hold a message. */
const notFound = () =>
  new ReadHandlerNotFound({ code: 'read_handler_not_found', reason: 'The message history was not found' });

/** The exact scope under construction: the dimensions the selection names plus the trusted Tenant and Legal Entity. */
interface ExactScopeDraft {
  counterpartyRef?: NonNullable<CommunicationRequestScope['counterpartyRef']>;
  legalEntityId?: NonNullable<CommunicationRequestScope['legalEntityId']>;
  profileRef?: NonNullable<CommunicationRequestScope['profileRef']>;
  storefrontRef?: NonNullable<CommunicationRequestScope['storefrontRef']>;
  tenantId: CommunicationRequestScope['tenantId'];
}

/** The exact scope of a Read: the trusted Tenant and Legal Entity plus the source references the caller selected. */
const exactScopeOf = (
  scope: Pick<OperationalScope, 'legalEntityId' | 'tenantId'>,
  selection: HistorySourceScopeSelection,
): CommunicationRequestScope => {
  const exact: ExactScopeDraft = { ...selection, tenantId: CommunicationTenantIdSchema.make(scope.tenantId) };
  if (scope.legalEntityId !== undefined) {
    exact.legalEntityId = scope.legalEntityId;
  }
  return exact;
};

export interface ReadOptions {
  /** Whether the caller may read the personal-data field group of the endpoint mask. */
  readonly includeEndpointMask: boolean;
  /**
   * The gate's row filter. Both Reads declare `selectors: []`, so the engine plans only `all` cells for them (a record
   * selector is never supported, `selectorSupported` in the decision engine) and the only predicate it can build is the empty
   * "every row of the scope" one: the Reads are scope-wide by design, because history is governed by the exact Tenant,
   * Legal Entity and source scope, never by an owner of a single message. A predicate that nevertheless names a clause is
   * refused (`requireScopeWide`), never filtered after the page was read: a fetch-then-filter would leak the hidden rows
   * through `nextCursor` and could never evaluate a record condition (AUTHORIZATION.md: the owner query never fetches rows
   * and filters them afterwards).
   */
  readonly listAccess?: ListAccessPredicate | undefined;
}

export interface MessageHistoryPage {
  readonly items: readonly MessageHistoryItem[];
  readonly nextCursor: MessageHistoryCursor | undefined;
}

export interface MessageHistoryDetailRecord {
  readonly message: MessageHistoryItem;
  readonly timeline: readonly MessageHistoryTimelineEntry[];
}

const requireScopeWide = (filter: ListAccessPredicate | undefined) =>
  filter === undefined || filter.groups.length === 0 ? Effect.void : Effect.fail(unsupportedRowFilter());

const cursorPredicate = (cursor: MessageHistoryCursor | undefined) =>
  cursor === undefined
    ? undefined
    : sql`(${messageIntents.createdAt}, ${messageIntents.intentId}) < (${DateTime.formatIso(cursor.createdAt)}::timestamptz, ${cursor.intentId}::uuid)`;

const projectItem = (request: RequestHistoryRecord, intent: IntentHistoryRecord, options: ReadOptions) =>
  projectMessageHistoryItem(request, intent, options).pipe(Effect.mapError(unavailable));

/**
 * The read service of one Core Read transaction. The source-owner visibility port is captured once at construction, so a
 * Read that cannot reach its port cannot be built, and there is no path to a result that skipped the check.
 */
export const messageHistoryReadService = Effect.fn('Communications.messageHistoryReadService')(function* build(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
) {
  const visibility = yield* SourceScopeVisibility;
  const { principalId, tenantId } = scope;

  /**
   * True only when the source owners say the caller sees this scope; an owner that cannot say fails with its own typed
   * failure. A scope without a source reference is governed by the Current Permission alone and no owner is asked.
   */
  const visibleToCaller = (requestScope: CommunicationRequestScope) =>
    scopeDemandsSourceVisibility(requestScope)
      ? visibility.check({ principalId, scope: requestScope }).pipe(Effect.map((answer) => answer === 'VISIBLE'))
      : Effect.succeed(true);

  /** A LIST names its scope itself, so an owner outage says nothing about any stored message and is told as it is. */
  const listVisibleToCaller = (requestScope: CommunicationRequestScope) =>
    visibleToCaller(requestScope).pipe(
      Effect.mapError((failure: SourceScopeVisibilityUnavailable) =>
        failure.reason === 'NOT_COMPOSED' ? sourceVisibilityNotComposed() : unavailable(failure),
      ),
    );

  /**
   * A DETAIL names only a message, whose source scope is known only once it exists. An owner that cannot answer must
   * therefore look exactly like a message that is absent or not visible: a 503 for a message of the caller's own Legal
   * Entity next to a 404 for a foreign or missing one would let the caller probe which identities exist.
   */
  const detailVisibleToCaller = (requestScope: CommunicationRequestScope) =>
    visibleToCaller(requestScope).pipe(
      Effect.catchTag('SourceScopeVisibilityUnavailable', () => Effect.succeed(false)),
    );

  const list = Effect.fn('Communications.listMessageHistory')(function* listPage(
    input: MessageHistoryListRequest,
    options: ReadOptions,
  ) {
    yield* requireScopeWide(options.listAccess);
    const limit = input.limit ?? MESSAGE_HISTORY_MAX_PAGE_SIZE;
    const exact = exactScopeOf(scope, input.scope ?? {});
    // The source owners are asked before any row is read: an owner that cannot answer ends the Read, never an empty page.
    if (!(yield* listVisibleToCaller(exact))) {
      return yield* notFound();
    }
    const key = scopeKey(exact);
    const rows = yield* transaction
      .select({
        createdAt: messageIntents.createdAt,
        intentId: messageIntents.intentId,
        requestId: messageIntents.requestId,
      })
      .from(messageIntents)
      .innerJoin(
        communicationRequests,
        and(
          eq(messageIntents.tenantId, communicationRequests.tenantId),
          eq(messageIntents.requestId, communicationRequests.requestId),
        ),
      )
      .where(
        and(
          eq(messageIntents.tenantId, tenantId),
          eq(communicationRequests.scopeKey, key),
          input.sourceModule === undefined ? undefined : eq(communicationRequests.sourceModule, input.sourceModule),
          input.purpose === undefined ? undefined : eq(communicationRequests.purpose, input.purpose),
          input.occurrenceId === undefined ? undefined : eq(communicationRequests.occurrenceId, input.occurrenceId),
          cursorPredicate(input.cursor),
        ),
      )
      .orderBy(desc(messageIntents.createdAt), desc(messageIntents.intentId))
      .limit(limit + 1)
      .pipe(Effect.mapError(unavailable));
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const requestIds = [...new Set(page.map(({ requestId }) => requestId))];
    // one bounded set of statements for the whole page, never one per row
    const records = yield* loadRequestHistories(transaction, tenantId, requestIds).pipe(Effect.mapError(unavailable));
    const items = yield* Effect.forEach(
      page,
      (row) => {
        const request = records.get(row.requestId);
        const intent = request?.intents.find(({ intentId }) => intentId === row.intentId);
        // a request that is not readable, or is not of this exact scope, is an inconsistent store: never shown
        return request === undefined || intent === undefined || scopeKey(request.request.scope) !== key
          ? Effect.fail(unavailable())
          : projectItem(request, intent, options);
      },
      { concurrency: 1 },
    );
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        more && last !== undefined
          ? { createdAt: DateTime.fromDateUnsafe(last.createdAt), intentId: MessageIntentIdSchema.make(last.intentId) }
          : undefined,
    } satisfies MessageHistoryPage;
  });

  const detail = Effect.fn('Communications.messageHistoryDetail')(function* detailOf(
    intentId: string,
    options: ReadOptions,
  ) {
    yield* requireScopeWide(options.listAccess);
    const [row] = yield* transaction
      .select({ requestId: messageIntents.requestId })
      .from(messageIntents)
      .where(and(eq(messageIntents.tenantId, tenantId), eq(messageIntents.intentId, intentId)))
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* notFound();
    }
    const records = yield* loadRequestHistories(transaction, tenantId, [row.requestId]).pipe(
      Effect.mapError(unavailable),
    );
    const request = records.get(row.requestId);
    const intent = request?.intents.find((candidate) => candidate.intentId === intentId);
    if (request === undefined || intent === undefined) {
      return yield* notFound();
    }
    // the stored scope must be exactly the trusted one: another Legal Entity (or none) is the same answer as absent
    if (request.request.scope.legalEntityId !== scope.legalEntityId || request.request.scope.tenantId !== tenantId) {
      return yield* notFound();
    }
    if (!(yield* detailVisibleToCaller(request.request.scope))) {
      return yield* notFound();
    }
    return {
      message: yield* projectItem(request, intent, options),
      timeline: yield* projectTimeline(intent).pipe(Effect.mapError(unavailable)),
    } satisfies MessageHistoryDetailRecord;
  });

  return { detail, list };
});
