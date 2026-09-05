// expect-count: 2
// Decorated class fields still hand a throwing decoder to the framework.
import { Schema } from 'effect';

const ContributionSchema = Schema.Struct({ slot: Schema.String });

const validated =
	(decoder: (value: unknown) => unknown) =>
	(target: unknown, key: string): void => {
		void decoder;
		void target;
		void key;
	};

export class ShellContribution {
	@validated(Schema.decodeUnknownSync(ContributionSchema))
	slot = '';

	toJSON(): unknown {
		return Schema.encodeUnknownSync(ContributionSchema)({ slot: this.slot });
	}
}
