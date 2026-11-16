import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import type { CounterpartyRef } from '@app/party-registry/resources/counterparty';
import { Crypto, Effect, Redacted, Schema } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../../shared/resources/counterparty-purchasing-profile.ts';
import { counterpartyPurchasingProfiles, customerProfiles } from '../../src/database/schema.ts';
import { withVerifiedCustomerContextFixture } from './customer-context-owned-fixture.ts';
import type { CustomerContextOwnedFixtureInput } from './customer-context-owned-fixture.ts';

export interface OrganizationProfileIcoNativeFixtureInput extends Omit<CustomerContextOwnedFixtureInput, 'tenantId'> {
  readonly counterpartyRef: CounterpartyRef;
}
export class OrganizationProfileIcoNativeFixtureUnavailable extends Schema.TaggedError<OrganizationProfileIcoNativeFixtureUnavailable>()(
  'OrganizationProfileIcoNativeFixtureUnavailable',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
const unavailable = (cause?: unknown) =>
  new OrganizationProfileIcoNativeFixtureUnavailable({
    cause: Redacted.make(cause),
    reason: 'The owned native Counterparty profile fixture could not be prepared',
  });
/** Explicit preexisting owner data only; no organization, role, Privacy, migration or Action proof. */
export const seedOrganizationProfileIcoNativeFixture = Effect.fn('OrganizationProfileIcoNativeFixture.seed')(
  function* seedOrganizationProfileIcoNativeFixture(input: OrganizationProfileIcoNativeFixtureInput) {
    const counterparty = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema, { onExcessProperty: 'error' })(
      input.counterpartyRef,
    );
    const crypto = yield* Crypto.Crypto;
    const profileId = yield* crypto.randomUUIDv4();
    return yield* withVerifiedCustomerContextFixture({ ...input, tenantId: counterparty.tenantId }, (transaction) =>
      Effect.gen(function* seedProfile() {
        yield* transaction.insert(customerProfiles).values({
          customerProfileId: profileId,
          legalEntityId: input.legalEntityId,
          profileKind: 'COUNTERPARTY',
          tenantId: counterparty.tenantId,
        });
        yield* transaction.insert(counterpartyPurchasingProfiles).values({
          counterpartyPurchasingProfileId: profileId,
          counterpartyResourceId: counterparty.resourceId,
          legalEntityId: input.legalEntityId,
          tenantId: counterparty.tenantId,
        });
        return yield* Schema.decodeUnknownEffect(CounterpartyPurchasingProfileRefSchema)({
          moduleId: 'commerce.customer-context',
          resourceId: profileId,
          resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
          tenantId: counterparty.tenantId,
        });
      }),
    );
  },
  (effect) => effect.pipe(Effect.mapError(unavailable)),
);
