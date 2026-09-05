/** A service method that happens to be named like a Date accessor is not a Date. */
export class ReportService {
	private readonly stamp = "2026-01-01";

	getDate(): string {
		return this.stamp;
	}

	render(): string {
		return this.getDate();
	}
}
