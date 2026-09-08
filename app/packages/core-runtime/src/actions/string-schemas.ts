import { Schema } from 'effect';

export const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const decodedStringBrand = <Brand extends string>(
  schema: Schema.String,
  brand: Brand
) => schema.pipe(Schema.brand(brand), Schema.decodeTo(Schema.String));

export const TargetModuleKeySchema = decodedStringBrand(
  nonEmptyString,
  'TargetModuleKey'
);
export const TargetResourceIdSchema = decodedStringBrand(
  nonEmptyString,
  'TargetResourceId'
);
