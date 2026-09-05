// False positive (adversarial review): `allowBrandMarkers` is documented to allow "a slot whose
// *type* is a literal" and, in value position, "a literal", but `isMarkerType` only accepts a single
// `TSLiteralType` and `isMarkerValue` only a single `Literal`. A union of string literals, a template
// literal type and a template-literal value are all capability-free nominal markers of exactly the
// same kind as `readonly [runtimeRegistrationBrand]: true`, and none of them is the B4
// "symbol-slotted operation record" defect. None of these lines must report.
const contactBrand: unique symbol = Symbol('@app/core-runtime/fixture/contact-brand');

export interface ContactKind {
  readonly [contactBrand]: 'contact' | 'organisation';
}

export interface TenantScope {
  readonly [contactBrand]: `tenant-${string}`;
}

export interface Frozen {
  readonly [contactBrand]: boolean;
}

export const contactKind = { [contactBrand]: 'contact' as const } as ContactKind;
export const tenantScope = { [contactBrand]: `tenant-a` as const } as unknown as TenantScope;
