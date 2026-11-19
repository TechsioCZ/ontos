import type { CommunicationRequestScope } from '@app/communications-contracts/communication-request';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { evaluateListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { RecordKeySchema } from '@app/core-runtime/access/ids';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import { CommunicationRequestIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
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
import { scopeKey } from '../domain/recipient/original-binding.ts';
import { projectMessageHistoryItem, projectTimeline } from '../history/message-history-projection.ts';
import { loadRequestHistory } from './message-history.service.ts';
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
  /** The owner's row filter of a row-scoped read, when the gate supplies one: applied to what the query matched. */
  readonly listAccess: ListAccessPredicate | undefined;
}

export interface MessageHistoryPage {
  readonly items: readonly MessageHistoryItem[];
  readonly nextCursor: MessageHistoryCursor | undefined;
}

export interface MessageHistoryDetailRecord {
  readonly message: MessageHistoryItem;
  readonly timeline: readonly MessageHistoryTimelineEntry[];
}

const visibleToRowFilter = (filter: ListAccessPredicate | undefined, intentId: string) =>
  filter === undefined ||
  evaluateListAccessPredicate(filter, { recordKey: RecordKeySchema.make(intentId), teamIds: [] });

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
   * True only when the source owners say the caller sees this scope; an owner that cannot say is an unavailable Read. A scope
   * without a source reference is governed by the Current Permission alone and no owner is asked.
   */
  const visibleToCaller = (requestScope: CommunicationRequestScope) =>
    scopeDemandsSourceVisibility(requestScope)
      ? visibility.check({ principalId, scope: requestScope }).pipe(
          Effect.mapError(unavailable),
          Effect.map((answer) => answer === 'VISIBLE'),
        )
      : Effect.succeed(true);

  const recordOf = (requestId: string) =>
    loadRequestHistory(transaction, tenantId, CommunicationRequestIdSchema.make(requestId)).pipe(
      Effect.mapError(unavailable),
    );

  const list = Effect.fn('Communications.listMessageHistory')(function* listPage(
    input: MessageHistoryListRequest,
    options: ReadOptions,
  ) {
    const limit = input.limit ?? MESSAGE_HISTORY_MAX_PAGE_SIZE;
    const exact = exactScopeOf(scope, input.scope ?? {});
    // The source owners are asked before any row is read: an owner that cannot answer ends the Read, never an empty page.
    if (!(yield* visibleToCaller(exact))) {
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
    // a request that is not readable, or is not of this exact scope, is an inconsistent store: never shown
    const records = new Map(
      yield* Effect.forEach(
        requestIds,
        (requestId) =>
          recordOf(requestId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(unavailable()),
                onSome: (record) =>
                  scopeKey(record.request.scope) === key
                    ? Effect.succeed([requestId, record] as const)
                    : Effect.fail(unavailable()),
              }),
            ),
          ),
        { concurrency: 1 },
      ),
    );
    const projected = yield* Effect.forEach(
      page,
      (row) => {
        const request = records.get(row.requestId);
        const intent = request?.intents.find(({ intentId }) => intentId === row.intentId);
        return request === undefined || intent === undefined
          ? Effect.fail(unavailable())
          : projectItem(request, intent, options).pipe(
              Effect.map((item) => (visibleToRowFilter(options.listAccess, row.intentId) ? [item] : [])),
            );
      },
      { concurrency: 1 },
    );
    const items = projected.flat();
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
    const [row] = yield* transaction
      .select({ requestId: messageIntents.requestId })
      .from(messageIntents)
      .where(and(eq(messageIntents.tenantId, tenantId), eq(messageIntents.intentId, intentId)))
      .pipe(Effect.mapError(unavailable));
    if (row === undefined || !visibleToRowFilter(options.listAccess, intentId)) {
      return yield* notFound();
    }
    const found = yield* recordOf(row.requestId);
    const request = Option.getOrUndefined(found);
    const intent = request?.intents.find((candidate) => candidate.intentId === intentId);
    if (request === undefined || intent === undefined) {
      return yield* notFound();
    }
    // the stored scope must be exactly the trusted one: another Legal Entity (or none) is the same answer as absent
    if (request.request.scope.legalEntityId !== scope.legalEntityId || request.request.scope.tenantId !== tenantId) {
      return yield* notFound();
    }
    if (!(yield* visibleToCaller(request.request.scope))) {
      return yield* notFound();
    }
    return {
      message: yield* projectItem(request, intent, options),
      timeline: yield* projectTimeline(intent).pipe(Effect.mapError(unavailable)),
    } satisfies MessageHistoryDetailRecord;
  });

  return { detail, list };
});
