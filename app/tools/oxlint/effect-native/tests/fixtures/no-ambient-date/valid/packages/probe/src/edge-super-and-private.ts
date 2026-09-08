/** `this` / `super` receivers and private members are not `Date` receivers. */
class BaseReport {
	readonly #stamp = "2026-01-01";

	protected getTime(): number {
		return 0;
	}

	protected readStamp(): string {
		return this.#stamp;
	}
}

export class Report extends BaseReport {
	render(): string {
		return `${super.getTime()}:${this.getTime()}:${this.readStamp()}`;
	}
}
