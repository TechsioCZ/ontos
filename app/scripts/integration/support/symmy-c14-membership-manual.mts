import {
  executeAssignCustomerGroupWithAuthorization,
  executeCreateCustomerGroupWithAuthorization,
} from '@app/commerce-customer-context/api/client';
import { CreateCustomerGroupPayloadSchema } from '@app/commerce-customer-context/api/create-customer-group-action';
import { executeEffectiveCustomerGroupMembershipSetV1WithAuthorization } from '@app/commerce-customer-context/api/effective-customer-group-membership-set-v1/client';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { Config, DateTime, Effect, Redacted, Schema } from 'effect';

import type { makeSymmyC14CustomerFixture } from './symmy-c14-customer-assignment-fixture.mts';
import { bindCustomerFixtureProviderKey, customerFixtureUuid } from './symmy-c14-customer-native-authority.mts';
import { SymmyC14ProductFixtureUnavailable } from './symmy-c14-product-runtime.mts';

type CustomerFixture = Effect.Success<ReturnType<typeof makeSymmyC14CustomerFixture>>;
const principalSchema = Schema.Struct({
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
});
const unavailable = () =>
  new SymmyC14ProductFixtureUnavailable({ message: 'Actual manual Membership setup did not commit' });
const commerceApp = 'commerce-customer-context';

/** Genuine public HUMAN Actions create the protected pre-existing manual membership. */
export const prepareManualMembershipNativeFixture = Effect.fn('SymmyC14Membership.prepareManual')(
  function* prepareManualMembershipNativeFixture(fixture: CustomerFixture) {
    const runtime = fixture.ownerRuntimes.get(commerceApp);
    if (runtime === undefined) {
      return yield* unavailable();
    }
    const setupKey = yield* fixture.shell.issueFixtureSetupActorKey();
    const human = yield* Schema.decodeUnknownEffect(principalSchema)({
      principalId: fixture.integration.issuerPrincipalId,
      tenantId: fixture.tenantId,
    });
    yield* bindCustomerFixtureProviderKey(fixture.admin, human, setupKey.providerKeyId);
    yield* setupKey.acknowledgeBinding;
    const spiceEnvironment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    yield* grantTestTenantRoleAccess({
      adminConnectionString: Redacted.make(fixture.isolated.connections.admin.connectionString),
      holders: [
        {
          capabilityKeys: [
            'commerce.customer-context.customer-group.create',
            'commerce.customer-context.customer-group.assign',
            'commerce.customer-context.customer-group-membership.read-set-v1',
          ],
          principalId: human.principalId,
        },
      ],
      legalEntityIds: [fixture.legalEntityId],
      spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
      tenantId: fixture.tenantId,
    });
    const options = {
      baseUrl: `http://127.0.0.1:${runtime.port}/commerce-customer-context-api`,
      compositionRevision: fixture.snapshot.composition.revision,
    };
    const context = yield* fixture.shell.issueFixtureSetupGateway({
      audience: commerceApp,
      legalEntityId: fixture.legalEntityId,
    });
    const group = yield* executeCreateCustomerGroupWithAuthorization(
      yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)({
        businessCode: 'INTERNAL_C14_MANUAL_MEMBERSHIP',
        description: 'Explicit protected manual classification',
        initialState: 'ACTIVE',
        meaningKey: 'internal-c14.manual-membership',
        membershipCriteria: 'An explicit manual native assignment',
        name: 'Internal manual membership',
        purpose: 'Preserve existing manually managed membership',
        reason: 'INTERNAL_C14 actual manual setup',
      }),
      `Bearer ${context.token}`,
      yield* customerFixtureUuid,
      { ...options, idempotencyKey: 'INTERNAL_C14_MANUAL_GROUP_CREATE' },
    );
    if (!('group' in group)) {
      return yield* unavailable();
    }
    const profile = { profileKind: 'RETAIL' as const, profileRef: fixture.profileReceipt.profileRef };
    const assignContext = yield* fixture.shell.issueFixtureSetupGateway({
      audience: commerceApp,
      legalEntityId: fixture.legalEntityId,
    });
    const assigned = yield* executeAssignCustomerGroupWithAuthorization(
      {
        effectiveFrom: DateTime.formatIso(yield* DateTime.now),
        groupRef: group.group.groupRef,
        profile,
        reason: 'INTERNAL_C14 actual manual membership must survive source assignment',
      },
      `Bearer ${assignContext.token}`,
      yield* customerFixtureUuid,
      { ...options, idempotencyKey: 'INTERNAL_C14_MANUAL_MEMBERSHIP_ASSIGN' },
    );
    if (!('membership' in assigned)) {
      return yield* unavailable();
    }
    const read = Effect.gen(function* readCurrentMemberships() {
      const readContext = yield* fixture.shell.issueFixtureSetupGateway({
        audience: commerceApp,
        legalEntityId: fixture.legalEntityId,
      });
      return yield* executeEffectiveCustomerGroupMembershipSetV1WithAuthorization(
        { asOf: DateTime.formatIso(yield* DateTime.now), profile },
        `Bearer ${readContext.token}`,
        yield* customerFixtureUuid,
        options,
      );
    });
    return { membership: assigned.membership, read };
  },
);
