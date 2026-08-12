# OntOS Application

This glossary defines the business language used by application MicroVerticals. Terms are added as their meaning is resolved during product design.

## CRM

**Customer**:
A tenant-wide company whose commercial relationship is managed in CRM. A Customer has zero or more Contacts and is shared across the tenant's managed Legal Entities.
_Avoid_: Party, Account, Client

**Contact**:
A person belonging to one Customer who can be contacted on that Customer's behalf.
_Avoid_: Party, Customer person, free-text contact

**Deal**:
A potential sale to one Customer, tracked as the same record from initial qualification until it is won or lost. The Czech UI term is "Obchodní případ".
_Avoid_: Business Case, Opportunity, separate won-sale record

**Deal Status**:
The fixed lifecycle state of a Deal: New, Qualified, Offer sent, Negotiation, Won, or Lost.
_Avoid_: Configurable pipeline stage, free-text status

**Offer**:
A commercial proposal belonging to one Deal. A Deal may have multiple Offers as its terms are revised; the Offer amount is quoted, while the Deal value remains the expected commercial value.
_Avoid_: Uploaded offer file, Deal value, overwrite-in-place revision

**Offer Status**:
The fixed lifecycle state of an Offer: Draft, Sent, Accepted, Rejected, Withdrawn, or Superseded.
_Avoid_: Deal Status, configurable offer workflow, free-text status

**Activity**:
A dated CRM history entry of type Note, Call, Email, Meeting, or Other. It belongs to one Customer and may additionally concern one Contact, one Deal, or both.
_Avoid_: Separate note entity, separate interaction tables, audit event
