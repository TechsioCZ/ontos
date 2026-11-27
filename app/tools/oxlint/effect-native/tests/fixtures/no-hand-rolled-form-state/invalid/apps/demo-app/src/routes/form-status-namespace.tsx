// expect-count: 1
// React's form status read through a namespace import is still another form model.
import * as ReactDom from 'react-dom';

export const usePendingForm = () => ReactDom.useFormStatus().pending;
