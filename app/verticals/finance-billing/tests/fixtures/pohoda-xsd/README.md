# POHODA XML dataPack 2.0 schema pins

`version-2.sha256` pins the official STORMWARE POHODA XML `dataPack` version 2.0 schemas that the
finance-billing POHODA export tests validate their generated documents against with `xmllint`.

| Fact               | Value                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| Source             | <https://www.stormware.cz/schema/version_2/> (`data.xsd` plus its import closure) |
| Product            | STORMWARE POHODA XML dataPack 2.0                                                 |
| Retrieved          | 2026-11-04                                                                        |
| Files              | 73 `*.xsd` (the transitive `xs:import` closure of `data.xsd`)                     |
| Integrity          | one SHA-256 per file, in `sha256sum`/`shasum -c` format                           |
| License/provenance | Published by STORMWARE s.r.o. for POHODA integration; not redistributed here      |

The schemas stay outside the repository. `scripts/provision-pohoda-xsd.sh` downloads them from the
source above into the directory `POHODA_XSD_DIR` names, or into the workspace cache
`app/node_modules/.cache/pohoda-xsd/version_2` that the tests read by default, and verifies every
file against these pins before it is used. The tests fail, they never skip, when the directory is
missing.

Refresh the pins only when STORMWARE publishes a newer schema set: download the new closure, replace
`version-2.sha256`, and update the retrieval date above. Regenerate the closure from the source by
following each `schemaLocation` import in `data.xsd`.
