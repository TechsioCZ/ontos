import { Effect, Schema } from 'effect';
import {
  EngagementProfileConflict,
  EngagementProfilePersistenceUnavailable,
  PartyRegistryReferenceUnavailable,
} from '../../shared/domain/engagement-profile.ts';

export const AttachEngagementError = Schema.Union([
  EngagementProfileConflict,
  EngagementProfilePersistenceUnavailable,
  PartyRegistryReferenceUnavailable,
]);

interface EngagementServices<Payload, Result> {
  readonly create: (
    payload: Payload,
  ) => Effect.Effect<Result, EngagementProfileConflict | EngagementProfilePersistenceUnavailable>;
  readonly validate: (
    payload: Payload,
  ) => Effect.Effect<void, EngagementProfileConflict | PartyRegistryReferenceUnavailable>;
}

export const handleAttachEngagement = Effect.fn('AttachEngagementAction.handle')(
  function* handleAttachEngagement<Payload, Result>(
    payload: Payload,
    context: { readonly services: EngagementServices<Payload, Result> },
  ) {
    yield* context.services.validate(payload);
    return yield* context.services.create(payload);
  },
);
