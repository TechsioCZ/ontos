---
name: c18-1173-authority
overview: 'Prove OntOS-only Promotion source authority and retained own history while excluding legacy import.'
todos:
  - id: authority-entrypoints
    content: 'Verify canonical creation and lifecycle writes are only the governed OntOS management paths and unsupported external identities cannot replace owner facts.'
    status: completed
  - id: authority-tests
    content: 'Test legacy-only code does not apply, external changes cannot mutate truth and retired OntOS offers retain explainable historical applications.'
    status: completed
  - id: review-1173
    content: 'Review every issue 1173 criterion and exclusion, fix actual defects and rerun owner acceptance tests without adding an importer.'
    status: completed
isProject: false
---

# c18-1173-authority

## Execution Notes

Authority: [#1173](https://github.com/TechsioCZ/ontos/issues/1173). Follow [foundation](c18-00-foundation.plan.md). Own source-authority and history acceptance tests and narrow necessary fixes. This is an explicit deliverable, not an omitted migration task.

New supported facts originate from the owner through authorized management. A voucher found only in another system cannot resolve to an OntOS Voucher or activate an offer. An external update cannot rewrite OntOS terms. A tenant can create an unrelated new OntOS offer through normal management; coincidental code text does not import identity/history. Own historical evidence remains queryable/explainable after retirement, with preserved identities and semantics, independent of Current eligibility.

Demonstrate these facts through native owner tests, accepted evidence fixtures and an inspection of public mutations. Do not create a dummy external integration merely to reject it. Invalid payload/unsupported-import controls plus the absence of any import route are sufficient where no integration exists.

## Constraints

Do not implement or plan legacy import, ID maps, replay/reconciliation, usage-history transfer, connectors, continuity of external campaigns, rehearsal or cutover. No external-ID conflict workflow is needed. Follow foundation constraints.

## Operator Guidance

Depends on reviewed #1170 and verified #1172 management-component readiness so tests cover both the actual evaluator and canonical writers. Run owner unit/integration suites. The reviewer must check both acceptance and absence of hidden import obligations; #1173 needs its own evidence even when the correct implementation contains no importer.
