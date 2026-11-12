import { Schema } from 'effect';

import { decodedStringBrand } from '../actions/string-schemas.ts';

/**
 * The keys a registered gateway workload names. Schema-only, so the module manifest (which browser contract bundles
 * load) can declare registered-workload calls without loading the provenance runtime.
 */
export const DeclarationKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadDeclarationKey');
export const EntrypointKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadEntrypointKey');
export const JobKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadJobKey');
export const WorkloadKeySchema = decodedStringBrand(Schema.NonEmptyString, 'GatewayWorkloadKey');
