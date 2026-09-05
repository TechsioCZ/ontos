/** Every shape here is a capability-free nominal marker, which `allowBrandMarkers` blesses. */
const policyReference: unique symbol = Symbol('@app/core-runtime/actions/policy');
const domainEventReferenceBrand: unique symbol = Symbol(
  '@app/core-runtime/actions/events/DomainEventReference',
);
const TypeId: unique symbol = Symbol.for('@app/core-runtime/actions/TypeId');
const contactTag: unique symbol = Symbol('@app/core-runtime/actions/tag');

export interface ActionPolicyBase<Payload> {
  readonly evaluate: (payload: Payload) => void;
  readonly policyKey: string;
  readonly [policyReference]: true;
}

/** Opaque reference produced only by one execution's Domain Event collector. */
export interface DomainEventReference {
  readonly [domainEventReferenceBrand]: true;
}

export const createDomainEventReference = (): DomainEventReference =>
  Object.freeze({ [domainEventReferenceBrand]: true as const });

/** Effect's `readonly [TypeId]: TypeId` / `typeof TypeId` idiom re-states its own key. */
export interface ContactsServiceProto {
  readonly [TypeId]: TypeId;
}

export interface ContactsServiceProtoAlt {
  readonly [TypeId]: typeof TypeId;
}

export const contactsServiceProto: ContactsServiceProtoAlt = { [TypeId]: TypeId };

/** A string-literal marker is still a marker. */
export interface TaggedContact {
  readonly [contactTag]: 'contact';
}
