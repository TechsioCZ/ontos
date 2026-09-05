// Fewer than `minMembers` (2) real literals: a name, or an absence, not a closed vocabulary.
export type ContactKind = 'customer';

export type Absent = null | undefined;

export type MaybeDraft = 'draft' | null;

export type MaybeFinal = 'final' | undefined;

export type LeadingPipeSingle = | 'solo';
