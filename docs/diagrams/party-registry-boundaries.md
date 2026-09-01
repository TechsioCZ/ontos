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
    decision[Party Match Decision]
    duplicateCase[Duplicate Candidate Case]
    reviewer[Identity Reviewer]
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
    contacts[Contacts profile]
    commerce[Commerce profile]
    finance[Finance context]
  end

  principal --> coreSdk
  tenant --> coreSdk
  legalEntity --> coreSdk
  candidate --> matching
  matching -->|MATCHED| decision
  matching -->|NO_MATCH + atomic claim| decision
  matching -->|"AMBIGUOUS: create/reuse"| duplicateCase
  duplicateCase -->|caseRef| reviewer
  reviewer -->|resolution Action| matching
  decision -->|partyRef| party
  party --> facts
  party --> counterparty
  legalEntity --> counterparty
  counterparty --> roles
  party --> correction
  party --> merge
  party -. PartyRef .-> contacts
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
- AMBIGUOUS commits one Party Match Decision and creates or reuses one Duplicate Candidate Case; it
  returns a caseRef instead of looping back to the Candidate.
- Consumer modules own profiles and workflows, not copies of shared Party identity.
- Party Merge is enabled only after consumer collision, reconciliation, and recovery behavior is
  tested.
