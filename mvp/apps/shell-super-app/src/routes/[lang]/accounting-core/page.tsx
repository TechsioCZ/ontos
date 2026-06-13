import ShellFrame from '../../shell-frame';
import { VerticalRouteSurface } from '../../vertical-components';

export default function ShellAccountingCoreRoute() {
  return (
    <ShellFrame>
      <VerticalRouteSurface moduleId="accounting.core" />
    </ShellFrame>
  );
}
