import { Schema } from 'effect';
import {
  SourcePersonAdmissionReferenceSchema,
  SourcePersonAdmissionResponseSchema,
} from '@app/party-registry/apis/source-person-admission';

import { SourceCounterpartyAdmissionResponseSchema } from '@app/party-registry/apis/source-counterparty-admission';

export const CustomerProfilePartySourceReferenceSchema = SourcePersonAdmissionReferenceSchema;
export type CustomerProfilePartySourceReference = typeof CustomerProfilePartySourceReferenceSchema.Type;

export const CustomerProfileCurrentPersonAdmissionSchema = Schema.Struct({
  ...SourcePersonAdmissionResponseSchema.members[1].fields,
  sourceReference: CustomerProfilePartySourceReferenceSchema,
});
export type CustomerProfileCurrentPersonAdmission = typeof CustomerProfileCurrentPersonAdmissionSchema.Type;
export const CustomerProfileCurrentCounterpartyAdmissionSchema = Schema.Struct({
  ...SourceCounterpartyAdmissionResponseSchema.members[1].fields,
  sourceReference: CustomerProfilePartySourceReferenceSchema,
});
export type CustomerProfileCurrentCounterpartyAdmission = typeof CustomerProfileCurrentCounterpartyAdmissionSchema.Type;
export const CustomerProfileCurrentAdmissionSchema = Schema.Union([
  CustomerProfileCurrentPersonAdmissionSchema,
  CustomerProfileCurrentCounterpartyAdmissionSchema,
]);

const KeySchema = Schema.toEncoded(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(300),
    Schema.makeFilter((value) =>
      value.trim() === value ? undefined : 'must preserve one canonical nonblank source key',
    ),
  ).pipe(Schema.brand('CustomerProfileSourceKey')),
);
export const CustomerProfileSourceAuthoritySchema = Schema.Struct({
  issuer: KeySchema,
  mappingRevision: KeySchema,
  namespace: KeySchema,
  recordType: KeySchema,
  route: Schema.Struct({ id: KeySchema, revision: KeySchema }),
});
export const CustomerProfileSourceAssertionSchema = Schema.Struct({
  ...CustomerProfileSourceAuthoritySchema.fields,
  effectId: KeySchema,
  occurrenceId: KeySchema,
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(2_147_483_647)),
  recordId: KeySchema,
  revision: KeySchema,
});
export type CustomerProfileSourceAssertion = typeof CustomerProfileSourceAssertionSchema.Type;
export const CustomerProfileSourceEffectSchema = Schema.Struct({ effectId: KeySchema, replayed: Schema.Boolean });
