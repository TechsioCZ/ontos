import { Schema } from "effect";

export function logged(target: unknown, context: unknown): void {
	void target;
	void context;
}

export const RepositoryRowSchema = Schema.Struct({ id: Schema.String });
export type RepositoryRow = typeof RepositoryRowSchema.Type;

export class ContactRepository {
	@logged
	find(): RepositoryRow {
		return { id: "r_1" };
	}
}
