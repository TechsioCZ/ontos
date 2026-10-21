const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * facility.operations keeps one revision per agenda (records `agendas.<agenda>.revision`); the command tag prefix
 * names the agenda (shared/commands/<agenda>.ts in that module).
 */
const FACILITY_AGENDA_BY_TAG_PREFIX: readonly (readonly [string, string])[] = [
  ['Agenda', 'agenda'],
  ['Asset', 'assets'],
  ['Document', 'documents'],
  ['Meter', 'meters'],
  ['Purchase', 'purchasing'],
  ['Stock', 'purchasing'],
  ['Sales', 'sales'],
  ['Security', 'security'],
];

/** The revision a command must carry: the module-wide `revision`, or the revision of the command's agenda. */
export const commandRevisionFrom = (body: unknown, command: Readonly<Record<string, unknown>>): number | undefined => {
  if (!isRecord(body)) {
    return undefined;
  }
  if (typeof body['revision'] === 'number') {
    return body['revision'];
  }
  const tag = command['_tag'];
  const agendas = body['agendas'];
  if (typeof tag !== 'string' || !isRecord(agendas)) {
    return undefined;
  }
  const agenda = FACILITY_AGENDA_BY_TAG_PREFIX.find(([prefix]) => tag.startsWith(prefix))?.[1];
  const part = agenda === undefined ? undefined : agendas[agenda];
  return isRecord(part) && typeof part['revision'] === 'number' ? part['revision'] : undefined;
};
