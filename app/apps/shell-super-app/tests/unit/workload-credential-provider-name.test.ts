import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { expect, it } from 'effect-rstest';

import { workloadCredentialProviderName } from '../../api/auth/module-credential-provisioning.service.ts';

const workloads = [
  'party.registry.source-write',
  'party.registry.source-read',
  'privacy.core.source-processing-check',
  'privacy.core.organization-business-check',
  'privacy.core.organization-profile-ico-check',
];

it('reproduces the actual native provider rejection and issues the same workload with its bounded display name', async () => {
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    secret: 'fixture-only-native-provider-validation-123456789',
    logger: { disabled: true },
    database: memoryAdapter({
      user: [
        {
          id: 'fixture-platform-owner',
          email: 'fixture@example.invalid',
          name: 'Fixture',
          emailVerified: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      apikey: [],
      session: [],
      account: [],
      verification: [],
    }),
    plugins: [apiKey({ enableMetadata: true, references: 'user' })],
  });
  for (const workloadKey of workloads) {
    await expect(
      auth.api.createApiKey({
        body: { userId: 'fixture-platform-owner', name: `workload:${workloadKey}`, expiresIn: 86400 },
      }),
    ).rejects.toMatchObject({ body: { code: 'INVALID_NAME_LENGTH' } });
    const name = workloadCredentialProviderName(workloadKey);
    const created = await auth.api.createApiKey({
      body: { userId: 'fixture-platform-owner', name, expiresIn: 86400, metadata: { workloadKey } },
    });
    expect(created.name).toBe(name);
    expect(created.metadata).toEqual({ workloadKey });
    expect(name.length).toBeLessThanOrEqual(32);
  }
});

it('preserves short existing names and distinguishes long workloads without changing their identity', () => {
  expect(workloadCredentialProviderName('demo.crm.party-intake')).toBe('workload:demo.crm.party-intake');
  const names = workloads.map(workloadCredentialProviderName);
  expect(new Set(names).size).toBe(workloads.length);
  expect(workloads.map(workloadCredentialProviderName)).toEqual(names);
});
