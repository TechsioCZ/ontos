// expect-count: 4
import './index.css';
import styles from './card.module.css';
import '@techsio/ui-kit/theme.css';

export { styles };
export const lazy = () => import('./print.scss?inline');
