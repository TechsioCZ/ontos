import { Effect, Match, Random, Schema } from 'effect';
import type { Cause } from 'effect';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import { ProductIdSchema } from '../../../../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../../../../shared/domain/merchandise-model.ts';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';

/**
 * `conflict` is a stale revision (someone else changed the data); `rejected` is a business rule the
 * current state refuses, such as an issue larger than the stock on hand.
 */
const FailureReasonSchema = Schema.Literals(['conflict', 'forbidden', 'invalid', 'rejected', 'unavailable']);
export type FailureReason = typeof FailureReasonSchema.Type;

export type LoadOutcome =
  | { readonly ok: true; readonly response: RecordsResponse }
  | { readonly ok: false; readonly reason: FailureReason };

export type CommandOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly reason: FailureReason };

type RecordsFailure = Effect.Error<ReturnType<typeof executeRecords>>;
type CommandFailure = Effect.Error<ReturnType<typeof executeApplyCommand>>;

/** Effect-injected randomness for correlation and idempotency identifiers. */
const newId = Effect.map(
  Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 }),
  ([first, second, third]) => `merchandise:products:${first}:${second}:${third}`,
);

/** Maps the records read's typed problems onto the four UI outcomes. Anything unlisted reads as unavailable. */
const recordsReason = (error: RecordsFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('RecordsPolicyConflictProblem', (): FailureReason => 'conflict'),
    Match.tag('RecordsAuthenticationProblem', 'RecordsForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('RecordsInvalidProblem', 'RecordsPolicyProblem', (): FailureReason => 'invalid'),
    Match.tag('GatewayAuthenticationRequiredProblem', 'GatewayForbiddenProblem', (): FailureReason => 'forbidden'),
    Match.tag('GatewayAudienceInvalidProblem', (): FailureReason => 'invalid'),
    Match.tag('GatewayReloadRequiredProblem', 'DocumentCompositionRevisionError', (): FailureReason => 'conflict'),
    Match.tag(
      'RecordsNotFoundProblem',
      'RecordsUnavailableProblem',
      'RecordsInternalProblem',
      'GatewayRateLimitedProblem',
      'GatewayUnavailableProblem',
      'GatewayInternalProblem',
      'HttpClientError',
      'SchemaError',
      (): FailureReason => 'unavailable',
    ),
    Match.exhaustive,
  );

/** Maps the apply-command problems onto the UI outcomes. Anything unlisted reads as unavailable. */
const commandReason = (error: CommandFailure): FailureReason =>
  Match.value(error).pipe(
    Match.tag('ApplyCommandActionConflictProblem', (problem): FailureReason =>
      problem.code === 'merchandise_lifecycle_conflict' ? 'rejected' : 'conflict',
    ),
    Match.tag('ApplyCommandActionIneligibleProblem', (): FailureReason => 'rejected'),
    Match.tag(
      'ApplyCommandActionAuthenticationProblem',
      'ApplyCommandActionForbiddenProblem',
      (): FailureReason => 'forbidden',
    ),
    Match.tag('ApplyCommandActionInvalidProblem', (): FailureReason => 'invalid'),
    Match.orElse((): FailureReason => 'unavailable'),
  );

/** Full records read: products with derived stock, indicators, movements and the write capability. */
export const loadProducts = (onOutcome: (outcome: LoadOutcome) => void): void => {
  void browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((correlation) => executeRecords({}, correlation)),
      Effect.match({
        onFailure: (error): LoadOutcome => ({ ok: false, reason: recordsReason(error) }),
        onSuccess: (response): LoadOutcome => ({ ok: true, response }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

/** One command against the single merchandise apply-command action. Each call gets its own idempotency key. */
export const runCommand = (
  command: MerchandiseCommand,
  expectedRevision: number,
  onOutcome: (outcome: CommandOutcome) => void,
): void => {
  void browserRuntime.runPromise(
    newId.pipe(
      Effect.flatMap((idempotencyKey) =>
        executeApplyCommand({ command, expectedRevision }, idempotencyKey, { idempotencyKey }),
      ),
      Effect.match({
        onFailure: (error): CommandOutcome => ({ ok: false, reason: commandReason(error) }),
        onSuccess: (result): CommandOutcome => ({ ok: true, revision: result.revision }),
      }),
      Effect.map(onOutcome),
    ),
  );
};

export type ProductDetailSnapshot =
  | { readonly status: 'loading' }
  | { readonly status: 'invalid' }
  | { readonly status: 'not-found' }
  | { readonly reason: FailureReason; readonly status: 'error' }
  | {
      readonly product: ProductRecord;
      readonly refreshFailure?: FailureReason;
      readonly response: RecordsResponse;
      readonly status: 'ready';
    };

/** One route lifetime, no global cache. React subscribes at its framework edge; stale reads cannot replace a newer result. */
export const createProductDetailQuery = (routeId: string, read = loadProducts) => {
  const validId = Schema.is(ProductIdSchema)(routeId);
  const initial: ProductDetailSnapshot = validId ? { status: 'loading' } : { status: 'invalid' };
  let snapshot: ProductDetailSnapshot = initial;
  let generation = 0;
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (next: ProductDetailSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const reload = () => {
    if (!validId || listeners.size === 0) {
      return;
    }
    started = true;
    generation += 1;
    const requestedGeneration = generation;
    read((outcome) => {
      if (requestedGeneration !== generation || listeners.size === 0) {
        return;
      }
      if (!outcome.ok) {
        publish(
          snapshot.status === 'ready' && outcome.reason !== 'forbidden'
            ? { ...snapshot, refreshFailure: outcome.reason }
            : { reason: outcome.reason, status: 'error' },
        );
        return;
      }
      const product = outcome.response.products.find((entry) => entry.id === routeId);
      publish(
        product === undefined ? { status: 'not-found' } : { product, response: outcome.response, status: 'ready' },
      );
    });
  };
  return {
    getServerSnapshot: () => initial,
    getSnapshot: () => snapshot,
    reload,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!started) {
        reload();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1;
          started = false;
        }
      };
    },
  };
};

export const productNavigationFailureKey = Match.type<Cause.TimeoutError | Cause.UnknownError>().pipe(
  Match.tag('TimeoutError', () => 'messages.navigationTimeout'),
  Match.tag('UnknownError', () => 'messages.failed'),
  Match.exhaustive,
);
