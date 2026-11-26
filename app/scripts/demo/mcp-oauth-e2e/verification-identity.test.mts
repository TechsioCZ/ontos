import { ConfigProvider, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CANONICAL_VERIFICATION_IDENTITY,
  loadVerificationIdentity,
  verificationWhoamiHolds,
} from './verification-identity.mts';

const stable = {
  E2E_VERIFICATION_LEGAL_ENTITY_ID: '0b6a3d1e-2f44-4c1a-9d1e-7a0d7e5b1c21',
  E2E_VERIFICATION_PERSONA: 'verification@stable.example.cz',
  E2E_VERIFICATION_PRINCIPAL_ID: '5f1c2b3a-6d7e-4f80-9a1b-2c3d4e5f6a70',
};
const read = (env: Record<string, string>) =>
  loadVerificationIdentity.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))));

it.effect('the verification identity is the canonical CI tenant unless a deployment configures all of it', () =>
  Effect.gen(function* verificationIdentitySettings() {
    expect(yield* read({})).toEqual(CANONICAL_VERIFICATION_IDENTITY);
    expect(CANONICAL_VERIFICATION_IDENTITY).toEqual({
      legalEntityId: '71000000-0000-4000-8000-000000000090',
      persona: 'verification@ci.ontos',
      principalId: '72000000-0000-4000-8000-000000000090',
    });
    expect(yield* read(stable)).toEqual({
      legalEntityId: stable.E2E_VERIFICATION_LEGAL_ENTITY_ID,
      persona: stable.E2E_VERIFICATION_PERSONA,
      principalId: stable.E2E_VERIFICATION_PRINCIPAL_ID,
    });
    // A partial identity would pair one deployment's persona with another's principal: refused, not completed.
    const { E2E_VERIFICATION_PRINCIPAL_ID: _omitted, ...partial } = stable;
    expect(Exit.isFailure(yield* Effect.exit(read(partial)))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(read({ ...stable, E2E_VERIFICATION_PRINCIPAL_ID: 'not-a-uuid' })))).toBe(
      true,
    );
  }),
);

it.effect(
  'the verification whoami holds only for the configured human principal in its company, on work.tasks through approval',
  () =>
    Effect.gen(function* verificationWhoamiVerdict() {
      const identity = yield* read(stable);
      const whoami = {
        actingKind: 'human',
        legalEntityId: identity.legalEntityId,
        moduleIds: ['work.tasks'],
        principalId: identity.principalId,
        writePolicy: 'approval',
      };
      expect(verificationWhoamiHolds(whoami, identity)).toBe(true);
      // The canonical CI identity no longer passes on a deployment that configured its own.
      expect(
        verificationWhoamiHolds({ ...whoami, principalId: CANONICAL_VERIFICATION_IDENTITY.principalId }, identity),
      ).toBe(false);
      expect(
        verificationWhoamiHolds({ ...whoami, legalEntityId: CANONICAL_VERIFICATION_IDENTITY.legalEntityId }, identity),
      ).toBe(false);
      expect(verificationWhoamiHolds({ ...whoami, actingKind: 'agent' }, identity)).toBe(false);
      expect(verificationWhoamiHolds({ ...whoami, writePolicy: 'direct' }, identity)).toBe(false);
      expect(verificationWhoamiHolds({ ...whoami, moduleIds: ['work.tasks', 'demo.crm'] }, identity)).toBe(false);
      expect(verificationWhoamiHolds({ ...whoami, moduleIds: [] }, identity)).toBe(false);
    }),
);
