import { Effect, Schema } from 'effect';

import { AddContactPointPayloadSchema } from '../actions/add-contact-point.ts';
import { CorrectPartyFactPayloadSchema } from '../actions/correct-party-fact.ts';
import { CounterpartyCustomerOnboardPayloadSchema } from '../actions/counterparty-customer-onboard.ts';
import { CreatePartyPayloadSchema } from '../actions/create-party.ts';
import { EndContactPointPayloadSchema } from '../actions/end-contact-point.ts';
import { MatchPartyPayloadSchema } from '../actions/match-party.ts';
import { UpdateContactPointPayloadSchema } from '../actions/update-contact-point.ts';
import { UpdatePartyPayloadSchema } from '../actions/update-party.ts';

type NativeTarget = Readonly<{
  targetModuleKey?: 'party.registry';
  targetResourceId?: string;
  targetResourceType?: string;
}>;

/** The Core hash target is the actual Action access target, including its declaration key.
 * Create, Match and Counterparty onboarding have no target resolver, so their target is empty.
 * This projects request metadata only; it grants no authority and proves no commit. */
const requestIdentity = <Decoded, Encoded, ActionKey extends string>(
  schema: Schema.Codec<Decoded, Encoded>,
  payload: Schema.Json,
  actionKey: ActionKey,
  target: (decoded: Decoded) => NativeTarget,
) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: 'error' })(payload).pipe(
    Effect.flatMap((decoded) =>
      Schema.encodeEffect(schema)(decoded).pipe(
        Effect.map((normalizedPayload) => ({
          actionKey,
          normalizedPayload,
          owningModuleKey: 'party.registry' as const,
          schemaVersion: '1' as const,
          target: target(decoded),
        })),
      ),
    ),
  );

const recordTarget = (resourceId: string, declarationKey: string): NativeTarget => ({
  targetModuleKey: 'party.registry',
  targetResourceId: resourceId,
  targetResourceType: declarationKey,
});

export const createPartyRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(CreatePartyPayloadSchema, payload, 'party.registry.create-party', () => ({}));
export const matchPartyRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(MatchPartyPayloadSchema, payload, 'party.registry.match-party', () => ({}));
export const updatePartyRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(UpdatePartyPayloadSchema, payload, 'party.registry.update-party', (decoded) =>
    recordTarget(decoded.partyRef.resourceId, 'party.registry.party.update'),
  );
export const correctPartyFactRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(CorrectPartyFactPayloadSchema, payload, 'party.registry.correct-party-fact', (decoded) =>
    recordTarget(
      decoded.factKind === 'RELATIONSHIP' ? decoded.relationshipRef.resourceId : decoded.partyId,
      'party.registry.party-fact.correct',
    ),
  );
export const counterpartyCustomerOnboardRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(
    CounterpartyCustomerOnboardPayloadSchema,
    payload,
    'party.registry.counterparty-customer-onboard',
    () => ({}),
  );
export const addContactPointRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(AddContactPointPayloadSchema, payload, 'party.registry.add-contact-point', (decoded) =>
    recordTarget(decoded.partyRef.resourceId, 'party.registry.contact-point.add'),
  );
export const updateContactPointRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(UpdateContactPointPayloadSchema, payload, 'party.registry.update-contact-point', (decoded) =>
    recordTarget(decoded.contactPointRef.resourceId, 'party.registry.contact-point.update'),
  );
export const endContactPointRequestIdentity = (payload: Schema.Json) =>
  requestIdentity(EndContactPointPayloadSchema, payload, 'party.registry.end-contact-point', (decoded) =>
    recordTarget(decoded.contactPointRef.resourceId, 'party.registry.contact-point.end'),
  );
