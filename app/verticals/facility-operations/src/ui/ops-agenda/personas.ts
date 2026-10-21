// Siampark demo people (S00 role set) used for the assignee picker and to show who a notification/event is for.
// The principal ids are the fixed demo identities (scripts/siampark/fixtures.mts). Owned by the ops-agenda lane.
export interface Persona {
  readonly principalId: string;
  readonly email: string;
  /** i18n key suffix under `facility-operations.agenda.personas.*`. */
  readonly role: 'management' | 'operations' | 'finance' | 'external';
}

export const DEMO_TENANT_ID = '70000000-0000-4000-8000-000000000020';

export const personas: readonly Persona[] = [
  { email: 'management@siampark.demo', principalId: '72000000-0000-4000-8000-000000000021', role: 'management' },
  { email: 'operations@siampark.demo', principalId: '72000000-0000-4000-8000-000000000022', role: 'operations' },
  { email: 'finance@siampark.demo', principalId: '72000000-0000-4000-8000-000000000023', role: 'finance' },
  { email: 'external@siampark.demo', principalId: '72000000-0000-4000-8000-000000000024', role: 'external' },
];

export const personaOf = (principalId: string | undefined) =>
  principalId === undefined ? undefined : personas.find((persona) => persona.principalId === principalId);
