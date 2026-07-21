import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coreReferenceRegistry,
  createCoreReferenceRegistry,
  registerCoreReferenceProvider,
} from '../../../packages/core-runtime/src/core-reference.ts';

const viewer = {
  principalId: 'principal-reader',
  tenantId: 'tenant-reader',
};

const provider = ({ moduleKey, targets }) => ({
  authorizeOpen: () => true,
  discover: ({ query }) =>
    targets.filter(
      ({ discoverable, label }) =>
        discoverable && label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ),
  moduleKey,
  open: () => Promise.resolve(),
  recognize: ({ source }) =>
    targets.find(({ deepLink, token }) =>
      source.type === 'deepLink' ? deepLink === source.value : token === source.value,
    ) ?? null,
  resolve: ({ reference }) =>
    targets.find(
      ({ entityId, entityType, targetTenantId }) =>
        entityId === reference.entityId &&
        entityType === reference.entityType &&
        targetTenantId === reference.targetTenantId,
    ) ?? null,
});

test('Core Reference federates provider-controlled discovery and rejects guessed raw IDs', async () => {
  const crmTarget = {
    deepLink: 'https://ontos.test/r/crm/customer/known',
    discoverable: true,
    entityId: 'customer-42',
    entityType: 'customer',
    label: 'Ada Customer',
    openRequest: { path: '/customers/customer-42' },
    targetTenantId: 'tenant-crm',
    token: 'crm:opaque:customer-42',
  };
  const propertyTarget = {
    deepLink: 'https://ontos.test/r/property/unit/known',
    discoverable: true,
    entityId: 'unit-7',
    entityType: 'unit',
    label: 'Ada Suite',
    openRequest: { path: '/units/unit-7' },
    targetTenantId: 'tenant-property',
    token: 'property:opaque:unit-7',
  };
  const hiddenTarget = {
    ...crmTarget,
    deepLink: 'https://ontos.test/r/crm/customer/hidden',
    discoverable: false,
    entityId: 'customer-hidden',
    label: 'Ada Hidden',
    token: 'crm:opaque:customer-hidden',
  };
  const registry = createCoreReferenceRegistry([
    provider({ moduleKey: 'crm', targets: [crmTarget, hiddenTarget] }),
    provider({ moduleKey: 'property-registry', targets: [propertyTarget] }),
  ]);

  const discovered = await registry.discover({ context: viewer, query: 'ada' });
  assert.deepEqual(
    discovered.map(({ label, ownerModuleKey, targetTenantId }) => ({
      label,
      ownerModuleKey,
      targetTenantId,
    })),
    [
      { label: 'Ada Customer', ownerModuleKey: 'crm', targetTenantId: 'tenant-crm' },
      {
        label: 'Ada Suite',
        ownerModuleKey: 'property-registry',
        targetTenantId: 'tenant-property',
      },
    ],
  );
  const [firstDiscovered] = discovered;
  assert.equal('openRequest' in firstDiscovered, false);

  const selected = await registry.insert({
    context: viewer,
    kind: 'mention',
    source: { type: 'opaqueToken', value: crmTarget.token },
  });
  assert.equal(selected._tag, 'CoreReferenceInserted');
  assert.deepEqual(selected.reference, {
    entityId: 'customer-42',
    entityType: 'customer',
    kind: 'mention',
    lastResolvedLabel: 'Ada Customer',
    ownerModuleKey: 'crm',
    targetTenantId: 'tenant-crm',
    token: 'crm:opaque:customer-42',
  });

  const forged = await registry.insert({
    context: viewer,
    kind: 'mention',
    source: { type: 'rawEntityId', value: crmTarget.entityId },
  });
  assert.deepEqual(forged, {
    _tag: 'CoreReferenceRejected',
    code: 'invalid_source',
  });
});

test('rename preserves identity and every open attempt asks the owning provider for authorization', async () => {
  const target = {
    deepLink: 'https://ontos.test/r/crm/customer/known',
    discoverable: true,
    entityId: 'customer-42',
    entityType: 'customer',
    label: 'Ada Customer',
    openRequest: { path: '/customers/customer-42' },
    targetTenantId: 'tenant-crm',
    token: 'crm:opaque:customer-42',
  };
  let authorized = false;
  let authorizationChecks = 0;
  let opened = 0;
  const crmProvider = {
    ...provider({ moduleKey: 'crm', targets: [target] }),
    authorizeOpen: () => {
      authorizationChecks += 1;
      return authorized;
    },
    open: () => {
      opened += 1;
    },
  };
  const registry = createCoreReferenceRegistry([crmProvider]);
  const inserted = await registry.insert({
    context: viewer,
    kind: 'relation',
    source: { type: 'opaqueToken', value: target.token },
  });
  assert.equal(inserted._tag, 'CoreReferenceInserted');
  const storedReference = structuredClone(inserted.reference);

  target.label = 'Ada Lovelace Customer';
  const renamed = await registry.resolve({ context: viewer, reference: storedReference });
  assert.deepEqual(renamed, {
    _tag: 'CoreReferenceActive',
    reference: {
      ...storedReference,
      lastResolvedLabel: 'Ada Lovelace Customer',
    },
  });
  assert.equal(renamed.reference.entityId, storedReference.entityId);

  assert.deepEqual(await registry.open({ context: viewer, reference: storedReference }), {
    _tag: 'CoreReferenceOpenDenied',
  });
  assert.deepEqual(await registry.open({ context: viewer, reference: storedReference }), {
    _tag: 'CoreReferenceOpenDenied',
  });
  assert.equal(authorizationChecks, 2);
  assert.equal(opened, 0);
  assert.deepEqual(inserted.reference, storedReference);

  authorized = true;
  assert.deepEqual(await registry.open({ context: viewer, reference: storedReference }), {
    _tag: 'CoreReferenceOpened',
  });
  assert.equal(authorizationChecks, 3);
  assert.equal(opened, 1);
});

test('deleted or unavailable targets fall back to their retained label and can reactivate', async () => {
  const target = {
    deepLink: 'https://ontos.test/r/crm/customer/known',
    discoverable: false,
    entityId: 'customer-42',
    entityType: 'customer',
    label: 'Ada Customer',
    openRequest: { path: '/customers/customer-42' },
    targetTenantId: 'tenant-crm',
    token: 'crm:opaque:customer-42',
  };
  let resolutionState = 'active';
  const crmProvider = {
    ...provider({ moduleKey: 'crm', targets: [target] }),
    resolve: () => {
      if (resolutionState === 'unavailable') {
        throw new Error('provider unavailable');
      }
      return resolutionState === 'deleted' ? null : target;
    },
  };
  const registry = createCoreReferenceRegistry([crmProvider]);
  const inserted = await registry.insert({
    context: viewer,
    kind: 'mention',
    source: { type: 'deepLink', value: target.deepLink },
  });
  assert.equal(inserted._tag, 'CoreReferenceInserted');
  const { reference } = inserted;

  resolutionState = 'deleted';
  assert.deepEqual(await registry.resolve({ context: viewer, reference }), {
    _tag: 'CoreReferenceFallback',
    reference,
  });
  assert.deepEqual(await registry.open({ context: viewer, reference }), {
    _tag: 'CoreReferenceOpenUnavailable',
  });

  resolutionState = 'unavailable';
  assert.deepEqual(await registry.resolve({ context: viewer, reference }), {
    _tag: 'CoreReferenceFallback',
    reference,
  });

  resolutionState = 'active';
  assert.deepEqual(await registry.resolve({ context: viewer, reference }), {
    _tag: 'CoreReferenceActive',
    reference,
  });
});

test('the shared Core registry exposes provider registration to consuming verticals', async () => {
  const target = {
    deepLink: 'https://ontos.test/r/crm/customer/registered',
    discoverable: true,
    entityId: 'customer-registered',
    entityType: 'customer',
    label: 'Registered Customer',
    openRequest: { path: '/customers/customer-registered' },
    targetTenantId: 'tenant-crm',
    token: 'crm:opaque:customer-registered',
  };
  const unregister = registerCoreReferenceProvider(
    provider({ moduleKey: 'crm-registration-test', targets: [target] }),
  );
  try {
    const inserted = await coreReferenceRegistry.insert({
      context: viewer,
      kind: 'mention',
      source: { type: 'opaqueToken', value: target.token },
    });
    assert.equal(inserted._tag, 'CoreReferenceInserted');
    assert.equal(inserted.reference.ownerModuleKey, 'crm-registration-test');
  } finally {
    unregister();
  }

  assert.deepEqual(
    await coreReferenceRegistry.insert({
      context: viewer,
      kind: 'mention',
      source: { type: 'opaqueToken', value: target.token },
    }),
    { _tag: 'CoreReferenceRejected', code: 'unknown_reference' },
  );
});
