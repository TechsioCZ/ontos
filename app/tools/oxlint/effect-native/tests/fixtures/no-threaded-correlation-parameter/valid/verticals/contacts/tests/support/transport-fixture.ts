// D tier: test fixtures may hand-build transport bags (`includeTests: false`).
export interface FixtureTransport {
	readonly correlationId: string;
	readonly idempotencyKey: string;
}

export const makeTransport = (correlationId: string): FixtureTransport => ({
	correlationId,
	idempotencyKey: 'fixture',
});

export const withTransport = ({ correlationId }: FixtureTransport) => correlationId;
