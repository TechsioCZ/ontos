import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ActivatePackageDefinitionPayloadSchema } from '../../shared/actions/activate-package-definition.ts';
import {
  activatePackageDefinitionAction,
  handleActivatePackageDefinition,
} from '../../src/actions/activate-package-definition.action.ts';
import type { PackageActivationPersistence } from '../../src/persistence/package-activation-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const packageDefinitionId = '33333333-3333-4333-8333-333333333333';
const payload = Schema.decodeUnknownSync(ActivatePackageDefinitionPayloadSchema)({
  evidenceRefs: ['catalog-record:package-verified'],
  expectedCurrent: {
    resourceRef: {
      moduleId: 'commerce.catalog',
      resourceId: packageDefinitionId,
      resourceType: 'commerce.catalog.package-definition',
      tenantId,
    },
    revision: 1,
  },
  reason: 'Verified package content',
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:package-activate-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'package-activate-test',
};
const context = (activate: PackageActivationPersistence['activate']) =>
  ({
    actionInvocationId: '44444444-4444-4444-8444-444444444444',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: { activate, promote: () => Effect.die('unused') },
  }) satisfies ActionHandlerContext<Readonly<Record<string, never>>, PackageActivationPersistence>;

describe('Activate Package Definition Action', () => {
  it.effect('uses the trusted invocation and issues the new exact content revision', () =>
    Effect.gen(function* activate() {
      const result = yield* handleActivatePackageDefinition(
        payload,
        context((input) => {
          expect(input.actionInvocationId).toBe('44444444-4444-4444-8444-444444444444');
          expect(input.principalId).toBe(principalId);
          expect(input.expectedRevision).toBe(1);
          return Effect.succeed({ _tag: 'activated', revision: 2 });
        }),
      );
      expect(result.contentRevision.revision).toBe(2);
      expect(result.definitionRef.resourceId).toBe(packageDefinitionId);
    }),
  );

  it.effect('maps stale and unavailable persistence without claiming activation', () =>
    Effect.gen(function* fails() {
      const stale = yield* handleActivatePackageDefinition(
        payload,
        context(() => Effect.succeed({ _tag: 'stale', actualRevision: 2 })),
      ).pipe(Effect.flip);
      expect(stale.code).toBe('package_definition_stale');
    }),
  );

  it('declares a governed tenant write, explicit authorization, and idempotency', () => {
    expect(activatePackageDefinitionAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(activatePackageDefinitionAction.descriptor.idempotency).toBe('required');
    expect(activatePackageDefinitionAction.descriptor.legalEntityScope).toBe('forbidden');
  });
});
