# Party Registry boundaries

```mermaid
flowchart LR
  subgraph core[OntOS Core]
    tenant[Tenant]
    legalEntity[Legal Entity]
    principal[Principal]
    coreSearch[OntOS Core Search]
    coreSdk[CoreSDK]
  end

  subgraph partyRegistry[Party Registry]
    candidate[Party Candidate]
    matching[Party Matching]
    party[Party]
    facts[Official Identifiers<br/>Contact Points<br/>Party Relationships]
    counterparty[Counterparty]
    roles[Counterparty Roles]
    correction[Party Correction]
    merge[Party Merge + Party Aliases]
  end

  subgraph organizationRegistry[Organization Registry]
    groups[Managed Legal Entity<br/>groupings and views]
  end

  subgraph consumers[Business Modules]
    crm[CRM profile]
    commerce[Commerce profile]
    finance[Finance context]
  end

  principal --> coreSdk
  tenant --> coreSdk
  legalEntity --> coreSdk
  candidate --> matching
  matching -->|MATCHED| party
  matching -->|NO_MATCH + atomic claim| party
  matching -->|AMBIGUOUS| candidate
  party --> facts
  party --> counterparty
  legalEntity --> counterparty
  counterparty --> roles
  party --> correction
  party --> merge
  party -. PartyRef .-> crm
  party -. PartyRef .-> commerce
  counterparty -. CounterpartyRef .-> finance
  party -. search descriptors .-> coreSearch
  legalEntity --> groups

  legalEntity -. "never implicitly converted" .- party
  principal -. "authentication/authorization, not Party identity" .- party
```

Key invariants:

- Legal Entity, Party, Counterparty, and Principal are distinct Resources.
- Party creation claims strong identifiers in the canonical Party Registry transaction; search is
  never uniqueness authority.
- Consumer modules own profiles and workflows, not copies of shared Party identity.
- Party Merge is enabled only after consumer collision, reconciliation, and recovery behavior is
  tested.
