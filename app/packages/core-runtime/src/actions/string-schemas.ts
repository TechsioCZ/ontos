import { Schema } from 'effect';

export const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

// Effect 4 requires one literal brand key; the parameter keeps Schema.brand's own constraint.
export const decodedStringBrand = <Brand extends string>(
  schema: Schema.String,
  brand: Parameters<typeof Schema.brand<Brand>>[0],
) => schema.pipe(Schema.brand<Brand>(brand), Schema.decodeTo(Schema.String));

export const TargetModuleKeySchema = decodedStringBrand(nonEmptyString, 'TargetModuleKey');
export const TargetResourceIdSchema = decodedStringBrand(nonEmptyString, 'TargetResourceId');
