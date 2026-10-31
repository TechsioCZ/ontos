import { expect, it } from 'effect-rstest';
import { permitsGatewayRelay } from '../../api/auth/gateway-relay-policy.ts';

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
