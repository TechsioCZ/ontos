// expect-count: 1
// A field binding reached through a namespace import and rendered directly gets no effect-form state either.
import * as Forms from '@app/core-runtime/ui/form';

export const Loose = () => <Forms.TextField field={undefined as never} props={{ label: 'Name' }} />;
