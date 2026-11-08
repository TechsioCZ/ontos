import {
  OperationalScopeResolverLive,
  makeGatewayScopeGrantRegistrar,
  makeNativeActionV2Owner,
  nativeActionV2DatabaseIdentityEnrollment,
  nativeV2Keys,
} from '@app/core-runtime/testing/native-action-v2';
import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getVerticalRuntimeActions, getVerticalRuntimeReads } from '../../src/modules/runtime-registration.ts';
import { OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { makeGatewayScopeGrantRegistrar as originalRegistrar } from '../../src/auth/gateway-scope-grant.ts';
import { OperationalScopeResolverLive as originalResolverLayer } from '../../src/operations/context.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';

it.layer(NodeServices.layer)('public native Action V2 TEST facade', (suite) => {
  suite.effect('retains the original private registrations in the original owner factory', () =>
    Effect.gen(function* originalRegistrations() {
      const executions = { value: 0 };
      const original = makeNativeActionV2Owner(executions);
      expect(getVerticalRuntimeActions(original.owner.ownerRegistration)).toEqual([original.action]);
      expect(getVerticalRuntimeReads(original.owner.ownerRegistration)).toEqual([original.read]);
      expect(original.action.descriptor.accessDeclaration?.key).toBe(nativeV2Keys.action);
      expect(original.read.descriptor.accessDeclaration?.key).toBe(nativeV2Keys.read);
      expect(original.action.descriptor.accessDeclaration?.selectors).toEqual(['all']);
      expect(original.action.descriptor.legalEntityScope).toBe('required');
      expect(executions.value).toBe(0);
      return yield* Effect.void;
    }),
  );

  suite.effect('creates genuine independent owner-local registrations from the same exact definitions', () =>
    Effect.gen(function* childOwnerDefinitions() {
      const parent = makeNativeActionV2Owner({ value: 0 });
      const child = makeNativeActionV2Owner({ value: 0 });
      expect(child.action).not.toBe(parent.action);
      expect(child.read).not.toBe(parent.read);
      expect(child.owner.ownerRegistration).not.toBe(parent.owner.ownerRegistration);
      expect(getVerticalRuntimeActions(child.owner.ownerRegistration)[0]).toBe(child.action);
      expect(getVerticalRuntimeReads(child.owner.ownerRegistration)[0]).toBe(child.read);
      expect(child.owner.composition).toEqual(parent.owner.composition);
      expect(child.owner.expectedDeployment).toEqual(parent.owner.expectedDeployment);
      expect((yield* child.owner.snapshot).composition).toEqual(child.owner.composition);
      return yield* Effect.void;
    }),
  );
  suite.effect('publishes the real shared approval API before calculating the approved owner revision', () =>
    Effect.gen(function* truthfulOwnerApiPublication() {
      const original = makeNativeActionV2Owner({ value: 0 });
      const [publishedOwner] = original.owner.composition.modules;
      if (publishedOwner === undefined) {
        return yield* Effect.die('The original owner must be present in its own composition');
      }
      const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        publishedOwner.contractDocument,
      );
      expect(contract.manifest.publicSurface.api).toEqual([
        {
          key: 'demo.native-full-command.owner-action-approvals',
          operationKeys: ['ownerActionApprovals.inspect', 'ownerActionApprovals.approve'],
        },
      ]);
      const withoutApi = makeTestOperationOwner({
        actions: [original.action],
        moduleId: original.owner.ownerRegistration.moduleId,
        reads: [original.read],
      });
      expect(withoutApi.composition.revision).not.toBe(original.owner.composition.revision);
      const [unpublishedOwner] = withoutApi.composition.modules;
      if (unpublishedOwner === undefined) {
        return yield* Effect.die('The comparison owner must be present in its own composition');
      }
      const withoutApiContract = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(OntosModuleDeploymentContractSchema),
      )(unpublishedOwner.contractDocument);
      expect(withoutApiContract.manifest.publicSurface.api).toEqual([]);
      return yield* Effect.void;
    }),
  );

  suite.effect(
    'exports the original production constructors and nominal enrollment without transport reconstruction',
    () =>
      Effect.gen(function* originalCapabilityExports() {
        expect(OperationalScopeResolverLive).toBe(originalResolverLayer);
        expect(makeGatewayScopeGrantRegistrar).toBe(originalRegistrar);
        expect(nativeActionV2DatabaseIdentityEnrollment).toBe(FIXTURE_DATABASE_IDENTITY_ENROLLMENT);
        expect(Object.isFrozen(nativeActionV2DatabaseIdentityEnrollment)).toBe(true);
        return yield* Effect.void;
      }),
  );
});
