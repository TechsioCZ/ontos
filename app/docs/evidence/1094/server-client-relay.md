# #1284 server client relay — implementation evidence

Status: implementation and focused tests present; actual native end-to-end proof, whole-workspace quality and final independent issue acceptance are pending. This is controlled development evidence, not production enrollment/readiness. Source baseline: `e934cb32861877da450f0de2b14a0af84794daf9`; a clean source checkpoint and exact build identities are required before native packaging. #253 is unchanged.

## Authority and scope

The existing Shell issuer authenticates an explicitly enrolled source deployment credential independently of the original actor. Its policy binds provider key identity to source app/build and exact Composition revision; permitted relationships are Catalog→Party and CCC→Party/Market, with the six destination read IDs defined by the private policy. Consumer factories use the original verified Core carrier, captured Crypto and existing public explicit-authorization clients. LEGAL_ENTITY and COMMERCE_ONLY branches retain independent local/Core paths.

The operation allowlist governs Shell’s exchange request. The enrolled source workload attests the operation/attempt and invokes its approved public client. The returned assertion authenticates the original actor for the destination audience/build/revision; it is not restricted cryptographically to the named read. A compromised enrolled source could use it for another destination operation, subject to the original actor’s independent Current permissions and existing single-use receiving rules. The ledger proves exchange replay protection, not independent source execution. No Action/permission claim was added to identity assertions.

Shell validates the original signature and current actor/authentication reference, Tenant/Legal Entity and current read access. Assertions preserve original iat/exp, retain actor and support provenance, and receive a fresh destination jti. The workload key’s Principal never replaces the actor. The durable Shell auth ledger atomically rejects duplicate source-jti/exchange-id reservations, including changed fingerprints; bounded cleanup retains replay slots through expiry plus clock skew. No raw proof, token or credential is stored there. Failure does not produce an allow or a complete empty owner result.

## Current evidence and limits

Focused issuer/wire/policy/authentication unit tests: 33 PASS. Consumer focused unit tests: 42 PASS after the complete-Bearer and typed-error fixes. Ledger: three native PostgreSQL tests and six auth schema tests PASS, generated migration applied and seven-table verifier/migration check PASS. After the private auth service filenames and native-test clock were corrected, the three native ledger tests and 37 Shell unit tests passed again. The reusable actual Node HTTP harness retained all seventeen existing transport tests. These results do not establish the complete public path.

Source review found and corrected the relay fingerprint schema, missing Bearer prefix and unavailable-identity error taxonomy. Native integration must additionally prove all actual factories/receivers, original actor audit/readback, revoked/denied permission and authentication references, wrong source/build/revision, provider unavailability and local branch independence. A full repository gate and independent issue review remain required.

Market Bootstrap additionally requires a trusted Storefront context at its incoming boundary. No ordinary Shell session producer of that field was found. A labeled owner-level fixture is not proof of that real public producer; preserve the gate and report any remaining path gap rather than manufacturing trust from payload/header.

Runtime configuration and exact supported schema remain in their source files. Production source-credential enrollment, deployment, customer-data migration and unrelated capabilities are not delivered by these tests.
