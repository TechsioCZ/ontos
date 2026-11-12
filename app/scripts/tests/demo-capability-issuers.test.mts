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
const [relay, documentGateway, documentContext] = demoGatewayIssuerBindings;

it('classifies exactly the relay and the two Shell document session issuers apart from main’s three', () => {
  expect(gatewayContextAuthorizationEntrypoints).toHaveLength(3);
  expect(hasClassifiedDemoIssuers(demoCapabilityIssuerEntrypoints)).toBe(true);
  expect(demoCapabilityIssuerEntrypoints.map(({ entrypointKey }) => entrypointKey)).toEqual(
    demoGatewayIssuerBindings.map(({ entrypointKey }) => entrypointKey),
  );
});

it('rejects a missing, duplicated, foreign or reclassified demo issuer', () => {
  const [first, second, third] = demoCapabilityIssuerEntrypoints;
  expect(hasClassifiedDemoIssuers([first, second])).toBe(false);
  expect(hasClassifiedDemoIssuers([first, second, second])).toBe(false);
  expect(hasClassifiedDemoIssuers([first, second, gatewayContextAuthorizationEntrypoints[0]])).toBe(false);
  expect(
    hasClassifiedDemoIssuers([
      { ...first, authorization: { credential: 'session', kind: 'capability_issuance' } },
      second,
      third,
    ]),
  ).toBe(false);
  expect(hasClassifiedDemoIssuers([{ ...first, path: '/shell-super-app-api/auth/other' }, second, third])).toBe(false);
  expect(hasClassifiedDemoIssuers([{ ...first, owner: 'crm' }, second, third])).toBe(false);
});

it('proves every demo issuer is declared, added to the Shell API and mounted in this workspace', () => {
  for (const binding of demoGatewayIssuerBindings) {
    expect(hasMountedDemoIssuer(workspace, binding)).toBe(true);
  }
});

it('rejects a relay whose endpoint, Shell API membership or runtime handler group is missing', () => {
  if (relay === undefined || documentGateway === undefined || documentContext === undefined) {
    throw new Error('expected three demo issuer bindings');
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
      withSource('apps/shell-super-app/shared/browser-api.ts', (source) =>
        source.replace("HttpApiGroup.make('documentContext')", "HttpApiGroup.make('documentContextV2')"),
      ),
      documentContext,
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
      'shell.document-context.issue.session',
    ]);
  }),
);
