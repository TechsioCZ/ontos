import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ActivatePackageOptionPayloadSchema } from '../../shared/actions/activate-package-option.ts';
import { RetirePackageOptionPayloadSchema } from '../../shared/actions/retire-package-option.ts';
import { mapActivatePackageOptionActionProblem } from '../../api/activate-package-option-action-problems.ts';
import { mapRetirePackageOptionActionProblem } from '../../api/retire-package-option-action-problems.ts';
import { activatePackageOptionAction } from '../../src/actions/activate-package-option.action.ts';
import { retirePackageOptionAction } from '../../src/actions/retire-package-option.action.ts';
import { runPackageOptionTransition } from '../../src/actions/package-option-action-support.ts';
import { PackageOptionActionError } from '../../shared/actions/package-option-contract.ts';
import type { PackageOptionPersistence } from '../../src/persistence/package-option-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const definitionId = '22222222-2222-4222-8222-222222222222';
const payload = Schema.decodeUnknownSync(ActivatePackageOptionPayloadSchema)({
  expectedContent: {
    resourceRef: {
      moduleId: 'commerce.catalog',
      resourceId: definitionId,
      resourceType: 'commerce.catalog.package-definition',
      tenantId,
    },
    revision: 3,
  },
  expectedOptionRevision: 1,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:option-test:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'option-test',
};
const context = (
  services: PackageOptionPersistence,
): ActionHandlerContext<Readonly<Record<string, never>>, PackageOptionPersistence> => ({
  actionInvocationId: '44444444-4444-4444-8444-444444444444',
  addDomainEvent: () => Effect.succeed(Object.create(null)),
  addOutboxMessage: () => Effect.void,
  recordAuditEvidence: () => Effect.void,
  recordDataAccess: () => Effect.void,
  scope,
  services,
});

describe('Package Option public operations', () => {
  it('requires exact content and role CAS revisions, with no caller role verdict', () => {
    expect(Schema.decodeUnknownSync(RetirePackageOptionPayloadSchema)(payload).expectedOptionRevision).toBe(1);
    expect(() =>
      Schema.decodeUnknownSync(ActivatePackageOptionPayloadSchema)({ ...payload, expectedOptionRevision: -1 }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(ActivatePackageOptionPayloadSchema)({ ...payload, independentlyRequested: true }),
    ).toEqual(payload);
  });

  it.effect('uses trusted invocation and returns one stable definition identity', () =>
    Effect.gen(function* verifyTrustedIdentity() {
      const services: PackageOptionPersistence = {
        activate: (input) =>
          Effect.sync(() => {
            expect(input.actionInvocationId).toBe('44444444-4444-4444-8444-444444444444');
            expect(input.expectedContentRevision).toBe(3);
            expect(input.expectedOptionRevision).toBe(1);
            return { _tag: 'changed' as const, contentRevision: 3, optionRevision: 2, state: 'ACTIVE' as const };
          }),
        retire: () => Effect.die('unexpected retire'),
      };
      const result = yield* runPackageOptionTransition('ACTIVATE', payload, context(services));
      expect(result.definitionRef.resourceId).toBe(definitionId);
      expect(result.contentRevision.revision).toBe(3);
      expect(result.optionRevision).toBe(2);
    }),
  );

  it('maps stale conflict and missing proof availability distinctly', () => {
    expect(
      mapActivatePackageOptionActionProblem(
        new PackageOptionActionError({ code: 'package_option_stale', reason: 'CAS' }),
      ).status,
    ).toBe(409);
    expect(
      mapRetirePackageOptionActionProblem(
        new PackageOptionActionError({ code: 'package_option_unavailable', reason: 'proof' }),
      ).status,
    ).toBe(503);
  });

  it('declares explicit governed writes', () => {
    for (const action of [activatePackageOptionAction, retirePackageOptionAction]) {
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
    }
  });
});
