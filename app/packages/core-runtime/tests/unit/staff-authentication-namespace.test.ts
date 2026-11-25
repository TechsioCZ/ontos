import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ProviderSubjectSchema } from '../../src/auth/principal-resolver.ts';
import { staffAuthenticationNamespaceRegistration } from '../../src/auth/staff-authentication-namespace.ts';

it.effect('registers staff bindings under the provider the staff resolver accepts', () =>
  Effect.gen(function* staffBindingProvider() {
    const registration = yield* staffAuthenticationNamespaceRegistration(['shell-super-app']);
    for (const subjectType of ['user', 'api_key'] as const) {
      const subject = yield* Schema.decodeUnknownEffect(ProviderSubjectSchema)({
        provider: registration.provider,
        providerSubjectId: 'staff-provider-subject',
        subjectType,
      });
      expect(subject.provider).toBe('better_auth');
      expect(subject.subjectType).toBe(subjectType);
    }
  }),
);
