import { Schema } from 'effect';
import { PartyAliasWriteRejected } from '../merge-alias-resolution.ts';
import { PartyRelationshipCorrectionRequired } from './correction-required.ts';
import { PartyRelationshipEndpointNotFound } from './endpoint-not-found.ts';
import { PartyRelationshipEndpointTypeMismatch } from './endpoint-type-mismatch.ts';
import { PartyRelationshipInvalidInterval } from './invalid-interval.ts';
import { PartyRelationshipNotFound } from './not-found.ts';
import { PartyRelationshipOverlapConflict } from './overlap-conflict.ts';
import { PartyRelationshipPersistenceUnavailable } from './persistence-unavailable.ts';
import { PartyRelationshipRevisionConflict } from './revision-conflict.ts';
import { PartyRelationshipTypeUnsupported } from './type-unsupported.ts';

export { PartyRelationshipCorrectionRequired } from './correction-required.ts';
export { PartyRelationshipEndpointNotFound } from './endpoint-not-found.ts';
export { PartyRelationshipEndpointTypeMismatch } from './endpoint-type-mismatch.ts';
export { PartyRelationshipInvalidInterval } from './invalid-interval.ts';
export { PartyRelationshipNotFound } from './not-found.ts';
export { PartyRelationshipOverlapConflict } from './overlap-conflict.ts';
export { PartyRelationshipPersistenceUnavailable } from './persistence-unavailable.ts';
export { PartyRelationshipRevisionConflict } from './revision-conflict.ts';
export { PartyRelationshipTypeUnsupported } from './type-unsupported.ts';

export const PartyRelationshipMutationErrorSchema = Schema.Union([
  PartyAliasWriteRejected,
  PartyRelationshipNotFound,
  PartyRelationshipEndpointNotFound,
  PartyRelationshipEndpointTypeMismatch,
  PartyRelationshipTypeUnsupported,
  PartyRelationshipOverlapConflict,
  PartyRelationshipRevisionConflict,
  PartyRelationshipCorrectionRequired,
  PartyRelationshipInvalidInterval,
  PartyRelationshipPersistenceUnavailable,
]);
