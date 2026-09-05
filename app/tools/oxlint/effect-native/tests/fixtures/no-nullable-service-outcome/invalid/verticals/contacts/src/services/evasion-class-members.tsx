// expect-count: 7
import { Effect } from "effect";

export interface Customer {
	readonly customerId: string;
}

export class CustomerError extends Error {}

declare function service(): (target: unknown, key?: unknown) => void;

@service()
export class CustomerContactPersistenceService {
	@service()
	async loadCustomer(customerId: string): Promise<Customer | undefined> {
		void customerId;
		return undefined;
	}

	static async loadStatic(customerId: string): Promise<Customer | null> {
		void customerId;
		return null;
	}

	get pending(): Promise<Customer | undefined> {
		return Promise.resolve(undefined);
	}

	readonly claimNext = (): Effect.Effect<Customer | null, CustomerError> => Effect.succeed(null);

	readonly findByEmail: (email: string) => Promise<Customer | undefined> = async () => undefined;
}

export const repository = {
	async loadCustomer(customerId: string): Promise<Customer | undefined> {
		void customerId;
		return undefined;
	},
	peek: async (): Promise<Customer | null> => null,
} satisfies object;

export const CustomerBadge = <P,>(props: P) => <span className="badge">{String(props)}</span>;
