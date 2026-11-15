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

/** Where a unit's receipt and keep proof live, relative to the unit's directory. */
export const RECEIPT = 'dist/.gates-output-cache.json';
export const KEEP_PROOF = 'dist/.gates-keep-proof.json';
/**
 * Written by the gates plan when it keeps a unit: the plan has just proved, for this run's HEAD, that the unit's
 * committed inputs are the ones its receipt was stamped with. A native fixture that runs the checkout's sources under
 * the kept unit's identity relies on this file instead of recomputing that digest (which would make the deploy
 * planner part of every fixture, and so of the Shell's identity). Like the receipt, it is not part of the outputs.
 */
export const KeepProofSchema = Schema.Struct({
  inputs: DIGEST,
  revision: REVISION,
  schemaVersion: Schema.Literal(1),
  unit: NONEMPTY,
});
export type KeepProof = typeof KeepProofSchema.Type;
