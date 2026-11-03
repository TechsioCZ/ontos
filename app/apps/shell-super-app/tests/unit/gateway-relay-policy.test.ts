import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { GatewayRelaySourceBindingSchema, permitsGatewayRelay } from '../../api/auth/gateway-relay-policy.ts';

const binding = {
  compositionRevision: 'a'.repeat(64),
  providerKeyId: 'source-key',
  sourceAppId: 'catalog',
  sourceBuildMarker: 'catalog-build',
};
const source = { aud: 'catalog', compositionRevision: 'a'.repeat(64), targetBuildMarker: 'catalog-build' };
const target = {
  audience: 'party-registry',
  compositionRevision: 'a'.repeat(64),
  operationKey: 'party.registry.api.party-detail',
};
it('permits only the authenticated configured source and its exact operation relationship', () => {
  expect(permitsGatewayRelay('source-key', binding, source, target)).toBe(true);
  expect(permitsGatewayRelay('another-key', binding, source, target)).toBe(false);
  expect(permitsGatewayRelay('source-key', binding, { ...source, targetBuildMarker: 'another-build' }, target)).toBe(
    false,
  );
  expect(
    permitsGatewayRelay('source-key', binding, source, {
      ...target,
      operationKey: 'party.registry.api.guest-party-resolution',
    }),
  ).toBe(false);
});
it('does not let a destination assertion become a source or silently change revision', () => {
  expect(permitsGatewayRelay('source-key', binding, { ...source, aud: 'party-registry' }, target)).toBe(false);
  expect(permitsGatewayRelay('source-key', binding, source, { ...target, compositionRevision: 'b'.repeat(64) })).toBe(
    false,
  );
});

const marketBinding = { ...binding, sourceAppId: 'commerce-market-catalog', sourceBuildMarker: 'market-build' };
const marketSource = { ...source, aud: marketBinding.sourceAppId, targetBuildMarker: marketBinding.sourceBuildMarker };

it('preserves Customer Context relationships without granting it Market retirement operations', () => {
  const customerBinding = { ...binding, sourceAppId: 'commerce-customer-context' };
  const customerSource = { ...source, aud: customerBinding.sourceAppId };
  expect(permitsGatewayRelay(binding.providerKeyId, customerBinding, customerSource, target)).toBe(true);
  expect(
    permitsGatewayRelay(binding.providerKeyId, customerBinding, customerSource, {
      ...target,
      audience: 'commerce-market-catalog',
      operationKey: 'commerce.market-catalog.api.eligible-market-tuples',
    }),
  ).toBe(true);
  expect(
    permitsGatewayRelay(binding.providerKeyId, customerBinding, customerSource, {
      ...target,
      audience: customerBinding.sourceAppId,
      operationKey: 'commerce.customer-context.reserve-market-retirement',
    }),
  ).toBe(false);
});

it('accepts an explicitly enrolled Market workload but rejects unknown deployment identities', () => {
  expect(Schema.is(GatewayRelaySourceBindingSchema)(marketBinding)).toBe(true);
  expect(Schema.is(GatewayRelaySourceBindingSchema)({ ...marketBinding, sourceAppId: 'arbitrary-owner' })).toBe(false);
});

it.each([
  ['storefront-registry', 'commerce.storefront-registry.api.current-storefront-application'],
  ['commerce-customer-context', 'commerce.customer-context.api.market-affected-use-assessment'],
  ['commerce-customer-context', 'commerce.customer-context.reserve-market-retirement'],
  ['commerce-customer-context', 'commerce.customer-context.api.market-retirement-reservation-recovery'],
])('permits enrolled Market to reach %s operation %s only with matching source authority', (audience, operationKey) => {
  const destination = { ...target, audience, operationKey };
  expect(permitsGatewayRelay(binding.providerKeyId, marketBinding, marketSource, destination)).toBe(true);
  expect(permitsGatewayRelay('other-key', marketBinding, marketSource, destination)).toBe(false);
  expect(permitsGatewayRelay(binding.providerKeyId, binding, marketSource, destination)).toBe(false);
  expect(
    permitsGatewayRelay(
      binding.providerKeyId,
      marketBinding,
      { ...marketSource, targetBuildMarker: 'other-build' },
      destination,
    ),
  ).toBe(false);
  expect(
    permitsGatewayRelay(binding.providerKeyId, marketBinding, marketSource, {
      ...destination,
      compositionRevision: 'b'.repeat(64),
    }),
  ).toBe(false);
});

it.each([
  ['party-registry', 'party.registry.api.party-detail'],
  ['storefront-registry', 'commerce.customer-context.reserve-market-retirement'],
  ['commerce-customer-context', 'commerce.storefront-registry.api.current-storefront-application'],
  ['commerce-customer-context', 'commerce.customer-context.api.market-subject-restrictions-current'],
  ['commerce-customer-context', '*'],
])('rejects Market relationship outside approval: %s / %s', (audience, operationKey) => {
  expect(
    permitsGatewayRelay(binding.providerKeyId, marketBinding, marketSource, { ...target, audience, operationKey }),
  ).toBe(false);
});
