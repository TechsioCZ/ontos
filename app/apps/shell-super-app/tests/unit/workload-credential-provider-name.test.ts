import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { workloadCredentialProviderName } from '../../api/auth/module-credential-provisioning.service.ts';

const workloads = [
  'party.registry.source-write',
  'party.registry.source-read',
  'privacy.core.source-processing-check',
  'privacy.core.organization-business-check',
  'privacy.core.organization-profile-ico-check',
];

it.effect(
  'reproduces the actual native provider rejection and issues the same workload with its bounded display name',
  () =>
    Effect.gen(function* workloadProviderNames() {
      const now = yield* DateTime.nowAsDate;
      const auth = betterAuth({
        baseURL: 'http://localhost:3000',
        database: memoryAdapter({
          account: [],
          apikey: [],
          session: [],
          user: [
            {
              createdAt: now,
              email: 'fixture@example.invalid',
              emailVerified: false,
              id: 'fixture-platform-owner',
              name: 'Fixture',
              updatedAt: now,
            },
          ],
          verification: [],
        }),
        logger: { disabled: true },
        plugins: [apiKey({ enableMetadata: true, references: 'user' })],
        secret: 'fixture-only-native-provider-validation-123456789',
      });
      yield* Effect.forEach(
        workloads,
        (workloadKey) =>
          Effect.gen(function* workloadProviderName() {
            const rejection = yield* Effect.tryPromise({
              catch: (cause) => cause,
              try: () =>
                auth.api.createApiKey({
                  body: { expiresIn: 86_400, name: `workload:${workloadKey}`, userId: 'fixture-platform-owner' },
                }),
            }).pipe(Effect.flip);
            expect(rejection).toMatchObject({ body: { code: 'INVALID_NAME_LENGTH' } });
            const name = workloadCredentialProviderName(workloadKey);
            const created = yield* Effect.promise(() =>
              auth.api.createApiKey({
                body: { expiresIn: 86_400, metadata: { workloadKey }, name, userId: 'fixture-platform-owner' },
              }),
            );
            expect(created.name).toBe(name);
            expect(created.metadata).toEqual({ workloadKey });
            expect(name.length).toBeLessThanOrEqual(32);
          }),
        { concurrency: 1 },
      );
    }),
);

it('preserves short existing names and distinguishes long workloads without changing their identity', () => {
  expect(workloadCredentialProviderName('demo.crm.party-intake')).toBe('workload:demo.crm.party-intake');
  const names = workloads.map(workloadCredentialProviderName);
  expect(new Set(names).size).toBe(workloads.length);
  expect(workloads.map(workloadCredentialProviderName)).toEqual(names);
});
