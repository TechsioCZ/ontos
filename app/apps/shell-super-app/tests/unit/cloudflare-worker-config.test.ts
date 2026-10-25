import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { CloudflareWorkerDeployConfig } from '@modern-js/app-tools-extensions/config';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const modernConfigUrl = new URL('../../modern.config.ts', import.meta.url).href;

const WorkerConfigSchema = Schema.fromJsonString(
  Schema.Struct({
    hyperdrive: Schema.Array(Schema.Struct({ binding: Schema.String, id: Schema.String })),
    rootRoutes: Schema.Struct({
      metadata: Schema.Record(Schema.String, Schema.String),
      routes: Schema.Record(Schema.String, Schema.String),
    }),
  }),
);

// The Modern config reads its build environment at import time, so it is evaluated in a fresh Node process
// whose deploy environment is replaced by exactly the given variables before the import.
const evaluateWorkerConfig = (environment: Readonly<Record<string, string>>) =>
  Schema.decodeUnknownSync(WorkerConfigSchema)(
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        `for (const key of Object.keys(process.env)) {
  if (key.startsWith('ULTRAMODERN_') || key.startsWith('MODERNJS_')) delete process.env[key];
}
Object.assign(process.env, ${JSON.stringify(environment)});
const { default: config } = await import(${JSON.stringify(modernConfigUrl)});
process.stdout.write(JSON.stringify({
  hyperdrive: config.deploy.worker.wrangler.hyperdrive,
  rootRoutes: config.deploy.worker.rootRoutes,
}));`,
      ],
      { cwd: appRoot, encoding: 'utf-8' },
    ),
  );

const cloudflareEnvironment = {
  MODERNJS_DEPLOY: 'cloudflare',
  ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: 'composition-kv-id',
  ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID: 'gateway-issuer-hyperdrive-id',
  ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'shared-runtime-hyperdrive-id',
  ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'spicedb-vpc-service-id',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
  ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: 'https://shell.example.test',
};

it('binds the Shell Worker to the shared runtime and the gateway issuer Hyperdrive configs', () => {
  expect(evaluateWorkerConfig(cloudflareEnvironment).hyperdrive).toEqual([
    { binding: 'HYPERDRIVE', id: 'shared-runtime-hyperdrive-id' },
    { binding: 'GATEWAY_ISSUER_HYPERDRIVE', id: 'gateway-issuer-hyperdrive-id' },
  ]);
});

it('preserves the typed OAuth discovery and MCP origin-root routes in the Shell Worker config', () => {
  expect(evaluateWorkerConfig(cloudflareEnvironment).rootRoutes).toEqual({
    metadata: {
      '/.well-known/oauth-authorization-server': '/shell-super-app-api/oauth/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/shell-super-app-api/oauth':
        '/shell-super-app-api/oauth/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration': '/shell-super-app-api/oauth/.well-known/openid-configuration',
      '/.well-known/openid-configuration/shell-super-app-api/oauth':
        '/shell-super-app-api/oauth/.well-known/openid-configuration',
    },
    routes: {
      '/.well-known/oauth-protected-resource': '/shell-super-app-api/mcp-resource-metadata',
      '/.well-known/oauth-protected-resource/mcp': '/shell-super-app-api/mcp-resource-metadata',
      '/mcp': '/shell-super-app-api/mcp',
    },
  } satisfies NonNullable<CloudflareWorkerDeployConfig['rootRoutes']>);
});
