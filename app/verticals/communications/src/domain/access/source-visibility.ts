import type { CommunicationRequestScope } from '@app/communications-contracts/communication-request';
import { Context, Effect, Layer, Schema } from 'effect';

import { SourceScopeVisibilityUnavailable } from './source-visibility-errors.ts';

/**
 * Source-owner visibility of a request scope (#1409, ACC-02). Core's Current Permission decides whether the caller may read
 * Communications history of a Tenant and Legal Entity. When the history belongs to a narrower source scope (a profile, a
 * Counterparty or a Storefront), only that source's owner can say whether THIS caller may see facts about it, so
 * Communications asks again at every read and never remembers an answer. The answer is positive evidence: nothing but an
 * explicit `VISIBLE` lets a message through, and an owner that cannot answer is `SourceScopeVisibilityUnavailable`, never an
 * empty result and never a global fallback.
 */

export const SourceVisibilitySchema = Schema.Literals(['NOT_VISIBLE', 'VISIBLE']);
export type SourceVisibility = typeof SourceVisibilitySchema.Type;

export interface SourceVisibilityQuery {
  /** The trusted acting principal of the Read. The owner decides visibility for exactly this caller. */
  readonly principalId: string;
  /** The exact scope; each source reference names its own owning module, which is the owner that answers for it. */
  readonly scope: CommunicationRequestScope;
}

export interface SourceScopeVisibilityService {
  readonly check: (query: SourceVisibilityQuery) => Effect.Effect<SourceVisibility, SourceScopeVisibilityUnavailable>;
}

export class SourceScopeVisibility extends Context.Service<SourceScopeVisibility, SourceScopeVisibilityService>()(
  '@app/communications/domain/access/source-visibility/SourceScopeVisibility',
) {}

/**
 * A scope demands the source owner's visibility exactly when it names a source-owned reference. A request of a Tenant or a
 * Legal Entity alone has no narrower source scope and is governed by the Current Permission alone.
 */
export const scopeDemandsSourceVisibility = (scope: CommunicationRequestScope) =>
  scope.profileRef !== undefined || scope.counterpartyRef !== undefined || scope.storefrontRef !== undefined;

/**
 * The only production composition today: no source owner publishes a history visibility Read yet, so a source-scoped
 * history is refused as unavailable. It is explicit so nothing is ever shown by default or by a missing adapter.
 */
export const unavailableSourceScopeVisibilityLayer = Layer.succeed(SourceScopeVisibility, {
  check: () => Effect.fail(new SourceScopeVisibilityUnavailable({ reason: 'OWNER_UNAVAILABLE' })),
});
