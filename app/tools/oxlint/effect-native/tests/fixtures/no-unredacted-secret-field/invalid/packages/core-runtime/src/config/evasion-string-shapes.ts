// expect-count: 3
// Evasion: widen the annotation just enough to fall out of `isStringShaped`. Each of these is
// still an unstructured, loggable string. (A union that contains no `string` keyword — the
// blessed `credential: 'api_key' | 'session'` vocabulary — must stay silent.)
export interface GatewaySecrets {
  readonly apiKey: `sk-${string}`;
  readonly password: string & {};
  readonly secret: string | 'unset';
}

export interface BlessedVocabulary {
  readonly credential: 'api_key' | 'session';
}
