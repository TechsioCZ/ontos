import { Schema } from 'effect';
import { PropertyRefSchema } from '../resources/property.ts';
import { UnitRefSchema } from '../resources/unit.ts';
import { AssetRefSchema } from '../resources/asset.ts';
import {
  AssetLifecycleSchema,
  PropertyLifecycleSchema,
  PropertyTextSchema,
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
    name: PropertyTextSchema,
  }),
  Schema.TaggedStruct('UpdateProperty', {
    address: PropertyTextSchema,
    name: PropertyTextSchema,
    note: Schema.toEncoded(Schema.OptionFromNullOr(Schema.String)),
    propertyRef: PropertyRefSchema,
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
]);
export type PropertyCommand = typeof PropertyCommandSchema.Type;
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
