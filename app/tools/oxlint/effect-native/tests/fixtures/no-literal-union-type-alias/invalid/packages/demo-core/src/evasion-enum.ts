// expect-count: 3
// `type` -> `enum` is the cheapest rewrite of the very same closed vocabulary, so an all-string
// `enum` / `const enum` must report exactly like a literal-union alias.
export enum OutboxFailureStatus {
  dead = 'dead',
  pending = 'pending',
}

const enum ModuleStateDecision {
  allow = 'allow',
  deny = 'deny',
}

export namespace EnumVocabulary {
  export enum ActionAuditProfile {
    minimal = 'minimal',
    sensitive = 'sensitive',
    standard = 'standard',
  }
}

export const decision: ModuleStateDecision = ModuleStateDecision.allow;
