import { DateTime } from 'effect';

/** Display names of the demo principals that write Siampark records; unknown principals stay anonymous. */
const principalLabels = new Map([
  ['2bdc200d-ad86-5101-b48f-a52339718354', 'Obchodník'],
  ['3f488baf-7be5-5d9d-994d-186eb91d2f3f', 'AI agent'],
  ['493dafec-c9b1-5a84-89cb-bee630de3c34', 'Vedoucí obchodu'],
  ['4f94471b-1d15-5aa9-a836-c87e0f8a449d', 'Účetní'],
  ['72000000-0000-4000-8000-000000000021', 'Vedení Siampark'],
  ['72000000-0000-4000-8000-000000000022', 'Provoz Siampark'],
  ['72000000-0000-4000-8000-000000000023', 'Účetní Siampark'],
  ['72000000-0000-4000-8000-000000000024', 'Externí partner'],
]);

export const principalLabel = (id: string) => principalLabels.get(id) ?? 'Pověřený uživatel';

const timeFormat = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
});
/** Prague wall-clock time of an ISO instant written by the owner. */
export const formatInstant = (instant: DateTime.Utc) => timeFormat.format(DateTime.toEpochMillis(instant));
