import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

const shellDirectory = fileURLToPath(new URL('../../', import.meta.url));
const configPath = fileURLToPath(new URL('../../modern.config.ts', import.meta.url));
const BffPrefixSchema = Schema.fromJsonString(Schema.Union([Schema.String, Schema.Array(Schema.String)]));

const evaluateBffPrefix = (target: 'node' | 'cloudflare', enabled: boolean) => {
  const environment = {
    MODERNJS_DEPLOY: target,
    ONTOS_INTERNAL_SYMMY_INGRESS: enabled ? '1' : '0',
    ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: 'composition-kv-id',
    ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID: 'gateway-issuer-hyperdrive-id',
    ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'shared-runtime-hyperdrive-id',
    ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'spicedb-vpc-service-id',
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP: 'https://shell.example.test',
  };
  return Schema.decodeUnknownSync(BffPrefixSchema)(
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        `import { createRequire } from 'node:module';
Object.assign(process.env, ${JSON.stringify(environment)});
const require = createRequire(import.meta.url);
const appToolsRequire = createRequire(require.resolve('@modern-js/app-tools'));
const pluginRequire = createRequire(appToolsRequire.resolve('@modern-js/plugin'));
const { createJiti } = pluginRequire('jiti');
const jiti = createJiti(import.meta.url, { requireCache: false, interopDefault: true });
const loaded = jiti(${JSON.stringify(configPath)});
const config = loaded.default || loaded;
process.stdout.write(JSON.stringify(config.bff.prefix));`,
      ],
      { cwd: shellDirectory, encoding: 'utf-8' },
    ),
  );
};

it('adds the Symmy mount after the primary Shell BFF in the internal Node profile', () => {
  expect(evaluateBffPrefix('node', true)).toEqual(['/shell-super-app-api', '/api/symmy/v1']);
});

it('keeps the Symmy mount out of the ordinary Node and Cloudflare profiles', () => {
  expect(evaluateBffPrefix('node', false)).toBe('/shell-super-app-api');
  expect(evaluateBffPrefix('cloudflare', true)).toBe('/shell-super-app-api');
});
