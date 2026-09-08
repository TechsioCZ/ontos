// expect-count: 4
import { Effect as Eff } from "effect";
import * as EffectBarrel from "effect";
import * as EffectModule from "effect/Effect";
import type { Effect as EffectType } from "effect/Effect";

export interface CustomerContactRow {
	readonly contactId: string;
}

export class CustomerContactPersistenceError extends Error {}

export interface CustomerContactPersistenceService {
	readonly loadContact: (contactId: string) => Eff.Effect<CustomerContactRow | null, CustomerContactPersistenceError>;
	readonly loadPrimary: (
		customerId: string,
	) => EffectBarrel.Effect.Effect<CustomerContactRow | undefined, CustomerContactPersistenceError>;
	readonly loadLatest: (
		customerId: string,
	) => EffectModule.Effect<CustomerContactRow | null, CustomerContactPersistenceError>;
	readonly loadDraft: (
		draftId: string,
	) => EffectType<CustomerContactRow | undefined, CustomerContactPersistenceError>;
}
