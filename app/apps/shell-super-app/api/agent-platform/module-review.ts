/**
 * Asks a module's agent review read (declared in its MCP contribution) about stored proposals, as one person. The
 * module answers what only it knows (visibility, whether the person can carry the command out, before -> after
 * lines, undo plan, follow-up); the platform names no module and interprets no command.
 */
import { AgentProposalQueueModuleReview } from '@app/core-runtime';
import type { OperationalScopeRequest, TrustedPrincipalContext } from '@app/core-runtime';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';
import { AgentReviewResponseSchema } from '@app/shared-contracts/agent-review';
import type { AgentReviewItem, AgentReviewItemRequest, AgentReviewStage } from '@app/shared-contracts/agent-review';
import { Effect, Layer, Option, Result, Schema } from 'effect';

import type { McpModule } from '../mcp/catalog.ts';
import { callModuleAs } from './module-call.ts';
import type { ModuleCallOptions } from './module-call.ts';

/**
 * `none`: the module declares no review read (generic handling). `unavailable`: the read did not answer; modules
 * with private records then keep their proposals hidden.
 */
export type ModuleReview =
  | { readonly state: 'none' }
  | { readonly privateRecords: boolean; readonly state: 'unavailable' }
  | {
      readonly item: (key: string) => AgentReviewItem | undefined;
      readonly privateRecords: boolean;
      readonly seesAllRecords: boolean;
      readonly state: 'ok';
    };

export interface ReviewSubject {
  readonly actionSlug: string;
  readonly command: AgentCommand;
  readonly key: string;
  readonly proposal?: AgentReviewItemRequest['proposal'];
  readonly stage: AgentReviewStage;
}

const decodeResponse = Schema.decodeUnknownOption(AgentReviewResponseSchema);

const CHUNK = 300;

/** One review of `subjects` (any number, sent in chunks) by `module`, read as `principal`. */
export const reviewInModule = Effect.fn('AgentPlatform.reviewInModule')(function* reviewInModule(
  principal: TrustedPrincipalContext,
  module: Pick<McpModule, 'appId' | 'approvalReview'>,
  subjects: readonly ReviewSubject[],
  options: Pick<ModuleCallOptions, 'compositionRevision' | 'transport'> = {},
) {
  const review = module.approvalReview;
  if (review === undefined) {
    return { state: 'none' } satisfies ModuleReview;
  }
  const unavailable: ModuleReview = { privateRecords: review.privateRecords, state: 'unavailable' };
  const chunks =
    subjects.length === 0
      ? [[]]
      : Array.from({ length: Math.ceil(subjects.length / CHUNK) }, (_, index) =>
          subjects.slice(index * CHUNK, (index + 1) * CHUNK),
        );
  const responses = yield* Effect.forEach(
    chunks,
    (chunk) =>
      callModuleAs(
        principal,
        module.appId,
        review.path,
        {
          items: chunk.map(({ actionSlug, command, key, proposal, stage }) =>
            proposal === undefined
              ? { actionSlug, command, key, stage }
              : { actionSlug, command, key, proposal, stage },
          ),
        },
        options,
      ).pipe(Effect.result),
    { concurrency: 1 },
  );
  const decoded = responses.map((response) =>
    Result.isSuccess(response) && response.success.status === 200
      ? decodeResponse(response.success.body)
      : Option.none<typeof AgentReviewResponseSchema.Type>(),
  );
  if (decoded.some(Option.isNone)) {
    return unavailable;
  }
  const successful = decoded.flatMap(Option.toArray);
  const items = new Map(successful.flatMap((response) => response.items.map((item) => [item.key, item] as const)));
  return {
    item: (key: string) => items.get(key),
    privateRecords: review.privateRecords,
    seesAllRecords: successful.every((response) => response.seesAllRecords),
    state: 'ok',
  } satisfies ModuleReview;
});

/** Native visibility adapter. Core supplies the exact published route and the admission-pinned revision.
 * No simulated review, ambient correlation, scalar identity reconstruction, or private owner imports.
 */
type ReviewRequirements = Effect.Services<ReturnType<typeof reviewInModule>>;

/** The composition root closes the real review's dependencies; library code never locally provides an environment. */
export const AgentProposalQueueModuleReviewLive = (
  bindReview: <A, E>(
    program: Effect.Effect<A, E, ReviewRequirements>,
    transport: OperationalScopeRequest,
  ) => Effect.Effect<A, E>,
) =>
  Layer.succeed(AgentProposalQueueModuleReview, {
    review: (input) =>
      bindReview(
        reviewInModule(
          input.principal,
          { appId: input.appId, approvalReview: { path: input.path, privateRecords: true } },
          input.subjects,
          { compositionRevision: input.compositionRevision, transport: input.transport },
        ).pipe(
          Effect.map((review) =>
            review.state === 'ok'
              ? {
                  items: input.subjects.flatMap((subject) => {
                    const item = review.item(subject.key);
                    return item === undefined ? [] : [{ key: subject.key, visible: item.visible }];
                  }),
                  state: 'ok' as const,
                }
              : { items: [], state: 'unavailable' as const },
          ),
        ),
        input.transport,
      ),
  });

/** Reviews of subjects grouped by module app id (one call per module, at most three modules at once). */
export const reviewByModule = Effect.fn('AgentPlatform.reviewByModule')(function* reviewByModule(
  principal: TrustedPrincipalContext,
  modules: (appId: string) => Pick<McpModule, 'appId' | 'approvalReview'> | undefined,
  subjects: readonly (ReviewSubject & { readonly appId: string })[],
) {
  const grouped = new Map<string, ReviewSubject[]>();
  for (const subject of subjects) {
    grouped.set(subject.appId, [...(grouped.get(subject.appId) ?? []), subject]);
  }
  const reviews = yield* Effect.forEach(
    [...grouped],
    ([appId, list]) => {
      const module = modules(appId);
      return module === undefined
        ? Effect.succeed<readonly [string, ModuleReview]>([appId, { state: 'none' }])
        : reviewInModule(principal, module, list).pipe(Effect.map((review) => [appId, review] as const));
    },
    { concurrency: 3 },
  );
  return new Map(reviews);
});

/** The module's answer about one subject, undefined when the module has no review read or it did not answer. */
export const reviewedItem = (review: ModuleReview | undefined, key: string): AgentReviewItem | undefined =>
  review?.state === 'ok' ? review.item(key) : undefined;
