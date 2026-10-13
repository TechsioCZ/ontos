/**
 * Sales-demo customer segments, stored as Commerce Customer Context customer groups.
 *
 * Side-effect free: the browser segment client and the commerce-customer-context demo seed both read it.
 * `create-customer-group` reuses an existing group when business code, meaning key, purpose and
 * membership criteria are identical, so these definitions double as the lookup key for the group.
 * Never edit purpose or membership criteria of a seeded segment; a changed fingerprint is a new group.
 */
export interface CustomerSegmentDefinition {
  readonly businessCode: string;
  readonly description: string;
  readonly meaningKey: string;
  readonly membershipCriteria: string;
  readonly name: string;
  readonly purpose: string;
}

export const customerSegmentDefinitions = [
  {
    businessCode: 'SALES_DEMO_KEY_ACCOUNTS',
    description: 'Strategičtí odběratelé s vyhrazeným obchodníkem a individuálními podmínkami.',
    meaningKey: 'sales-demo.segment.key-accounts',
    membershipCriteria: 'Roční obrat nad 5 mil. Kč nebo platná rámcová smlouva.',
    name: 'Klíčoví zákazníci',
    purpose: 'Prioritní obchodní péče o strategické odběratele.',
  },
  {
    businessCode: 'SALES_DEMO_B2B_STANDARD',
    description: 'Firemní odběratelé se standardním ceníkem a splatností.',
    meaningKey: 'sales-demo.segment.b2b-standard',
    membershipCriteria: 'Firemní zákazník s IČO bez individuální rámcové smlouvy.',
    name: 'B2B standard',
    purpose: 'Standardní obchodní podmínky pro firemní odběratele.',
  },
  {
    businessCode: 'SALES_DEMO_RETAIL',
    description: 'Prodejny a řetězce, které nakupují zboží k dalšímu prodeji spotřebitelům.',
    meaningKey: 'sales-demo.segment.retail',
    membershipCriteria: 'Zákazník provozuje kamennou nebo online prodejnu pro spotřebitele.',
    name: 'Maloobchod',
    purpose: 'Obchodní péče o maloobchodní a spotřebitelský prodej.',
  },
  {
    businessCode: 'SALES_DEMO_PUBLIC_SECTOR',
    description: 'Veřejní zadavatelé a organizace s veřejnou zakázkou nebo dotačním financováním.',
    meaningKey: 'sales-demo.segment.public-sector',
    membershipCriteria: 'Veřejný zadavatel nebo dodávka financovaná z veřejných prostředků.',
    name: 'Veřejný sektor',
    purpose: 'Obchod s veřejnými zadavateli podle pravidel zadávání veřejných zakázek.',
  },
] as const satisfies readonly CustomerSegmentDefinition[];

export type CustomerSegmentCode = (typeof customerSegmentDefinitions)[number]['businessCode'];
