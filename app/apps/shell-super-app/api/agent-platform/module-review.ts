/**
 * Asks a module's agent review read (declared in its MCP contribution) about stored proposals, as one person. The
 * module answers what only it knows (visibility, whether the person can carry the command out, before -> after
 * lines, undo plan, follow-up); the platform names no module and interprets no command.
 */
import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';
import { AgentReviewResponseSchema } from '@app/shared-contracts/agent-review';
import type {
  AgentReviewItem,
  AgentReviewItemRequest,
  AgentReviewStage,
} from '@app/shared-contracts/agent-review';
import { Effect, Schema } from 'effect';

import type { McpCatalogModule } from '../mcp/catalog.ts';
import { callModuleAs } from './module-call.ts';

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
  module: Pick<McpCatalogModule, 'appId' | 'approvalReview'>,
  subjects: readonly ReviewSubject[],
) {
  const review = module.approvalReview;
  if (review === undefined) {
    return { state: 'none' } satisfies ModuleReview as ModuleReview;
  }
  const unavailable: ModuleReview = { privateRecords: review.privateRecords, state: 'unavailable' };
  const chunks =
    subjects.length === 0
      ? [[]]
      : Array.from({ length: Math.ceil(subjects.length / CHUNK) }, (_, index) =>
          subjects.slice(index * CHUNK, (index + 1) * CHUNK),
        );
  const items = new Map<string, AgentReviewItem>();
  let seesAllRecords = true;
  for (const chunk of chunks) {
    const response = yield* callModuleAs(principal, module.appId, review.path, {
      items: chunk.map(({ actionSlug, command, key, proposal, stage }) => ({
        actionSlug,
        command,
        key,
        stage,
        ...(proposal === undefined ? {} : { proposal }),
      })),
    }).pipe(Effect.result);
    if (response._tag === 'Failure' || response.success.status !== 200) {
      return unavailable;
    }
    const decoded = decodeResponse(response.success.body);
    if (decoded._tag === 'None') {
      return unavailable;
    }
    seesAllRecords &&= decoded.value.seesAllRecords;
    for (const item of decoded.value.items) {
      items.set(item.key, item);
    }
  }
  return {
    item: (key: string) => items.get(key),
    privateRecords: review.privateRecords,
    seesAllRecords,
    state: 'ok',
  } satisfies ModuleReview as ModuleReview;
});

/** Reviews of subjects grouped by module app id (one call per module, at most three modules at once). */
export const reviewByModule = Effect.fn('AgentPlatform.reviewByModule')(function* reviewByModule(
  principal: TrustedPrincipalContext,
  modules: (appId: string) => Pick<McpCatalogModule, 'appId' | 'approvalReview'> | undefined,
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
        ? Effect.succeed([appId, { state: 'none' } as ModuleReview] as const)
        : reviewInModule(principal, module, list).pipe(Effect.map((review) => [appId, review] as const));
    },
    { concurrency: 3 },
  );
  return new Map(reviews);
});

/** The module's answer about one subject, undefined when the module has no review read or it did not answer. */
export const reviewedItem = (review: ModuleReview | undefined, key: string): AgentReviewItem | undefined =>
  review?.state === 'ok' ? review.item(key) : undefined;
