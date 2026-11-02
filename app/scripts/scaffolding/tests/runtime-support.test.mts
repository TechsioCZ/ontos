import { expect, it } from 'effect-rstest';

import {
  governedActionSupport,
  governedDatabaseSupport,
  governedPgClientSupport,
  governedReadSupport,
  governedSupportImportOwner,
  governedSupportImports,
  isGovernedSupportLayer,
} from '../governed-contribution/runtime-support.mts';

it('recognizes exact read, Action and durable database support without losing required dependencies', () => {
  for (const layer of [governedReadSupport, governedActionSupport, governedDatabaseSupport, governedPgClientSupport]) {
    expect(isGovernedSupportLayer(layer)).toBe(true);
    const formatted = layer.replaceAll('),', '),\n  ').replaceAll('Live))', 'Live,))');
    expect(isGovernedSupportLayer(formatted)).toBe(true);
  }
});

it('rejects altered or broadened authentication support layers', () => {
  expect(isGovernedSupportLayer(governedDatabaseSupport.replace('DatabaseLive', 'UnapprovedLive'))).toBe(false);
  expect(isGovernedSupportLayer(governedPgClientSupport.replace('Reactivity.layer', 'Unknown.layer'))).toBe(false);
  expect(
    isGovernedSupportLayer(governedActionSupport.replace('governedActionRuntimeLive', 'foreignActionRuntimeLive')),
  ).toBe(false);
  expect(isGovernedSupportLayer(`${governedReadSupport}\n${governedDatabaseSupport}`)).toBe(false);
});

it('recognizes merged durable imports but rejects foreign bindings and altered modules', () => {
  const merged =
    "import { GatewayAssertionPgClientLive, GatewayAssertionRedemptionDatabaseLive, GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';";
  expect(governedSupportImportOwner(merged)).toBe(governedSupportImports[1]);
  expect(governedSupportImportOwner(merged.replace('PgClientLive,', 'UnknownLive,'))).toBeUndefined();
  expect(governedSupportImportOwner(merged.replace('/gateway-assertion-redemption.ts', '/foreign.ts'))).toBeUndefined();
});
