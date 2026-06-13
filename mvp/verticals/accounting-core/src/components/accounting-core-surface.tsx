import { useState } from 'react';
import { createDraftEntryHandler } from '../actions/create-draft-entry.handler';
import { AccountingDraftEntryCard } from './accounting-draft-entry-card';
import { RemotePropertyUnitCard } from './remote-property-unit-card';

const moduleFacts = [
  ['Semantic module id', 'accounting.core'],
  ['Filesystem folder', 'verticals/accounting-core'],
  ['Tenant module state', 'active'],
  ['Owned by', 'accounting.core'],
  ['Renders from', 'accounting.core'],
] as const;

const probeScenarios = [
  {
    id: 'property-write',
    label: 'Property write',
    message: 'Probe only: accounting cannot mutate property.registry state.',
  },
  {
    id: 'accounting-write',
    label: 'Accounting write',
    message: 'Probe only: createDraftEntry handler returns stub-only.',
  },
  {
    id: 'missing-context',
    label: 'Missing context',
    message: 'Denied: tenant and actor context are intentionally absent.',
  },
  {
    id: 'module-state-deny',
    label: 'Module-state deny',
    message: 'Denied: simulated inactive dependency state.',
  },
  {
    id: 'authorization-deny',
    label: 'Authorization deny',
    message: 'Denied: simulated actor permission failure.',
  },
  {
    id: 'policy-deny',
    label: 'Policy deny',
    message: 'Denied: simulated policy decision.',
  },
  {
    id: 'validation-deny',
    label: 'Validation deny',
    message: 'Denied: simulated payload validation failure.',
  },
] as const;

interface AccountingCoreSurfaceProps {
  surface: 'route' | 'widget';
}

export const AccountingCoreSurface = ({ surface }: AccountingCoreSurfaceProps) => {
  const [probeResult, setProbeResult] = useState('Select a Day 3 probe scenario.');

  const runProbe = (scenario: (typeof probeScenarios)[number]) => {
    const actionResult =
      scenario.id === 'accounting-write'
        ? createDraftEntryHandler({
            currency: 'CZK',
            description: 'Day 3 no-write probe',
            lines: [
              {
                accountCode: '399999',
                amountMinor: 1_248_000,
                memo: 'fixture only',
              },
            ],
            sourceModuleId: 'accounting.core',
            tenantId: 'tenant.demo',
          })
        : null;
    const detail = {
      actionResult,
      moduleId: 'accounting.core',
      scenarioId: scenario.id,
      surface,
    };

    globalThis.dispatchEvent(new CustomEvent('ontos:day3-accounting-probe', { detail }));
    setProbeResult(scenario.message);
  };

  return (
    <section
      className="accountingcore:rounded-lg accountingcore:border accountingcore:border-stone-900/10 accountingcore:bg-white/95 accountingcore:p-5 accountingcore:shadow-lg accountingcore:shadow-stone-900/5"
      data-modern-boundary-id="verticalAccountingCore"
      data-modern-mf-expose={surface === 'route' ? './Route' : './Widget'}
      data-ontos-module-id="accounting.core"
      data-ontos-owned-by="accounting.core"
      data-ontos-renders-from="accounting.core"
      data-tenant-module-state="active"
    >
      <div className="accountingcore:flex accountingcore:flex-wrap accountingcore:items-start accountingcore:justify-between accountingcore:gap-4">
        <div>
          <p className="accountingcore:text-xs accountingcore:font-bold accountingcore:uppercase accountingcore:text-stone-500">
            accounting.core MicroVertical
          </p>
          <h2 className="accountingcore:mt-1 accountingcore:text-2xl accountingcore:font-black accountingcore:text-stone-950">
            Draft entry command surface
          </h2>
        </div>
        <span className="accountingcore:rounded-full accountingcore:border accountingcore:border-emerald-900/15 accountingcore:bg-emerald-50 accountingcore:px-3 accountingcore:py-1 accountingcore:text-xs accountingcore:font-bold accountingcore:text-emerald-950">
          active
        </span>
      </div>

      <dl className="accountingcore:mt-5 accountingcore:grid accountingcore:gap-3 accountingcore:sm:grid-cols-2">
        {moduleFacts.map(([term, description]) => (
          <div
            className="accountingcore:rounded-lg accountingcore:bg-stone-50 accountingcore:p-3"
            key={term}
          >
            <dt className="accountingcore:text-xs accountingcore:font-bold accountingcore:uppercase accountingcore:text-stone-500">
              {term}
            </dt>
            <dd className="accountingcore:mt-1 accountingcore:text-sm accountingcore:font-extrabold accountingcore:text-stone-950">
              {description}
            </dd>
          </div>
        ))}
      </dl>

      <div className="accountingcore:mt-5 accountingcore:grid accountingcore:gap-4 accountingcore:lg:grid-cols-2">
        <AccountingDraftEntryCard />
        <RemotePropertyUnitCard />
      </div>

      <div className="accountingcore:mt-5">
        <h3 className="accountingcore:text-sm accountingcore:font-black accountingcore:text-stone-950">
          Day 3 negative probes
        </h3>
        <div className="accountingcore:mt-3 accountingcore:grid accountingcore:gap-2 accountingcore:sm:grid-cols-2 accountingcore:lg:grid-cols-3">
          {probeScenarios.map((scenario) => (
            <button
              className="accountingcore:h-11 accountingcore:rounded-lg accountingcore:border accountingcore:border-stone-900/15 accountingcore:bg-white accountingcore:px-3 accountingcore:text-sm accountingcore:font-bold accountingcore:text-stone-950 accountingcore:shadow-sm accountingcore:transition accountingcore:hover:bg-stone-50 accountingcore:focus-visible:outline accountingcore:focus-visible:outline-2 accountingcore:focus-visible:outline-offset-2 accountingcore:focus-visible:outline-stone-950"
              data-day3-probe-scenario={scenario.id}
              key={scenario.id}
              onClick={() => runProbe(scenario)}
              type="button"
            >
              {scenario.label}
            </button>
          ))}
        </div>
        <output
          className="accountingcore:mt-3 accountingcore:rounded-lg accountingcore:bg-stone-950 accountingcore:px-4 accountingcore:py-3 accountingcore:text-sm accountingcore:font-semibold accountingcore:text-white"
          data-day3-probe-result=""
        >
          {probeResult}
        </output>
      </div>
    </section>
  );
};
