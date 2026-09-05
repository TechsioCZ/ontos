// expect-count: 2
// Tests are in scope by default (`ignoreTests: false`): a hand-rolled test vocabulary drifts too.
type FakeUnavailableUiState = 'forbidden' | 'unavailable';

type TestActionOutcome = 'failed' | 'skipped' | 'succeeded';

export const states: readonly [FakeUnavailableUiState, TestActionOutcome] = ['forbidden', 'failed'];
