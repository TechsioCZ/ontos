/**
 * The gates unit output cache's receipt (`dist/.gates-output-cache.json`) and the identity it records. Kept free of
 * imports beyond Effect: native test fixtures read receipts through scripts/ci/kept-unit-identity.mts, and every
 * package's test bundler compiles what they import.
 */
import { Schema } from 'effect';

export const DIGEST = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const NONEMPTY = Schema.String.check(Schema.isMinLength(1));
export const REVISION = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
export const IdentitySchema = Schema.Struct({
  appId: NONEMPTY.pipe(Schema.brand('UnitOutputAppId'), Schema.decodeTo(Schema.String)),
  build: NONEMPTY,
  buildMarker: NONEMPTY,
  sourceRevision: REVISION,
});
export type CacheIdentity = typeof IdentitySchema.Type;
export const OutputFileSchema = Schema.Struct({
  /** A relative symlink's target, kept as a link: its sha256 and size describe the target text. */
  link: Schema.optionalKey(NONEMPTY),
  mode: Schema.Number,
  path: NONEMPTY,
  sha256: DIGEST,
  size: Schema.Number,
});
export type OutputFile = typeof OutputFileSchema.Type;
export const CacheReceiptSchema = Schema.Struct({
  digest: DIGEST,
  files: Schema.Array(OutputFileSchema),
  identity: IdentitySchema,
  /**
   * The unit's committed-inputs digest at the commit it was built from (unitIdentity in delivery-plan.mts, without
   * build variables). A test that bundles the checkout's sources under a kept unit's identity proves with it that
   * those sources are the ones the unit was built from (scripts/ci/kept-unit-identity.mts).
   */
  inputs: DIGEST,
  schemaVersion: Schema.Literal(2),
  unit: NONEMPTY,
});
export type CacheReceipt = typeof CacheReceiptSchema.Type;
