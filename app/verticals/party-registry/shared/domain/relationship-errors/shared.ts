import { Schema } from 'effect';

export const RelationshipErrorBase = {
  reason: Schema.String,
} as const;

export const RelationshipEndpointSchema = Schema.Literals(['from', 'to']);

export const RelationshipErrorPartyTypeSchema = Schema.Literals(['PERSON', 'ORGANIZATION', 'UNRESOLVED']);

export const PositiveRelationshipRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
