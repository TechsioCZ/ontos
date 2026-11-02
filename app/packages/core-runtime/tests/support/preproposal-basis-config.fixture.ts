// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Native proof child reads its private config and writes one protocol frame to fd 3 before any Effect layer exists; expires: 2027-03-31.
import { readFileSync, writeSync } from 'node:fs';
import { NodeRuntime } from '@effect/platform-node';
import { Effect, Schema } from 'effect';

import { parseSpiceDbConfig } from '../../src/permissions/config.ts';

const protocol = 'ontos.core.preproposal-basis.config.v1' as const;
const environmentSchema = Schema.Struct({
  SPICEDB_CA_CERT: Schema.optionalKey(Schema.String),
  SPICEDB_ENDPOINT: Schema.String,
  SPICEDB_PRESHARED_KEY: Schema.String,
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Schema.optionalKey(Schema.String),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const inputSchema = Schema.Struct({
  environment: environmentSchema,
  protocol: Schema.Literal(protocol),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

type CanonicalPermissionEnvironment = {
  -readonly [Key in keyof typeof environmentSchema.Type]: (typeof environmentSchema.Type)[Key];
};

/** Core owns the parser. Configuration and canonical output use only private fd4/fd3. */
const canonicalize = Effect.gen(function* canonicalizeAllocatedConfiguration() {
  const document = yield* Effect.try(() => readFileSync(4, 'utf-8'));
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(inputSchema), {
    onExcessProperty: 'error',
  })(document);
  const configuration = yield* parseSpiceDbConfig(input.environment);
  const environment: CanonicalPermissionEnvironment = {
    SPICEDB_ENDPOINT: configuration.endpoint,
    SPICEDB_PRESHARED_KEY: configuration.preSharedKey,
  };
  if (configuration.caCertificate !== undefined) {
    environment.SPICEDB_CA_CERT = configuration.caCertificate;
  }
  if (configuration.deploymentEnvironment !== undefined) {
    environment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT = configuration.deploymentEnvironment;
  }
  return { environment, protocol, type: 'canonical' as const };
});

const runCanonicalizer = canonicalize.pipe(
  Effect.matchCause({
    onFailure: () => ({ protocol, stage: 'configuration-invalid', type: 'failed' as const }),
    onSuccess: (result) => result,
  }),
  Effect.flatMap((result) => Effect.try(() => writeSync(3, `${JSON.stringify(result)}\n`))),
  // Never render a Cause: parser failures may contain private configuration.
  Effect.catchCause(() =>
    Effect.sync(() => {
      process.exitCode = 1;
    }),
  ),
);

if (process.argv.includes('--describe-preproposal-config')) {
  process.stdout.write(`${JSON.stringify({ operation: 'CANONICALIZE_PERMISSION_CONFIGURATION', protocol })}\n`);
} else if (process.argv.includes('--canonicalize-preproposal-config')) {
  NodeRuntime.runMain(runCanonicalizer);
}
