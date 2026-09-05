// expect-count: 3
import { Effect } from "effect";

export interface Customer {
	readonly customerId: string;
}

export interface CustomerLoader {
	readonly loadCustomer: (customerId: string) => Promise<Customer | undefined>;
}

const fetchCustomer = async (customerId: string): Promise<Customer | null> => {
	void customerId;
	return null;
};

export function CustomerPage() {
	const load: () => Effect.Effect<Customer | undefined, never> = () => Effect.succeed(undefined);
	void load;
	void fetchCustomer;
	return <div className="customers">ok</div>;
}
