import { Schema } from 'effect';

/**
 * The keys a registered gateway workload names. Schema-only, so the module manifest (which browser contract bundles
 * load) can declare registered-workload calls without loading the provenance runtime. Each is written out rather than
 * built by a shared helper so the data-factory proof can model the manifest that reaches it.
 */
export const DeclarationKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('GatewayWorkloadDeclarationKey'),
  Schema.decodeTo(Schema.String),
);
export const EntrypointKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('GatewayWorkloadEntrypointKey'),
  Schema.decodeTo(Schema.String),
);
export const JobKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('GatewayWorkloadJobKey'),
  Schema.decodeTo(Schema.String),
);
export const WorkloadKeySchema = Schema.NonEmptyString.pipe(
  Schema.brand('GatewayWorkloadKey'),
  Schema.decodeTo(Schema.String),
);
