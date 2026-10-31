import { Schema } from 'effect';
import { PropertyRefSchema } from '../resources/property.ts';
import { UnitRefSchema } from '../resources/unit.ts';
import { AssetRefSchema } from '../resources/asset.ts';
import {
  AssetLifecycleSchema,
  PropertyLifecycleSchema,
  PropertyTextSchema,
  ResponsibleEmployeeIdsSchema,
  UnitLifecycleSchema,
} from '../apis/records.ts';
import { PropertyConflict } from './errors/property-conflict.ts';
import { PropertyNotFound } from './errors/property-not-found.ts';
import { PropertyIneligible } from './errors/property-ineligible.ts';
import { PropertyUnavailable } from './errors/property-unavailable.ts';

// Public contract extracted while adapting the generated apply-command Action.

export const PropertyCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateProperty', {
    address: PropertyTextSchema,
    code: PropertyTextSchema,
    lifecycleState: Schema.optionalKey(PropertyLifecycleSchema),
    name: PropertyTextSchema,
    // Command JSON distinguishes an omitted create default from an explicit null note.
    note: Schema.optionalKey(Schema.toEncoded(Schema.OptionFromNullOr(Schema.String))),
    propertyType: Schema.optionalKey(PropertyTextSchema),
    responsibleEmployeeIds: Schema.optionalKey(ResponsibleEmployeeIdsSchema),
    responsiblePerson: Schema.optionalKey(PropertyTextSchema),
  }),
  Schema.TaggedStruct('UpdateProperty', {
    address: PropertyTextSchema,
    lifecycleState: Schema.optionalKey(PropertyLifecycleSchema),
    name: PropertyTextSchema,
    note: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
    propertyRef: PropertyRefSchema,
    propertyType: Schema.optionalKey(PropertyTextSchema),
    responsibleEmployeeIds: Schema.optionalKey(ResponsibleEmployeeIdsSchema),
    responsiblePerson: Schema.optionalKey(PropertyTextSchema),
  }),
  Schema.TaggedStruct('ChangePropertyLifecycle', {
    lifecycleState: PropertyLifecycleSchema,
    propertyRef: PropertyRefSchema,
  }),
  Schema.TaggedStruct('CreateUnit', {
    capacity: Schema.toEncoded(Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
    code: PropertyTextSchema,
    name: PropertyTextSchema,
    propertyRef: PropertyRefSchema,
  }),
  Schema.TaggedStruct('UpdateUnit', {
    name: PropertyTextSchema,
    note: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
    unitRef: UnitRefSchema,
  }),
  Schema.TaggedStruct('ChangeUnitLifecycle', { lifecycleState: UnitLifecycleSchema, unitRef: UnitRefSchema }),
  /** Staff-only archive of a property that is not in operation; its units are retired and archived with it. */
  Schema.TaggedStruct('ArchiveProperty', { propertyRef: PropertyRefSchema, reason: PropertyTextSchema }),
  Schema.TaggedStruct('RestoreProperty', { propertyRef: PropertyRefSchema }),
  /** Staff-only archive of a retired unit. */
  Schema.TaggedStruct('ArchiveUnit', { reason: PropertyTextSchema, unitRef: UnitRefSchema }),
  Schema.TaggedStruct('RestoreUnit', { unitRef: UnitRefSchema }),
  Schema.TaggedStruct('CreateAsset', {
    category: PropertyTextSchema,
    code: PropertyTextSchema,
    name: PropertyTextSchema,
    propertyRef: PropertyRefSchema,
    unitRef: Schema.toEncoded(Schema.OptionFromNullOr(UnitRefSchema)),
  }),
  Schema.TaggedStruct('UpdateAsset', {
    assetRef: AssetRefSchema,
    category: PropertyTextSchema,
    name: PropertyTextSchema,
    serialNumber: Schema.toEncoded(Schema.OptionFromNullOr(PropertyTextSchema)),
  }),
  Schema.TaggedStruct('ChangeAssetLifecycle', { assetRef: AssetRefSchema, lifecycleState: AssetLifecycleSchema }),
]).pipe(Schema.toTaggedUnion('_tag'));
export type PropertyCommand = typeof PropertyCommandSchema.Type;
const StaffOnlyPropertyCommandSchema = Schema.Union([
  PropertyCommandSchema.cases.ArchiveProperty,
  PropertyCommandSchema.cases.ArchiveUnit,
  PropertyCommandSchema.cases.RestoreProperty,
  PropertyCommandSchema.cases.RestoreUnit,
]);
/** Archive commands change what every register shows, so only interactive staff sessions may run them. */
export const isStaffOnlyPropertyCommand = Schema.is(StaffOnlyPropertyCommandSchema);
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: PropertyCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({
  resourceRef: Schema.Union([PropertyRefSchema, UnitRefSchema, AssetRefSchema]),
  revision: Schema.Int,
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;

export { PropertyConflict } from './errors/property-conflict.ts';

export { PropertyNotFound } from './errors/property-not-found.ts';

export { PropertyIneligible } from './errors/property-ineligible.ts';

export { PropertyUnavailable } from './errors/property-unavailable.ts';
export const PropertyErrorSchema = Schema.Union([
  PropertyConflict,
  PropertyNotFound,
  PropertyIneligible,
  PropertyUnavailable,
]);
export type PropertyError = typeof PropertyErrorSchema.Type;
