import { Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { activationDecision, parseActivationInput } from '../activate-tenant-modules.mts';

const tenant = '0f8b6a4e-1d2c-4b3a-9e8f-7a6b5c4d3e2f';
const merchandise = 'demo.merchandise';
const tax = 'commerce.tax';
const market = 'commerce.market-catalog';
const keys = [merchandise, tax, market];

it('reads any Tenant and its ordered, unique module keys', () => {
  expect(parseActivationInput(tenant.toUpperCase(), ` ${merchandise},${tax} `)).toEqual(
    Result.succeed({ moduleKeys: [merchandise, tax], tenantId: tenant }),
  );
  expect(Result.isFailure(parseActivationInput('not-a-tenant', tax))).toBe(true);
  expect(Result.isFailure(parseActivationInput(tenant, `${tax},${tax}`))).toBe(true);
  expect(Result.isFailure(parseActivationInput(tenant, `${tax},`))).toBe(true);
});

it('activates only inactive modules, in order, and never replaces a held state', () => {
  const states = new Map([[tax, 'active']]);
  expect(activationDecision('apply', keys, states)).toEqual(Result.succeed([merchandise, market]));
  expect(activationDecision('verify', keys, states)).toEqual(
    Result.fail('not active: demo.merchandise, commerce.market-catalog'),
  );
  expect(activationDecision('verify', keys, new Map(keys.map((key) => [key, 'active'])))).toEqual(Result.succeed([]));
  expect(Result.isFailure(activationDecision('apply', keys, new Map([[merchandise, 'suspended']])))).toBe(true);
});
