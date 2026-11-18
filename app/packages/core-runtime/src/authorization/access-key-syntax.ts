import { Schema } from 'effect';

/**
 * Lowercase kebab segments `<module>.<resource>.<verb>[.<qualifier>]`; module IDs may be dotted. The key grammar alone,
 * for authored descriptors that still carry the key as a plain string. Schema-only, so module contracts (which browser
 * bundles load) can validate keys without loading the authorization runtime.
 */
export const AccessKeySyntaxSchema = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){2,}$/u),
);

/** A workload key: dotted lowercase kebab segments. */
export const WorkloadKeySchema = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/u),
).pipe(Schema.brand('WorkloadKey'));
