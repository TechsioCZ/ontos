import { screen, waitFor } from '@testing-library/react';
import { expect } from 'effect-rstest';

await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
