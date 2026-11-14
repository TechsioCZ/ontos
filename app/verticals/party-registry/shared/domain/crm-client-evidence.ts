// Party Registry's published CRM client intake evidence identity. CRM sends the reference in its create request and
// Party recomputes it before it admits the candidate. The reference is `crm-client:` + the lowercase hex SHA-256 of
// the UTF-8 pre-image below; each side hashes with its own runtime, because a published contract routine reaches
// only `effect` contract leaves.

/** Length-prefixed UTF-16 code units preserve every string without ambiguous tuple boundaries. */
const encodeClientIdentity = (identity: readonly [string, string, string]) =>
  identity
    .map(
      (value) =>
        `${value.length}:${value
          .split('')
          .map((unit) => unit.codePointAt(0)?.toString(16).padStart(4, '0'))
          .join('')}`,
    )
    .join('');

/** Company-qualified SHA-256 pre-image; local client ids never collide across scopes. Always ASCII. */
export const crmClientEvidencePreimage = (
  scope: { readonly tenantId: string; readonly legalEntityId: string },
  clientId: string,
) => encodeClientIdentity([scope.tenantId, scope.legalEntityId, clientId]);

/** Bounded evidence reference from the lowercase hex SHA-256 of `crmClientEvidencePreimage`. */
export const crmClientEvidenceReferenceFromSha256 = (preimageSha256Hex: string) => `crm-client:${preimageSha256Hex}`;
