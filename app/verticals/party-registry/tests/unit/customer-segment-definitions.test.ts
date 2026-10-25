import { customerSegmentDefinitions } from '@app/party-registry/api/client';
import type { CustomerSegmentCode, CustomerSegmentDefinition } from '@app/party-registry/api/client';
import { expect, it } from 'effect-rstest';

import { customerSegmentDefinitions as browserSegmentDefinitions } from '../../src/api/customer-segments-client.ts';

it('publishes the unchanged segment identities and group fingerprints through the Party client', () => {
  const expected = [
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
  ] as const satisfies readonly (CustomerSegmentDefinition & { readonly businessCode: CustomerSegmentCode })[];

  expect(customerSegmentDefinitions).toEqual(expected);
});

it('shares one definition set between the browser facade and the published seed contract', () => {
  expect(browserSegmentDefinitions).toBe(customerSegmentDefinitions);
});
