#!/usr/bin/env node
/** Stage-only BUD-002 location repair through the existing governed AssetUpdate Action. */
import { createHash } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, Exit, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient } from 'effect/http';
import { OpsCommandSchema } from '../../verticals/facility-operations/shared/actions/apply-command.ts';
import { assetsCommandSchemas } from '../../verticals/facility-operations/shared/commands/assets.ts';
import { optionalField } from '../../verticals/facility-operations/shared/domain/common.ts';
import { AssetSchema, AssetsStateSchema } from '../../verticals/facility-operations/shared/domain/assets.ts';
import type { Asset, AssetsState } from '../../verticals/facility-operations/shared/domain/assets.ts';
import {
  RecordsRequestSchema,
  RecordsResponseSchema,
} from '../../verticals/facility-operations/shared/apis/records.ts';
import {
  PropertyRecordSchema,
  RecordsResponseSchema as PropertyRecordsSchema,
} from '../../verticals/property-portfolio/shared/apis/records.ts';
import type { RecordsResponse as PropertyRecords } from '../../verticals/property-portfolio/shared/apis/records.ts';
import { demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { connectSeedClient, DemoSeedError } from './seed-client.mts';

const origin = 'https://ontos-stage.web-revolution.cz';
const target = { legalEntityId: rentalDemoLegalEntityId, shellUrl: origin, tenantId: demoTenantId };
const fail = (reason: string) => new DemoSeedError({ reason });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const AssetRepairPlanSchema = Schema.Struct({
  asset: AssetSchema,
  company: Schema.Literal(rentalDemoLegalEntityId),
  otherStateDigest: Schema.String,
  property: PropertyRecordSchema,
  propertyRevision: Schema.Int,
  revision: Schema.Int,
  tenant: Schema.Literal(demoTenantId),
});
type AssetRepairPlan = typeof AssetRepairPlanSchema.Type;
export const assetRepairFingerprint = (plan: AssetRepairPlan) =>
  Schema.encodeEffect(Schema.fromJsonString(AssetRepairPlanSchema))(plan).pipe(Effect.map(hash));

export const selectAssetRepair = (assets: readonly Asset[], properties: PropertyRecords['properties']) =>
  Effect.gen(function* selectExactAsset() {
    const matches = assets.filter(
      (asset) => asset.inventoryNumber === 'BUD-002' && asset.name === 'Administrativní budova Riverside Office Park',
    );
    const destinations = properties.filter(
      (property) =>
        property.code === 'RIVERSIDE' &&
        property.name === 'Riverside Office Park' &&
        property.archive === undefined &&
        property.lifecycleState === 'ACTIVE' &&
        property.propertyRef.tenantId === demoTenantId &&
        property.legalEntityRef.resourceId === rentalDemoLegalEntityId,
    );
    const [asset] = matches;
    const [property] = destinations;
    if (
      matches.length !== 1 ||
      destinations.length !== 1 ||
      asset === undefined ||
      property === undefined ||
      asset.kind !== 'building' ||
      asset.archive !== undefined ||
      asset.status === 'disposed' ||
      asset.location?.kind !== 'property'
    ) {
      return yield* fail('Expected one active BUD-002 building and one active company-scoped Riverside property');
    }
    return { asset, property };
  });

export const assetRepairCommand = (asset: Asset, property: typeof PropertyRecordSchema.Type) =>
  Schema.decodeUnknownEffect(assetsCommandSchemas[1])({
    _tag: 'AssetUpdate',
    ...optionalField('accountingProduct', asset.accountingProduct),
    assetId: asset.id,
    category: asset.category,
    kind: asset.kind,
    location: {
      id: property.propertyRef.resourceId,
      kind: 'property',
      label: `${property.name} (${property.code})`,
    },
    name: asset.name,
    ...optionalField('note', asset.note),
    propertyId: property.propertyRef.resourceId,
    ...optionalField('responsible', asset.responsible),
    ...optionalField('serialNumber', asset.serialNumber),
  });
const isRepaired = (asset: Asset, property: typeof PropertyRecordSchema.Type) =>
  asset.propertyId === property.propertyRef.resourceId &&
  asset.location?.id === property.propertyRef.resourceId &&
  asset.location.kind === 'property' &&
  asset.location.label === `${property.name} (${property.code})`;
const otherStateDigest = (state: AssetsState, asset: Asset) =>
  Schema.encodeEffect(Schema.fromJsonString(AssetsStateSchema))({
    ...state,
    assets: state.assets.filter((item) => item.id !== asset.id),
  }).pipe(Effect.map(hash));
const stableAsset = (asset: Asset) => {
  const { location: _location, propertyId: _propertyId, updatedAt: _updatedAt, updatedBy: _updatedBy, ...rest } = asset;
  return rest;
};
const {
  location: _locationField,
  propertyId: _propertyIdField,
  updatedAt: _updatedAtField,
  updatedBy: _updatedByField,
  ...stableAssetFields
} = AssetSchema.fields;
const unchangedAssetFields = Schema.toEquivalence(Schema.Struct(stableAssetFields));

const run = (mode: 'plan' | 'apply' | 'verify', planPath: string, reviewed: Option.Option<string>) =>
  Effect.gen(function* repairStageAsset() {
    yield* Config.schema(Schema.Literal('stage'), 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
    yield* Config.schema(Schema.Literal(origin), 'ONTOS_PUBLIC_ORIGIN');
    const password = yield* Config.Redacted('ONTOS_AGENT_SETUP_PASSWORD');
    const fs = yield* FileSystem.FileSystem;
    const client = yield* connectSeedClient(target, 'management@najempark.demo', password);
    const readAssets = () =>
      client.call(
        'facility-operations',
        '/reads/records',
        RecordsRequestSchema,
        { agendas: ['assets'] },
        RecordsResponseSchema,
      );
    const before = yield* readAssets();
    const envelope = before.agendas.assets;
    if (envelope === undefined || !envelope.canWrite) {
      return yield* fail('The operator must have existing write access to the assets agenda');
    }
    const properties = yield* client.read('property-portfolio', PropertyRecordsSchema);
    const selected = yield* selectAssetRepair(envelope.state.assets, properties.properties);
    const plan: AssetRepairPlan = {
      ...selected,
      company: rentalDemoLegalEntityId,
      otherStateDigest: yield* otherStateDigest(envelope.state, selected.asset),
      propertyRevision: properties.revision,
      revision: envelope.revision,
      tenant: demoTenantId,
    };
    const fingerprint = yield* assetRepairFingerprint(plan);
    if (mode === 'plan') {
      yield* fs.writeFileString(
        planPath,
        yield* Schema.encodeEffect(Schema.fromJsonString(AssetRepairPlanSchema))(plan),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      return yield* Console.log({
        alreadyRepaired: isRepaired(selected.asset, selected.property),
        asset: selected.asset.inventoryNumber,
        fingerprint,
        from: selected.asset.location,
        mode,
        to: { id: selected.property.propertyRef.resourceId, label: selected.property.name },
      });
    }
    const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AssetRepairPlanSchema))(
      yield* fs.readFileString(planPath),
    );
    if (Option.isNone(reviewed) || reviewed.value !== (yield* assetRepairFingerprint(saved))) {
      return yield* fail('Exact reviewed asset-repair fingerprint required');
    }
    if (mode === 'apply' && !isRepaired(selected.asset, selected.property)) {
      if (fingerprint !== reviewed.value) {
        return yield* fail('Asset/property changed after review; no write performed');
      }
      yield* client.apply(
        'facility-operations',
        Schema.toEncoded(OpsCommandSchema),
        yield* assetRepairCommand(selected.asset, selected.property),
        envelope.revision,
      );
    }
    const after = (yield* readAssets()).agendas.assets;
    const actual = after?.state.assets.find((asset) => asset.id === saved.asset.id);
    if (
      after === undefined ||
      actual === undefined ||
      !isRepaired(actual, saved.property) ||
      !unchangedAssetFields(stableAsset(saved.asset), stableAsset(actual)) ||
      (yield* otherStateDigest(after.state, actual)) !== saved.otherStateDigest
    ) {
      return yield* fail('Repair or preservation verification failed; do not retry a write blindly');
    }
    return yield* Console.log({
      asset: actual.inventoryNumber,
      mode,
      otherFieldsAndRecordsPreserved: true,
      property: saved.property.name,
      propertyId: actual.propertyId,
      revision: after.revision,
    });
  }).pipe(Effect.scoped);
const command = Command.make(
  'siampark-assets-stage',
  {
    mode: Flag.Literals('mode', ['plan', 'apply', 'verify']),
    plan: Flag.String('plan'),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
  },
  ({ mode, plan, reviewed }) =>
    run(mode, plan, reviewed).pipe(
      Effect.tapError((failure) =>
        Console.error(
          Schema.is(DemoSeedError)(failure) ? failure.reason : 'Asset repair stopped; credentials withheld',
        ),
      ),
    ),
);
if (import.meta.main) {
  const exit = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
