/**
 * Czech text for OntOS errors returned to MCP clients (design §5.3: short Czech sentence plus a machine code).
 * English upstream detail never reaches the model text; it stays in `_meta` for debugging.
 */
export interface UpstreamProblem {
  readonly code?: string | undefined;
  readonly detail?: string | undefined;
  readonly status: number;
  readonly title?: string | undefined;
}

export interface CzechProblem {
  readonly code: string;
  readonly meta: { readonly 'ontos/code': string; readonly 'ontos/detail'?: string; readonly 'ontos/status': number };
  readonly text: string;
}

const CZECH_LETTERS = /[áčďéěíňóřšťúůýž]/iu;
const SCHEMA_HINT = 'Vstupní schéma vrátí ontos_capabilities {id}.';

/** Known English problem details (or codes) with their Czech sentence. */
const BY_DETAIL: readonly (readonly [RegExp, string])[] = [
  [
    /reserved for human users/iu,
    'Tuto změnu smí v tomto modulu udělat jen člověk přímo v OntOS, ne připojená aplikace.',
  ],
  [/module is forbidden in the selected context/iu, 'Tento modul není pro toto připojení v této firmě dostupný.'],
  [/not permitted to perform this read/iu, 'OntOS toto čtení tomuto připojení nepovolil.'],
  [/not permitted/iu, 'OntOS tuto operaci tomuto připojení nepovolil.'],
  [/temporarily unavailable/iu, 'Modul je teď dočasně nedostupný. Zkuste to prosím za chvíli.'],
  [/request is invalid|invalid request|failed to decode|schema/iu, `OntOS vstup odmítl jako neplatný. ${SCHEMA_HINT}`],
  [/require[sd]? write permission/iu, 'Na tuto změnu nemá toto připojení oprávnění k zápisu.'],
];

const BY_CODE = new Map<string, string>(
  Object.entries({
    action_request_hash_conflict:
      'Stejný klíč idempotencyKey už byl použit pro jinou změnu. Pro novou změnu pošlete nový klíč (nebo ho vynechte).',
    connection_scope: 'Toto připojení na tuto operaci nemá rozsah.',
    read_permission_denied: 'OntOS toto čtení tomuto připojení nepovolil.',
    revision_conflict: 'Záznam se mezitím změnil. Načtěte aktuální stav (ontos_read) a zkuste to znovu.',
    stale_revision: 'Záznam se mezitím změnil. Načtěte aktuální stav (ontos_read) a zkuste to znovu.',
  }),
);

const BY_STATUS = (status: number): string => {
  if (status === 400 || status === 422) {
    return `OntOS vstup odmítl jako neplatný. ${SCHEMA_HINT}`;
  }
  if (status === 403) {
    return 'OntOS tuto operaci tomuto připojení nepovolil.';
  }
  if (status === 404) {
    return 'Záznam nebo modul nebyl nalezen.';
  }
  if (status === 409) {
    return 'Změna koliduje s aktuálním stavem (záznam se mezitím změnil). Načtěte aktuální stav (ontos_read) a zkuste to znovu.';
  }
  if (status === 429) {
    return 'Příliš mnoho požadavků najednou. Zkuste to prosím za chvíli.';
  }
  if (status >= 500) {
    return 'OntOS teď neodpověděl správně. Zkuste to prosím za chvíli.';
  }
  return 'OntOS požadavek nepřijal.';
};

/** Czech sentence + code for an upstream problem. A detail already written in Czech is kept. */
export const czechProblem = (problem: UpstreamProblem): CzechProblem => {
  const detail = (problem.detail ?? problem.title ?? '').trim();
  const code = problem.code ?? `http_${problem.status}`;
  const known =
    BY_DETAIL.find(([pattern]) => pattern.test(detail))?.[1] ??
    (problem.code === undefined ? undefined : BY_CODE.get(problem.code));
  let sentence: string;
  if (CZECH_LETTERS.test(detail) && problem.status < 500) {
    sentence = /[.!?]$/u.test(detail) ? detail : `${detail}.`;
    if (problem.status === 403 && !/nepovolil|oprávnění|smí/iu.test(sentence)) {
      sentence = `OntOS tuto operaci nepovolil: ${sentence}`;
    }
  } else {
    sentence = known ?? BY_STATUS(problem.status);
  }
  const meta: CzechProblem['meta'] = { 'ontos/code': code, 'ontos/status': problem.status };
  return {
    code,
    meta: detail === '' ? meta : { ...meta, 'ontos/detail': detail },
    text: `${sentence} (kód ${code})`,
  };
};
