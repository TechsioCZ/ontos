// expect-count: 2
import { waitFor } from '@testing-library/react';
import { expect, rs } from 'effect-rstest';

const onSave = rs.fn();
await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
await rs.waitUntil(() => onSave.mock.calls.length > 0);
