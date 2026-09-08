// expect-count: 1
// Evasion: the duplicate hides in an `export default` position.
import { Schema } from 'effect';

export const SettlementStatus = Schema.Literals(['pending', 'settled']);
export default Schema.Literals(['settled', 'pending']);
