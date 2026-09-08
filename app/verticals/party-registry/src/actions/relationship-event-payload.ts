import { Effect, Schema } from 'effect';

import { PartyRelationshipLifecycleEventPayloadSchema } from '../../shared/domain/relationship-contract.ts';
import type { PartyRelationshipDetail } from '../../shared/domain/relationship-contract.ts';

export const encodeRelationshipEventPayload = (
  relationship: PartyRelationshipDetail
) =>
  Schema.encodeEffect(PartyRelationshipLifecycleEventPayloadSchema)({
    fromPartyRef: relationship.from.canonicalPartyRef,
    relationshipRef: relationship.relationshipRef,
    relationshipType: relationship.relationshipType,
    revision: relationship.revision,
    toPartyRef: relationship.to.canonicalPartyRef,
    validFrom: relationship.validFrom,
    validTo: relationship.validTo,
  }).pipe(Effect.orDie);
