import { Outlet } from '@modern-js/plugin-tanstack/runtime';
import type { ReactElement } from 'react';

import { ultramodernUiMarker } from '../../../shared/ultramodern-build.ts';

// Pages under this layout double as Shell module pages, so the UI release marker lives here,
// where only this vertical's own Worker renders it; the root layout stays the generated scaffold.
const LanguageLayout = (): ReactElement => (
  <div data-build-marker={ultramodernUiMarker.build}>
    <Outlet />
  </div>
);

export default LanguageLayout;
