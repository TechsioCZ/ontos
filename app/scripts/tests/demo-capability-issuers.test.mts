import { readFileSync } from 'node:fs';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  demoCapabilityIssuerEntrypoints,
  gatewayContextAuthorizationEntrypoints,
} from '../../packages/shared-contracts/src/gateway-context.ts';
import {
  demoGatewayIssuerBindings,
  hasClassifiedDemoIssuers,
  hasMountedDemoIssuer,
  validateDemoCapabilityIssuers,
} from '../check-module-entrypoint-boundaries.mts';
import type { ProtectedEntrypointInventoryEntry } from '../authorization/protected-entrypoint-inventory.mts';

const SHELL_API_CONTRACT = 'apps/shell-super-app/shared/api.ts';
const SHELL_API_RUNTIME = 'apps/shell-super-app/api/index.ts';

const files = [
  'packages/shared-contracts/src/gateway-context.ts',
  'apps/shell-super-app/shared/document-gateway-api.ts',
  'apps/shell-super-app/shared/browser-api.ts',
  SHELL_API_CONTRACT,
  SHELL_API_RUNTIME,
] as const;
const workspace = new Map(
  files.map((file) => [file, readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8')] as const),
);
const withSource = (file: (typeof files)[number], change: (source: string) => string) =>
  new Map([...workspace, [file, change(workspace.get(file) ?? '')]]);
const [relay, documentGateway] = demoGatewayIssuerBindings;

it('classifies exactly the relay and the Shell document gateway batch issuer apart from main’s three', () => {
  expect(gatewayContextAuthorizationEntrypoints).toHaveLength(3);
  expect(hasClassifiedDemoIssuers(demoCapabilityIssuerEntrypoints)).toBe(true);
  expect(demoCapabilityIssuerEntrypoints.map(({ entrypointKey }) => entrypointKey)).toEqual(
    demoGatewayIssuerBindings.map(({ entrypointKey }) => entrypointKey),
  );
});

it('rejects a missing, duplicated, foreign or reclassified demo issuer', () => {
  // The Shell document context issues no assertion any more (the browser batch does), so two demo issuers remain.
  const [first, second] = demoCapabilityIssuerEntrypoints;
  expect(hasClassifiedDemoIssuers([first])).toBe(false);
  expect(hasClassifiedDemoIssuers([first, first])).toBe(false);
  expect(hasClassifiedDemoIssuers([first, gatewayContextAuthorizationEntrypoints[0]])).toBe(false);
  expect(
    hasClassifiedDemoIssuers([
      { ...first, authorization: { credential: 'session', kind: 'capability_issuance' } },
      second,
    ]),
  ).toBe(false);
  expect(hasClassifiedDemoIssuers([{ ...first, path: '/shell-super-app-api/auth/other' }, second])).toBe(false);
  expect(hasClassifiedDemoIssuers([{ ...first, owner: 'crm' }, second])).toBe(false);
});

it('proves every demo issuer is declared, added to the Shell API and mounted in this workspace', () => {
  for (const binding of demoGatewayIssuerBindings) {
    expect(hasMountedDemoIssuer(workspace, binding)).toBe(true);
  }
});

it('rejects a relay whose endpoint, Shell API membership or runtime handler group is missing', () => {
  if (relay === undefined || documentGateway === undefined) {
    throw new Error('expected two demo issuer bindings');
  }
  expect(
    hasMountedDemoIssuer(
      withSource('packages/shared-contracts/src/gateway-context.ts', (source) =>
        source.replace("'/auth/api-key/gateway-read'", "'/auth/api-key/other-read'"),
      ),
      relay,
    ),
  ).toBe(false);
  expect(
    hasMountedDemoIssuer(
      withSource(SHELL_API_CONTRACT, (source) =>
        source.replace('  .add(ShellBrowserApi.groups.apiKeyGatewayRead)\n', ''),
      ),
      relay,
    ),
  ).toBe(false);
  expect(
    hasMountedDemoIssuer(
      withSource(SHELL_API_CONTRACT, (source) =>
        source.replace(
          '  .add(ShellBrowserApi.groups.apiKeyGatewayRead)\n',
          '  .add(ShellBrowserApi.groups.apiKeyGatewayRead)\n  .add(ShellBrowserApi.groups.apiKeyGatewayRead)\n',
        ),
      ),
      relay,
    ),
  ).toBe(false);
  expect(
    hasMountedDemoIssuer(
      withSource(SHELL_API_RUNTIME, (source) =>
        source.replace(
          "HttpApiBuilder.group(ShellAuthenticationApi, 'apiKeyGatewayRead',",
          "HttpApiBuilder.group(OtherApi, 'apiKeyGatewayRead',",
        ),
      ),
      relay,
    ),
  ).toBe(false);
  expect(
    hasMountedDemoIssuer(
      withSource(SHELL_API_RUNTIME, (source) =>
        source.replaceAll("handle('readWithApiKeyGatewayContext'", "handle('readWithSomethingElse'"),
      ),
      relay,
    ),
  ).toBe(false);
  expect(
    hasMountedDemoIssuer(
      withSource('apps/shell-super-app/shared/document-gateway-api.ts', (source) =>
        source.replace("HttpApiGroup.make('documentGateway')", "HttpApiGroup.make('documentGatewayV2')"),
      ),
      documentGateway,
    ),
  ).toBe(false);
});

it.effect('records every demo issuer in the protected entrypoint inventory', () =>
  Effect.gen(function* demoIssuersInventoried() {
    const inventory: ProtectedEntrypointInventoryEntry[] = [];
    yield* validateDemoCapabilityIssuers(workspace, inventory);
    expect(inventory.map(({ entrypointKey }) => entrypointKey)).toEqual([
      'shell.gateway-read.issue.api-key',
      'shell.gateway-contexts.issue.session',
    ]);
  }),
);
