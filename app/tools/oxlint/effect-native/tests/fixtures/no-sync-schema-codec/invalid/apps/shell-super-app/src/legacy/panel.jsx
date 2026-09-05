// expect-count: 1
// Plain `.jsx` (no TypeScript): the rule documents `.jsx` coverage.
import { Schema } from 'effect';

const PanelSchema = Schema.Struct({ title: Schema.String });

export const Panel = ({ raw }) => <span>{Schema.decodeUnknownSync(PanelSchema)(raw).title}</span>;
