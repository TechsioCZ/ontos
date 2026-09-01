# Value Objects

Use a value object when a domain concept is defined entirely by its attributes and has no
independent identity or lifecycle. Two value objects with the same normalized attributes are equal
even when they were created separately.

## Entity or value object

Model a concept as a value object when all of these are true:

- it is meaningful only as part of its owning entity or operation;
- replacing the whole value is safer than mutating a shared record;
- no other module needs to address it independently;
- it has no lifecycle, permissions, audit history, or relationships of its own; and
- equality by normalized value matches the business meaning.

Model it as an entity or Resource when any of these are true:

- the business must distinguish two otherwise identical instances;
- it needs stable identity, independent lifecycle, history, permissions, or status;
- several owners intentionally share and observe changes to the same instance; or
- another module must refer to it through a ResourceRef and public owner contract.

Do not introduce identity merely to normalize storage or avoid repeating fields. Conversely, do not
embed a mutable shared concept as a value object when updates must be coordinated across owners.

## Ownership and persistence

The owning module defines a value object's schema, normalization, validation, and serialization.
Persist it with its owner, either in the owner's table or an owner-private child table. A child
table does not automatically make the value an entity.

Across a MicroVertical seam, transmit a value snapshot through a published schema when the consumer
needs the data as observed at that moment. Use a ResourceRef only when the consumer needs the stable
identity owned by another module.

When historical accuracy matters, store the accepted snapshot on the historical record even if an
independently addressable source entity also exists. An Order, invoice, or evidence record must not
silently change because a current profile was edited later.

## Address example

An address is normally a value object owned by the record that uses it: billing address, delivery
address, registered office snapshot, or Contact Point value. Store normalized structured fields and
replace the address as one value. Two equal addresses do not imply one shared business object.

Promote a place to an entity, such as a Location, only when that concrete place needs stable
identity, its own lifecycle or permissions, independent relationships, or deliberate sharing across
modules. One module then owns the Location and other modules use its ResourceRef and public
contracts. Historical documents still retain the address snapshot accepted at the time.
