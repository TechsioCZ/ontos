import { Schema } from 'effect';

// A plain options object that is never a Schema field bag: not a contract, not reported.
const routeDefaults = {
  tenantId: Schema.String,
  groupKey: Schema.String,
};

export function describe(): readonly string[] {
  return Object.keys(routeDefaults);
}

// Annotations and metadata objects are not field bags either.
export const LabelSchema = Schema.String.annotate({
  identifier: 'Label',
  tenantId: Schema.String,
});
