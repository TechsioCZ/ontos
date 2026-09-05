// expect-count: 4
import { Schema as S } from 'effect';

// 1 (customerId) — spread field bag shared between union members / tagged errors.
const problemFields = {
  customerId: S.String,
  detail: S.String,
};

export class CustomerMissingError extends S.TaggedError<CustomerMissingError>()(
  'CustomerMissingError',
  problemFields,
) {}

// 2 (contactId) — TaggedError inline field bag.
export class ContactMissingError extends S.TaggedError<ContactMissingError>()('ContactMissingError', {
  contactId: S.String,
  detail: S.String,
}) {}

// 3 (unitId) — TaggedStruct field bag is the second argument.
export const UnitEvent = S.TaggedStruct('UnitEvent', {
  unitId: S.NonEmptyString,
  at: S.String,
});

// 4 (dic) — union member struct.
export const BusinessSchema = S.Union([
  S.Struct({ dic: S.String, vat: S.Boolean }),
  S.Struct({ vat: S.Boolean }),
]);

export const SpreadUse = S.Struct({ ...problemFields, title: S.String });
