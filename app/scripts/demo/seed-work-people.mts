#!/usr/bin/env node
/** Local, additive S13 employee-to-login bindings. Requires the running demo and accounts-admin-grants.mts.
 * Only uses governed workforce Reads/Actions; never resets another agenda or company.
 */
import { demoId, demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
const shell = 'http://localhost:3020';
const api = `${shell}/shell-super-app-api`;
const jar = new Map<string, string>();
const absorb = (response: Response) => {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
};
const call = async (path: string, payload?: unknown) => {
  const response = await fetch(`${api}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      origin: shell,
      cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  absorb(response);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};
await call('/auth/sign-in', { email: 'management@siampark.demo', password: 'password1234' });
await call('/auth/legal-entity/switch', { legalEntityId: rentalDemoLegalEntityId });
const composition = await call('/shell/composition');
const gateway = await call('/auth/gateway-context', {
  audience: 'workforce',
  compositionRevision: composition.compositionRevision,
  legalEntityId: rentalDemoLegalEntityId,
});
const invoke = async (path: string, payload: unknown) => {
  const response = await fetch(`${shell}${gateway.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: shell,
      authorization: `Bearer ${gateway.token}`,
      'x-ontos-composition-revision': gateway.compositionRevision,
      'x-correlation-id': `seed-work-people-${Date.now()}`,
      'idempotency-key': `seed-work-people-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};
for (const [key, name, role, department, suffix] of [
  ['management', 'Vedení Siampark', 'SALES_HEAD', 'Vedení', '21'],
  ['operations', 'Provoz Siampark', 'SUPPORT', 'Správa areálu', '22'],
  ['finance', 'Účetní Siampark', 'ACCOUNTANT', 'Finance', '23'],
  ['external', 'Externí obchodník', 'SALES_REP', 'Externí spolupráce', '24'],
] as const) {
  const records = await invoke('/reads/records', {});
  const id = demoId('workforce.employee', `siampark-${key}`);
  const email = `${key}@siampark.demo`;
  const existing = records.items.find((item: { id: string; email: string }) => item.id === id || item.email === email);
  if (existing !== undefined) {
    console.log(`Already linked: ${email}`);
    continue;
  }
  await invoke('/workforce/actions/apply-command', {
    command: {
      _tag: 'CreateEmployee',
      id,
      fullName: name,
      email,
      role,
      department,
      active: true,
      principalRef: { principalId: `72000000-0000-4000-8000-0000000000${suffix}`, tenantId: demoTenantId },
    },
    expectedRevision: records.revision,
  });
  console.log(`Linked: ${email} → ${name}`);
}
