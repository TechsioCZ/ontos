import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessDeclaration, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import {
  accessAmountAt,
  capabilityPolicyOf,
  gateAmountOf,
  gateScopeOf,
} from '../../src/access/enforcement/capability.ts';
import { LegalEntityIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId } from '../../src/access/ids.ts';
import { person, tenant } from './access-decision-support.ts';

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const legalEntityId = LegalEntityIdSchema.make(uid(50));

const ACTION_OWNER = {
  access: 'write',
  authorization: { kind: 'protected' },
  moduleKey: 'finance',
  role: 'action',
} as const;
const READ_OWNER = {
  access: 'read',
  authorization: { kind: 'protected' },
  moduleKey: 'party.registry',
  role: 'api',
} as const;

const actionDeclaration = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'finance.invoice.void',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'finance', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
      ...overrides,
    },
    ACTION_OWNER,
  );

const readDeclaration = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'party.registry.party.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'parties', level: 'basic' },
      risk: 'routine',
      selectors: ['assigned'],
      ...overrides,
    },
    READ_OWNER,
  );

const scopeFor = (selected?: LegalEntityId) => {
  const trusted = Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(71),
    authContextRef: 'session-enforcement-capability',
    authMethod: 'session',
    principalId: person,
    tenantId: tenant,
  });
  return selected === undefined
    ? { ...trusted, correlationId: 'access-enforcement-capability' }
    : { ...trusted, correlationId: 'access-enforcement-capability', legalEntityId: selected };
};

it('mirrors the declaration as the capability policy the engine is given', () => {
  const policy = capabilityPolicyOf(actionDeclaration());
  expect(policy.capabilityKey).toBe('finance.invoice.void');
  expect(policy.kind).toBe('action');
  expect(policy.risk).toBe('sensitive');
  expect(policy.modes).toEqual(['run', 'propose', 'approve']);
  expect(policy.selectors).toEqual([]);
  // A declaration that names neither stays without the key, so no ceiling or class is invented.
  expect(Object.hasOwn(policy, 'ephemeral')).toBe(false);
  expect(Object.hasOwn(policy, 'fieldClass')).toBe(false);
});

it('carries the field class and the ephemeral proof of the declaration', () => {
  expect(capabilityPolicyOf(actionDeclaration({ ephemeral: true, modes: ['run'], risk: 'critical' })).ephemeral).toBe(
    true,
  );
  const fieldRead = readDeclaration({ fieldClass: 'margins', kind: 'field_read', risk: 'sensitive' });
  expect(capabilityPolicyOf(fieldRead).fieldClass).toBe('margins');
});

it('reads one scalar money value from the declared amount path', () => {
  const payload = { priceChange: { amount: { currency: 'CZK', minor: 125_000 } } };
  expect(accessAmountAt(payload, 'priceChange.amount')).toEqual({ currency: 'CZK', minor: 125_000 });
  expect(accessAmountAt(payload, 'priceChange')).toBeUndefined();
});

it('refuses an amount that is not exactly one positive integer in minor units', () => {
  expect(accessAmountAt({ amount: { currency: 'CZK', minor: -1 } }, 'amount')).toBeUndefined();
  expect(accessAmountAt({ amount: { currency: 'CZK', minor: 1.5 } }, 'amount')).toBeUndefined();
  expect(accessAmountAt({ amount: { currency: 'czk', minor: 1 } }, 'amount')).toBeUndefined();
  expect(accessAmountAt({ amount: { currency: 'CZK', minor: '1' } }, 'amount')).toBeUndefined();
  expect(accessAmountAt({ amount: 'CZK 1' }, 'amount')).toBeUndefined();
  expect(accessAmountAt({ amount: null }, 'amount')).toBeUndefined();
  expect(accessAmountAt('not a payload', 'amount')).toBeUndefined();
  expect(accessAmountAt({}, 'amount')).toBeUndefined();
});

it('governs the amount the declaration names and nothing otherwise', () => {
  const governed = actionDeclaration({ amountInput: 'total.amount' });
  expect(gateAmountOf(governed, { total: { amount: { currency: 'EUR', minor: 900 } } })).toEqual({
    currency: 'EUR',
    minor: 900,
  });
  expect(gateAmountOf(actionDeclaration(), { total: { amount: { currency: 'EUR', minor: 900 } } })).toBeUndefined();
  // A malformed value yields no amount, which the engine refuses whenever a ceiling applies.
  expect(gateAmountOf(governed, { total: { amount: { currency: 'EUR' } } })).toBeUndefined();
});

it('decides a company-owned capability in the legal entity the request selected', () => {
  const scope = gateScopeOf('required', scopeFor(legalEntityId));
  expect(scope.legalEntityId).toBe(legalEntityId);
  expect(scope.refusal).toBeUndefined();
});

it('refuses a required company scope the request did not select', () => {
  const scope = gateScopeOf('required', scopeFor());
  expect(scope.legalEntityId).toBeUndefined();
  expect(scope.refusal?.code).toBe('deny.scope_mismatch');
});

it('decides an explicit company admin key in the selected company and tenant administration in the tenant', () => {
  // O88: an operation on one company's data or roles names its target company, so a company access
  // administrator is decided inside that company. Administration that names no company stays in the
  // tenant context and needs no company selection (O28).
  expect(gateScopeOf('required', scopeFor(legalEntityId)).legalEntityId).toBe(legalEntityId);
  expect(gateScopeOf('required', scopeFor()).refusal?.code).toBe('deny.scope_mismatch');
  expect(gateScopeOf('optional', scopeFor(legalEntityId)).legalEntityId).toBeUndefined();
});

it('runs an optional or forbidden company scope in the tenant context', () => {
  expect(gateScopeOf('optional', scopeFor(legalEntityId)).legalEntityId).toBeUndefined();
  expect(gateScopeOf('forbidden', scopeFor(legalEntityId)).legalEntityId).toBeUndefined();
});

const PAGE_OWNER = {
  access: 'read',
  authorization: { kind: 'protected' },
  moduleKey: 'shell-super-app',
  role: 'page',
} as const;

const adminPageDeclaration = (overrides: Partial<AccessDeclarationInput> = {}): AccessDeclaration =>
  decodeAccessDeclarationOrThrow(
    {
      key: 'shell-super-app.access-admin.people',
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'access', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
      ...overrides,
    },
    PAGE_OWNER,
  );

it('carries the administration surface marker of a page and invents it for no other declaration (O88)', () => {
  // The marker reaches the engine only through the declaration the descriptor was validated with.
  expect(capabilityPolicyOf(adminPageDeclaration({ admitsAdminSurface: true })).admitsAdminSurface).toBe(true);
  // A page without it, and every non-page carrier, stays a plain capability policy.
  expect(Object.hasOwn(capabilityPolicyOf(adminPageDeclaration()), 'admitsAdminSurface')).toBe(false);
  expect(Object.hasOwn(capabilityPolicyOf(readDeclaration()), 'admitsAdminSurface')).toBe(false);
  expect(Object.hasOwn(capabilityPolicyOf(actionDeclaration()), 'admitsAdminSurface')).toBe(false);
});
