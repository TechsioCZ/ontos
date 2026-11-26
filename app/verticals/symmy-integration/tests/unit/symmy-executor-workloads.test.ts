import { describe, expect, it } from 'effect-rstest';

import { planSymmyExecutorGrants, symmyExecutorWorkloadsOf } from '../../src/ops/symmy-executor-workloads.ts';
import { SYMMY_JOB_KEY } from '../../src/ops/symmy-route-bindings.ts';

const executor = '11111111-1111-4111-8111-111111111111';
const installer = '22222222-2222-4222-8222-222222222222';
const company = '33333333-3333-4333-8333-333333333333';
const binding = '44444444-4444-4444-8444-444444444444';

describe('the Symmy executor workload grants', () => {
  it('binds a workload no system principal holds to the executor, registered where its calls run', () => {
    expect(
      planSymmyExecutorGrants({
        executorPrincipalId: executor,
        legalEntityId: company,
        workloads: [
          { companyScoped: true, holders: [], workloadKey: 'catalog.write' },
          { companyScoped: false, holders: [], workloadKey: 'inventory.write' },
        ],
      }),
    ).toEqual([
      { kind: 'binding', legalEntityId: company, workloadKey: 'catalog.write' },
      { kind: 'binding', workloadKey: 'inventory.write' },
    ]);
  });

  it("registers the executor's own binding for a company it does not serve yet", () => {
    expect(
      planSymmyExecutorGrants({
        executorPrincipalId: executor,
        legalEntityId: company,
        workloads: [
          {
            companyScoped: true,
            holders: [{ bindingId: binding, principalId: executor, registered: false }],
            workloadKey: 'catalog.write',
          },
        ],
      }),
    ).toEqual([
      {
        kind: 'company_registration',
        legalEntityId: company,
        workloadBindingId: binding,
        workloadKey: 'catalog.write',
      },
    ]);
  });

  it('grants nothing an installer already set up, as on the stage demo, so a repeated enable changes nothing', () => {
    expect(
      planSymmyExecutorGrants({
        executorPrincipalId: executor,
        legalEntityId: company,
        workloads: [
          {
            companyScoped: true,
            holders: [{ bindingId: binding, principalId: executor, registered: true }],
            workloadKey: 'catalog.write',
          },
          {
            companyScoped: false,
            holders: [{ bindingId: binding, principalId: executor, registered: false }],
            workloadKey: 'inventory.write',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('leaves a workload of another or two system principals to the route checks, which refuse it', () => {
    expect(
      planSymmyExecutorGrants({
        executorPrincipalId: executor,
        legalEntityId: company,
        workloads: [
          {
            companyScoped: true,
            holders: [{ bindingId: binding, principalId: installer, registered: false }],
            workloadKey: 'catalog.write',
          },
          {
            companyScoped: true,
            holders: [
              { bindingId: binding, principalId: executor, registered: false },
              { bindingId: binding, principalId: installer, registered: false },
            ],
            workloadKey: 'pricing.write',
          },
        ],
      }),
    ).toEqual([]);
  });

  it("never grants the executor's own job enrollment nor an integration principal's workload", () => {
    expect(
      symmyExecutorWorkloadsOf([
        { companyScoped: false, identity: 'executor', purpose: 'Symmy job execution', workloads: [SYMMY_JOB_KEY] },
        { companyScoped: false, identity: 'integration', purpose: 'admission', workloads: ['integration.symmy.admit'] },
        { companyScoped: false, identity: 'executor', purpose: 'catalog', workloads: ['catalog.write'] },
        { companyScoped: true, identity: 'executor', purpose: 'catalog', workloads: ['catalog.write'] },
      ]),
    ).toEqual([{ companyScoped: true, workloadKey: 'catalog.write' }]);
  });
});
