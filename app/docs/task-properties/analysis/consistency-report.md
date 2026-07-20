# Task Property independent consistency audit

## Final readiness result

**READY FOR TO-SPEC.**

All 18 datatype briefs and all 63 conflict records that existed at the start of this audit were checked. The audit added C-064 and C-065; both are resolved, and no row is Open in the 65-record register. All 37 original sources are preserved as checksum-verified in-repo snapshots, and every active source citation points to that durable archive.

No implementation was performed and `to-spec` was not run.

## Required counts

| Measure                                         |                                                                                          Result |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------: |
| Number of datatypes audited                     |                                                                                              18 |
| Number of conflict records checked              |            65: 63 pre-existing records plus C-064 and C-065 added and checked during this audit |
| Conflict records after this audit               |                                                                                              65 |
| Number of stale artifacts corrected             | 5: Email brief, Phone brief, decisions ledger, this report, and broken PR/DEC anchor references |
| Number of new conflicts discovered              |                                                                              2: C-064 and C-065 |
| Remaining Open conflict rows                    |                                                                                               0 |
| Number of remaining open business behaviors     |                                                                                               0 |
| Number of remaining open business dependencies  |                                                              0 of the four focused dependencies |
| Number of remaining open implementation details |                                                                                               0 |
| Durable original-source snapshots               |                                                   37: 18 product specifications and 19 handoffs |
| Temporary-only active source references         |                                                                                               0 |
| Source-integrity status                         |                                                                                        **PASS** |
| Final result                                    |                                                                           **READY FOR TO-SPEC** |

## Audit criteria

|   # | Criterion                                                                      | Result | Evidence                                                                                                                                                                                                                                                                                   |
| --: | ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | Every conflict has a final disposition                                         | Pass   | All 65 rows have a final disposition.                                                                                                                                                                                                                                                      |
|   2 | No row remains Open                                                            | Pass   | No conflict row is Open.                                                                                                                                                                                                                                                                   |
|   3 | All 22 focused resolved business behaviors agree with `product-resolutions.md` | Pass   | The 22-record trace below agrees after the two mechanical deletion-population corrections.                                                                                                                                                                                                 |
|   4 | All four focused business dependencies have concrete documented contracts      | Pass   | C-005, C-006, C-007, and C-029 map to concrete naming, collation, Core Reference, and Core Media rules with durable source citations.                                                                                                                                                      |
|   5 | C-019 has an engineering decision and introduces no business behavior          | Pass   | C-019, PR-008, and DEC-085 now record only the existing `ColorSelect` component dependency. C-054/PR-019/DEC-098 extend that engineering decision across option datatypes without defining a palette or new creation behavior. C-064 is resolved.                                          |
|   6 | Every effective decision agrees with its authoritative source                  | Pass   | All 104 DEC entries were traced against the product ledger and durable original-source snapshots.                                                                                                                                                                                          |
|   7 | Superseded decisions are marked and not current                                | Pass   | DEC-098 subsumes the narrower DEC-085 without changing its engineering-only classification; the locale portion of DEC-014 and removal portion of DEC-077 identify their replacements; C-012/C-013 point to C-052/C-053. No random/explicit-selection color rule remains current.           |
|   8 | Every affected datatype brief incorporates final decisions                     | Pass   | All mechanically incorporable decisions, including the `ColorSelect` clarification and durable Core Principal attribution contract, are present.                                                                                                                                           |
|   9 | Capability matrix agrees with briefs/effective decisions                       | Pass   | All 18 rows agree on value, editability, query availability, Empty, duplication, and concrete dependency declarations.                                                                                                                                                                     |
|  10 | `CONTEXT.md` uses final terminology and no implementation detail               | Pass   | It consistently defines Task Collection, Task Property Definition/Value, Mandatory and Derived Task Property, Business Entity/Core Reference, options, Principal attribution, Files & Media Item, Media Asset, and ID Assignment without storage, API, or UI implementation prescriptions. |
|  11 | Source references exist and are durable                                        | Pass   | All 37 original sources are byte-for-byte archived under `docs/task-properties/sources/`; checksums pass and all 523 active source citations resolve to the archive.                                                                                                                       |

## Focused product-resolution trace

### Twenty-two resolved business behaviors

The 22 focused business-behavior records agree with the authoritative answers in `product-resolutions.md`:

| Conflicts                         | Authoritative behavior                                                 | Effective decision                              |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| C-003                             | Text duplication copies definition configuration only                  | PR-006 / DEC-083                                |
| C-004, C-009, C-017, C-022, C-025 | Shared property validation and `Copy` suffix sequence                  | PR-002 / DEC-079                                |
| C-010, C-014, C-020, C-026, C-028 | Query capabilities are default-enabled except explicit exclusions      | PR-003 / DEC-080, completed by PR-025 / DEC-104 |
| C-018                             | Multi-select selections display in catalog order                       | PR-007 / DEC-084                                |
| C-021                             | Audit and domain logs are the shared version record                    | PR-001 / DEC-078, completed by PR-023 / DEC-102 |
| C-033, C-037                      | Every datatype is eligible for Mandatory with deferred save validation | PR-004 / DEC-081                                |
| C-034, C-035                      | Text-like negative filters and Empty sorting/collation                 | PR-005 / DEC-082                                |
| C-036                             | Bounded WHATWG-compatible HTTP(S) URL profile                          | PR-014 / DEC-091                                |
| C-038                             | Bounded single-line exact Phone text                                   | PR-013 / DEC-090                                |
| C-045                             | Last edited time uses the Created time filter contract                 | PR-012 / DEC-089                                |
| C-046                             | Archive/restore updates both last-edit facts                           | PR-011 / DEC-088                                |
| C-050                             | ID deletion impact includes soft-deleted retained Tasks                | PR-009 / DEC-086, aligned by PR-022 / DEC-101   |

C-049 is the separately recorded ID lifecycle product correction in PR-010/DEC-087; it is not counted among the 22 focused business-behavior resolutions above.

### Four focused business dependencies

| Conflict | Dependency contract                                                                                                                                                                                | Result          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| C-005    | Property naming is concrete in PR-002/DEC-079                                                                                                                                                      | Pass on content |
| C-006    | Text comparison, normalization delegation, locale collation, and Empty behavior are concrete in PR-005/DEC-082                                                                                     | Pass on content |
| C-007    | Mention/Relation lifecycle and opening are concrete in PR-015/DEC-092 and PR-020/DEC-099 plus the [Core Reference contract](../contracts/core-reference.md)                                        | Pass on content |
| C-029    | File typing, limits, preview, enforcement, and external-link validation are concrete in PR-016/DEC-093 and PR-024/DEC-103 plus the [Core Media upload contract](../contracts/core-media-upload.md) | Pass on content |

The later C-054 record is an implementation dependency on `ColorSelect`, not a business dependency. C-055, C-058, and C-059 have concrete in-repo Core Reference, audit/domain-log, and Core Media contracts. C-065 is resolved by the durable Core Principal, Person Directory, and operation-attribution contract.

## Discrepancies

| ID/files                                                                                                                                                                                                                                                                                                                                                                                         | Classification                     | Finding                                                                                                                                                                     | Audit action                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Email brief](datatypes/email.md), DEC-101                                                                                                                                                                                                                                                                                                                                                       | stale derived artifact             | The schema-operation summary said deletion counted only “live” non-empty values, while the retained-population section and DEC-101 include archived and soft-deleted Tasks. | Mechanically changed the summary to every retained Task.                                                                                                                                                          |
| [Phone brief](datatypes/phone.md), DEC-101                                                                                                                                                                                                                                                                                                                                                       | stale derived artifact             | The schema-operation summary likewise said “live” count despite the final retained-Task rule.                                                                               | Mechanically changed the summary to every retained Task.                                                                                                                                                          |
| Prior consistency report                                                                                                                                                                                                                                                                                                                                                                         | stale derived artifact             | It reported PASS, zero Open conflicts, durable source authority, and no Principal implementation gap.                                                                       | Replaced by this independent report.                                                                                                                                                                              |
| PR-014/DEC-091 and PR-016/DEC-093 inbound links                                                                                                                                                                                                                                                                                                                                                  | stale derived artifact             | Twenty-four Markdown links used slugs that did not match the actual `HTTP(S)` and `Files & media` headings.                                                                 | Mechanically corrected every anchor; the full path-and-anchor check now passes.                                                                                                                                   |
| [DEC-085](decisions.md#dec-085--multi-select-color-selection-uses-colorselect), [DEC-098](decisions.md#dec-098--option-color-editing-uses-colorselect)                                                                                                                                                                                                                                           | stale derived artifact             | DEC-098 explicitly subsumed DEC-085, but DEC-085 did not mirror that status and could be mistaken for a separate current rule.                                              | Mechanically marked DEC-085 as superseded for current application and retained it only as the historical C-019 engineering disposition.                                                                           |
| [C-019, C-054, C-060, C-064](conflicts.md), [PR-008](../product/product-resolutions.md#pr-008--multi-select-color-selection-uses-colorselect), [PR-019](../product/product-resolutions.md#pr-019--option-color-editing-uses-colorselect), [DEC-085](decisions.md#dec-085--multi-select-color-selection-uses-colorselect), [DEC-098](decisions.md#dec-098--option-color-editing-uses-colorselect) | business contradiction, resolved   | The prior explicit-selection and random opaque-color rules contradicted the original engineering-only C-019 scope.                                                          | Product-owner clarification resolves C-064: use the existing `ColorSelect` component, add no palette or automatic-selection business rule, and ask no further palette question.                                   |
| [Person](datatypes/person.md), [Created by](datatypes/created-by.md), [Last edited by](datatypes/last-edited-by.md); DEC-035–038, DEC-062–064, DEC-070–072                                                                                                                                                                                                                                       | missing dependency, resolved       | The specification declared Core Person Directory, Principal lifecycle, Actor, Originating Principal, and System Principal behavior without one durable shared contract.     | C-065 is resolved by the [Core Principal, Person Directory, and operation-attribution contract](../contracts/core-principal-attribution.md), which consolidates existing behavior without inventing a public API. |
| All 18 brief `Sources` sections, DEC source citations, contract source sections, and product-resolution original-source positions                                                                                                                                                                                                                                                                | source-integrity problem, resolved | Thirty-seven original sources were cited only under temporary filesystem locations.                                                                                         | Archived byte-for-byte snapshots under `docs/task-properties/sources/`, recorded SHA-256 checksums, and repointed all active citations to the durable files.                                                      |

## Shared-rule cross-check across all datatypes

| Rule                                            | Result                     | Notes                                                                                                                                                                                    |
| ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty versus `false`, `0`, or empty collection  | Pass                       | Number `0` is non-empty; Checkbox `false` is non-empty and Checkbox is never Empty; zero-member Multi-select/Person/Files collections are Empty.                                         |
| Mandatory eligibility and save validation       | Pass                       | All 18 briefs cite DEC-081; existing Empty values are not backfilled and the next submitted edited Task form validates all Mandatory properties.                                         |
| Creation defaults                               | Pass                       | Generic Empty, Checkbox `false`, Status existing-Task Empty/new-Task Default, intrinsic derived facts, and ID backfill agree.                                                            |
| Property-name validation and uniqueness         | Pass                       | Every brief cites DEC-079: trim, non-empty, case-insensitive schema uniqueness, no additional restriction.                                                                               |
| Duplicate naming                                | Pass                       | Every duplicable datatype uses the shared `Name Copy` sequence; ID rejects duplication.                                                                                                  |
| Duplication with and without values             | Pass                       | Generic choice and Text, Date Range, Checkbox, derived-property, and ID exceptions agree between briefs and matrix.                                                                      |
| Deletion, hiding, and impact counts             | Pass after two corrections | Definition deletion is confirmed and uses every retained Task; derived definition removal hides only the projection; ID hard-deletes its namespace.                                      |
| Search, filtering, sorting, and grouping        | Pass                       | DEC-080 availability and DEC-104 semantics match every matrix row and explicit datatype exclusion.                                                                                       |
| Negative-filter treatment of Empty              | Pass                       | Text-like, Select, Multi-select, Person, and Files negatives include Empty where specified; Number `!=` excludes Empty.                                                                  |
| Text normalization and collation                | Pass                       | Task Collection locale, case-insensitive/diacritic-sensitive comparison, canonical equivalence, and stored-value preservation agree.                                                     |
| Permissions                                     | Pass                       | Schema/value role split is consistent; derived values cannot be edited; provider authorization remains separate.                                                                         |
| Configuration mutability                        | Pass                       | Datatype-local configuration and shared color/media policies agree; Date Range time support is per definition.                                                                           |
| History, revisions, evidence, retention         | Pass                       | DEC-078/DEC-102 and the audit/domain contract define indefinite metadata-only evidence, no raw values, no reconstruction, and no product history surface.                                |
| Derived-property behavior                       | Pass                       | Created/last-edited facts and ID are authoritative projections with the documented creation, duplication, deletion, non-editability, and Principal-attribution contracts.                |
| Archive and restore attribution                 | Pass                       | DEC-088 is present in both last-edit briefs and the matrix.                                                                                                                              |
| Core Principal contract                         | Pass                       | Time-zone preference plus Person Directory, stable identity lifecycle, Actor, Originating Principal, Effective Editor, and named System attribution are documented in durable contracts. |
| Mention, Relation, and Core Reference contracts | Pass                       | DEC-092/DEC-099 and the Core Reference contract align on discovery, stable identity, fallback, clickability, and authorization-on-open.                                                  |
| Media and reference ownership                   | Pass                       | Files & media item identity, shared Media Asset references, download-only behavior, validation, and retention while referenced agree.                                                    |

## Datatype coverage

| Datatype         | Audited result                                                  |
| ---------------- | --------------------------------------------------------------- |
| Text             | Pass; durable original sources and Core Reference contract      |
| Number           | Pass; durable original sources                                  |
| Select           | Pass; `ColorSelect` is an engineering dependency only           |
| Multi-select     | Pass; C-019 is engineering-only and uses `ColorSelect`          |
| Status           | Pass; `ColorSelect` is an engineering dependency only           |
| Date             | Pass; durable original sources                                  |
| Date Range       | Pass; durable original sources                                  |
| Person           | Pass; durable Core Principal/Person Directory contract          |
| Files & media    | Pass; durable Core Media contract                               |
| Checkbox         | Pass; durable original sources                                  |
| URL              | Pass; durable original sources                                  |
| Email            | Pass; stale deletion wording corrected                          |
| Phone            | Pass; stale deletion wording corrected                          |
| Created time     | Pass; durable time-zone-preference contract                     |
| Created by       | Pass; durable Core Principal/Actor attribution contract         |
| Last edited time | Pass; archive/restore and time-zone rules aligned               |
| Last edited by   | Pass; durable Originating Principal/System attribution contract |
| ID               | Pass; hard-delete and retained-population rules aligned         |

## Source integrity

- All Markdown relative links in `docs/task-properties/` resolve to existing in-repo targets.
- Referenced architecture files under `packages/core-runtime/` exist.
- The 18 product-owner specifications are preserved under `docs/task-properties/sources/product-owner/`.
- The 19 handoffs are preserved under `docs/task-properties/sources/handoffs/`.
- `docs/task-properties/sources/SHA256SUMS` verifies every snapshot against the archived bytes.
- All 523 active original-source citations resolve to the durable archive; none depends only on a temporary path.
- Historical `/tmp` strings inside the byte-for-byte snapshots are original provenance text and are mapped to their durable copies by `docs/task-properties/sources/README.md`.

**Source-integrity status: PASS.**

## Stop condition

All 18 datatypes were checked; all 65 conflicts have final dispositions; no artifact contradicts another; every dependency has a concrete contract; all authoritative sources are durable; and no business behavior was inferred by engineering.

**Final result: READY FOR TO-SPEC.**
