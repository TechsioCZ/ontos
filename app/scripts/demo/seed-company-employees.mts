#!/usr/bin/env node
/** Additive workforce fixtures for the Hanák/AKROS pitch. Never resets an agenda or grants permissions.
 * Usage: node scripts/demo/seed-company-employees.mts <hanak|akros> [--apply]
 * Without --apply, validates existing bindings and reports missing employees without writing.
 */
import { akrosDemoLegalEntityId, crmDemoLegalEntityId, demoId, demoTenantId } from './fixture-ids.mts';

const companies = {
  hanak: {
    legalEntityId: crmDemoLegalEntityId,
    email: 'spravce@hanak.demo',
    employees: [
      {
        key: 'hanak-spravce',
        fullName: 'Karel Hanák',
        email: 'spravce@hanak.demo',
        role: 'SUPPORT',
        department: 'Správa firmy',
      },
      {
        key: 'hanak-vedouci',
        fullName: 'Lucie Dvořáková',
        email: 'vedouci@hanak.demo',
        role: 'SALES_HEAD',
        department: 'Obchod',
      },
      {
        key: 'hanak-obchodnik-a',
        fullName: 'Jan Novák',
        email: 'obchodnik.a@hanak.demo',
        role: 'SALES_REP',
        department: 'Obchod',
      },
      {
        key: 'hanak-obchodnik-b',
        fullName: 'Petra Svobodová',
        email: 'obchodnik.b@hanak.demo',
        role: 'SALES_REP',
        department: 'Obchod',
      },
    ],
  },
  akros: {
    legalEntityId: akrosDemoLegalEntityId,
    email: 'eshop@akros.demo',
    employees: [
      {
        key: 'akros-eshop',
        fullName: 'Správce e-shopu AKROS',
        email: 'eshop@akros.demo',
        role: 'SUPPORT',
        department: 'E-shop',
      },
      {
        key: 'akros-expedice',
        fullName: 'Expedice AKROS',
        email: 'expedice@akros.demo',
        role: 'WAREHOUSE',
        department: 'Sklad a expedice',
      },
    ],
  },
} as const;
const companyKey = process.argv[2];
if ((companyKey !== 'hanak' && companyKey !== 'akros') || process.argv.slice(3).some((arg) => arg !== '--apply')) {
  throw new Error('Usage: seed-company-employees.mts <hanak|akros> [--apply]');
}
const company = companies[companyKey];
const apply = process.argv.includes('--apply');
const shell = 'http://localhost:3020';
const jar = new Map<string, string>();
const headers = () => ({
  'content-type': 'application/json',
  origin: shell,
  cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
});
const call = async (path: string, payload?: unknown) => {
  const response = await fetch(`${shell}/shell-super-app-api${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: headers(),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};
await call('/auth/sign-in', { email: company.email, password: 'password1234' });
await call('/auth/legal-entity/switch', { legalEntityId: company.legalEntityId });
const composition = await call('/shell/composition');
const gateway = await call('/auth/gateway-context', {
  audience: 'workforce',
  compositionRevision: composition.compositionRevision,
  legalEntityId: company.legalEntityId,
});
const invoke = async (path: string, payload: unknown) => {
  const response = await fetch(`${shell}${gateway.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: shell,
      authorization: `Bearer ${gateway.token}`,
      'x-ontos-composition-revision': gateway.compositionRevision,
      'x-correlation-id': `seed-company-employees-${crypto.randomUUID()}`,
      'idempotency-key': `seed-company-employees-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};
type Employee = { id: string; email: string; principalRef?: { principalId: string; tenantId: string } };
let created = 0;
for (const employee of company.employees) {
  const records = await invoke('/reads/records', {});
  const principalRef = { principalId: demoId('core.principal', employee.key), tenantId: demoTenantId };
  const id = demoId('workforce.employee', employee.key);
  const existing = (records.items as Employee[]).find((item) => item.id === id || item.email === employee.email);
  if (existing !== undefined) {
    if (
      existing.email !== employee.email ||
      existing.principalRef?.principalId !== principalRef.principalId ||
      existing.principalRef.tenantId !== demoTenantId
    ) {
      throw new Error(`Existing employee has a different account binding: ${employee.email}; no overwrite performed`);
    }
    console.log(`Already linked: ${employee.email}`);
    continue;
  }
  if (!apply) {
    console.log(`Missing: ${employee.email} → ${employee.fullName}`);
    continue;
  }
  const { key: _key, ...fields } = employee;
  await invoke('/workforce/actions/apply-command', {
    command: { _tag: 'CreateEmployee', ...fields, id, active: true, principalRef },
    expectedRevision: records.revision,
  });
  created += 1;
  console.log(`Linked: ${employee.email} → ${employee.fullName}`);
}
console.log(JSON.stringify({ company: companyKey, legalEntityId: company.legalEntityId, apply, created }));
