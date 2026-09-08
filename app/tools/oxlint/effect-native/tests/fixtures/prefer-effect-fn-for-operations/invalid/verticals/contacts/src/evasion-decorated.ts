// expect-count: 1
import { Effect } from "effect";

declare const traced: MethodDecorator;

export class ContactService {
	@traced
	find(id: string) {
		return Effect.gen(function* () {
			yield* Effect.log(id);
		});
	}
}
