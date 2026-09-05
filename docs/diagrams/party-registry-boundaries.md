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
    claimBoundary[Atomic Party claim boundary]
    decision[Party Match Decision]
    duplicateCase[Duplicate Candidate Case]
    reviewer[Identity Reviewer]
    resolution[Duplicate Candidate Resolution Action]
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
  matching -->|MATCHED / NO_MATCH| claimBoundary
  matching -->|"AMBIGUOUS: create/reuse"| duplicateCase
  duplicateCase -->|caseRef| decision
  duplicateCase -->|caseRef| reviewer
  reviewer -->|selected Party or create decision| resolution
  resolution -->|locked claim validation| claimBoundary
  claimBoundary -->|CREATED / MATCHED_EXISTING| decision
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
- Reviewed MATCH_EXISTING and CREATE_NEW outcomes use dedicated resolution Actions that consume the
  review decision and revalidate locked canonical claims.
- Consumer modules own profiles and workflows, not copies of shared Party identity.
- Party Merge is enabled only after consumer collision, reconciliation, and recovery behavior is
  tested.
