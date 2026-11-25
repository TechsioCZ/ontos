import type { CommunicationRequestScope } from '@app/communications-contracts/communication-request';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerExecutionError, ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { Array as EffectArray, DateTime, Effect, Option, Order, Schema } from 'effect';

import { CommunicationRequestIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { MESSAGE_HISTORY_MAX_PAGE_SIZE } from '../../shared/message-history-read.ts';
import type {
  MessageHistoryCursor,
  MessageHistoryItem,
  MessageHistoryRequestItem,
  MessageHistoryTimelineEntry,
} from '../../shared/message-history-read.ts';
import { MessageHistoryDetailByRequestSchema } from '../../shared/apis/message-history-detail.ts';
import type { MessageHistoryDetailRequest } from '../../shared/apis/message-history-detail.ts';
import type { MessageHistoryListRequest } from '../../shared/apis/message-history-list.ts';
import type { TemplateUseAudit } from '../../shared/template-revision.ts';
import { communicationDecisions, communicationRequests, messageIntents } from '../database/schema.ts';
import { scopeDemandsSourceVisibility, SourceScopeVisibility } from '../domain/access/source-visibility.ts';
import type { SourceScopeVisibilityUnavailable } from '../domain/access/source-visibility-errors.ts';
import { exactScopeOf } from '../domain/access/exact-scope.ts';
import { scopeKey } from '../domain/recipient/original-binding.ts';
import {
  hasRequestLevelRow,
  projectMessageHistoryItem,
  projectRequestHistoryItem,
  projectTimeline,
} from '../history/message-history-projection.ts';
import type { ProjectionOptions } from '../history/message-history-projection.ts';
import { loadRequestHistories } from './message-history.service.ts';
import type { IntentHistoryRecord, RequestHistoryRecord } from './message-history.service.ts';
import { postgresTemplateRevisionPort } from './template-revision.service.ts';
import { describeTemplateUse } from './template-revision-domain.service.ts';

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

export interface ReadOptions {
  /** Whether the caller may read the personal-data field group of the endpoint mask. */
  readonly includeEndpointMask: boolean;
  /** Whether the caller may read the field group of the template use audit (who activated the revision, when, why). Detail only. */
  readonly includeTemplateUse?: boolean | undefined;
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
  /** The request-level rows of the page: no-message decisions and unresolved slots. */
  readonly requests: readonly MessageHistoryRequestItem[];
}

export type MessageHistoryDetailRecord =
  | { readonly message: MessageHistoryItem; readonly timeline: readonly MessageHistoryTimelineEntry[] }
  | { readonly request: MessageHistoryRequestItem };

const isDetailByRequest = Schema.is(MessageHistoryDetailByRequestSchema);

const requireScopeWide = (filter: ListAccessPredicate | undefined) =>
  filter === undefined || filter.groups.length === 0 ? Effect.void : Effect.fail(unsupportedRowFilter());

/** The identity a cursor stands after: the intent of a message row, the request of a request-level row. */
const cursorIdOf = (cursor: MessageHistoryCursor) => ('intentId' in cursor ? cursor.intentId : cursor.requestId);

const cursorPredicate = (
  cursor: MessageHistoryCursor | undefined,
  at: typeof messageIntents.createdAt | typeof communicationDecisions.decidedAt,
  id: typeof messageIntents.intentId | typeof communicationDecisions.requestId,
) =>
  cursor === undefined
    ? undefined
    : sql`(${at}, ${id}) < (${DateTime.formatIso(cursor.createdAt)}::timestamptz, ${cursorIdOf(cursor)}::uuid)`;

/** A decision that has a request-level row: the catalog decided no message, or a slot stayed unresolved. */
const requestLevelDecision = or(
  eq(communicationDecisions.outcome, 'NO_MESSAGE'),
  sql`case when jsonb_typeof(${communicationDecisions.unresolvedSlots}) = 'array' then jsonb_array_length(${communicationDecisions.unresolvedSlots}) else 0 end > 0`,
);

/** One row of the merged page: a message (by its intent) or a request-level decision (by its request), newest first. */
interface PageRow {
  readonly at: DateTime.Utc;
  readonly id: string;
  readonly kind: 'intent' | 'request';
  readonly requestId: string;
}

/** Newest first, then by identity: the keyset order of both tables, so the merge of the two lists is the order of one. */
const newestFirst = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (row: PageRow) => DateTime.toEpochMillis(row.at)),
  Order.mapInput(Order.flip(Order.String), (row: PageRow) => row.id),
);

const cursorOf = ({ at, id, kind }: PageRow): MessageHistoryCursor =>
  kind === 'intent'
    ? { createdAt: at, intentId: MessageIntentIdSchema.make(id) }
    : { createdAt: at, requestId: CommunicationRequestIdSchema.make(id) };

const projectItem = (request: RequestHistoryRecord, intent: IntentHistoryRecord, options: ProjectionOptions) =>
  projectMessageHistoryItem(request, intent, options).pipe(Effect.mapError(unavailable));

/**
 * One row of a page as its safe item. A request that is not readable, or is not of this exact scope, or a message its request does
 * not hold, is an inconsistent store: never shown, and the page is unavailable.
 */
const projectPageRow = Effect.fnUntraced(function* projectRow(
  records: ReadonlyMap<string, RequestHistoryRecord>,
  key: string,
  row: PageRow,
  options: ReadOptions,
) {
  const request = records.get(row.requestId);
  if (request === undefined || scopeKey(request.request.scope) !== key) {
    return yield* unavailable();
  }
  if (row.kind === 'request') {
    return {
      item: yield* projectRequestHistoryItem(request).pipe(Effect.mapError(unavailable)),
      kind: 'request',
    } as const;
  }
  const intent = request.intents.find(({ intentId }) => intentId === row.id);
  if (intent === undefined) {
    return yield* unavailable();
  }
  return { item: yield* projectItem(request, intent, options), kind: 'message' } as const;
});

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
    const exact = exactScopeOf(scope, input.scope);
    // The source owners are asked before any row is read: an owner that cannot answer ends the Read, never an empty page.
    if (!(yield* listVisibleToCaller(exact))) {
      return yield* notFound();
    }
    const key = scopeKey(exact);
    const requestFilters = and(
      eq(communicationRequests.scopeKey, key),
      input.sourceModule === undefined ? undefined : eq(communicationRequests.sourceModule, input.sourceModule),
      input.purpose === undefined ? undefined : eq(communicationRequests.purpose, input.purpose),
      input.occurrenceId === undefined ? undefined : eq(communicationRequests.occurrenceId, input.occurrenceId),
    );
    const messageQuery = transaction
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
          requestFilters,
          cursorPredicate(input.cursor, messageIntents.createdAt, messageIntents.intentId),
        ),
      )
      .orderBy(desc(messageIntents.createdAt), desc(messageIntents.intentId))
      .limit(limit + 1);
    // the requests that have no message to list (no-message and unresolved decisions) are rows of the same history (#1402 H-01)
    const decisionQuery = transaction
      .select({ decidedAt: communicationDecisions.decidedAt, requestId: communicationDecisions.requestId })
      .from(communicationDecisions)
      .innerJoin(
        communicationRequests,
        and(
          eq(communicationDecisions.tenantId, communicationRequests.tenantId),
          eq(communicationDecisions.requestId, communicationRequests.requestId),
        ),
      )
      .where(
        and(
          eq(communicationDecisions.tenantId, tenantId),
          requestFilters,
          requestLevelDecision,
          cursorPredicate(input.cursor, communicationDecisions.decidedAt, communicationDecisions.requestId),
        ),
      )
      .orderBy(desc(communicationDecisions.decidedAt), desc(communicationDecisions.requestId))
      .limit(limit + 1);
    const { decisionRows, messageRows } = yield* Effect.all(
      { decisionRows: decisionQuery, messageRows: messageQuery },
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    const merged = EffectArray.sort(
      [
        ...messageRows.map(({ createdAt, intentId, requestId }): PageRow => ({
          at: DateTime.fromDateUnsafe(createdAt),
          id: intentId,
          kind: 'intent',
          requestId,
        })),
        ...decisionRows.map(({ decidedAt, requestId }): PageRow => ({
          at: DateTime.fromDateUnsafe(decidedAt),
          id: requestId,
          kind: 'request',
          requestId,
        })),
      ],
      newestFirst,
    );
    const more = merged.length > limit;
    const page = merged.slice(0, limit);
    const requestIds = [...new Set(page.map(({ requestId }) => requestId))];
    // one bounded set of statements for the whole page, never one per row
    const records = yield* loadRequestHistories(transaction, tenantId, requestIds).pipe(Effect.mapError(unavailable));
    const rows = yield* Effect.forEach(page, (row) => projectPageRow(records, key, row, options), { concurrency: 1 });
    const items = rows.flatMap((row) => (row.kind === 'message' ? [row.item] : []));
    const requests = rows.flatMap((row) => (row.kind === 'request' ? [row.item] : []));
    const last = page.at(-1);
    return {
      items,
      nextCursor: more && last !== undefined ? cursorOf(last) : undefined,
      requests,
    } satisfies MessageHistoryPage;
  });

  /**
   * The audit of the template the message used, only when its own field group is readable. A pin whose revision the store no
   * longer holds is left out, never guessed: the audit decorates the history and is not the history.
   */
  const templateUseOf = (
    intent: IntentHistoryRecord,
    options: ReadOptions,
  ): Effect.Effect<Option.Option<TemplateUseAudit>, ReadHandlerUnavailable> =>
    options.includeTemplateUse !== true || intent.template === undefined
      ? Effect.succeed(Option.none())
      : describeTemplateUse(postgresTemplateRevisionPort(transaction, scope), intent.template.pin).pipe(
          Effect.map(Option.some),
          Effect.catchTag('TemplateRevisionNotFound', () => Effect.succeed(Option.none())),
          Effect.mapError(unavailable),
        );

  /** The loaded request when it is of the caller's exact trusted scope and visible to the caller; absent and hidden are one answer. */
  const readableRequest = Effect.fn('Communications.readableHistoryRequest')(function* readable(requestId: string) {
    const records = yield* loadRequestHistories(transaction, tenantId, [requestId]).pipe(Effect.mapError(unavailable));
    const request = records.get(requestId);
    if (request === undefined) {
      return yield* notFound();
    }
    // the stored scope must be exactly the trusted one: another Legal Entity (or none) is the same answer as absent
    if (request.request.scope.legalEntityId !== scope.legalEntityId || request.request.scope.tenantId !== tenantId) {
      return yield* notFound();
    }
    if (!(yield* detailVisibleToCaller(request.request.scope))) {
      return yield* notFound();
    }
    return request;
  });

  const requestDetail = Effect.fn('Communications.messageHistoryRequestDetail')(function* requestDetailOf(
    requestId: string,
  ) {
    const request = yield* readableRequest(requestId);
    if (!hasRequestLevelRow(request)) {
      return yield* notFound();
    }
    return { request: yield* projectRequestHistoryItem(request).pipe(Effect.mapError(unavailable)) };
  });

  const detail = Effect.fn('Communications.messageHistoryDetail')(function* detailOf(
    input: MessageHistoryDetailRequest,
    options: ReadOptions,
  ) {
    yield* requireScopeWide(options.listAccess);
    if (isDetailByRequest(input)) {
      return (yield* requestDetail(input.requestId)) satisfies MessageHistoryDetailRecord;
    }
    const [row] = yield* transaction
      .select({ requestId: messageIntents.requestId })
      .from(messageIntents)
      .where(and(eq(messageIntents.tenantId, tenantId), eq(messageIntents.intentId, input.intentId)))
      .pipe(Effect.mapError(unavailable));
    if (row === undefined) {
      return yield* notFound();
    }
    const request = yield* readableRequest(row.requestId);
    const intent = request.intents.find((candidate) => candidate.intentId === input.intentId);
    if (intent === undefined) {
      return yield* notFound();
    }
    const templateUse = Option.getOrUndefined(yield* templateUseOf(intent, options));
    return {
      message: yield* projectItem(request, intent, { ...options, templateUse }),
      timeline: yield* projectTimeline(intent).pipe(Effect.mapError(unavailable)),
    } satisfies MessageHistoryDetailRecord;
  });

  return { detail, list };
});
