import { useRoom } from '../state/store';
import styles from './NickList.module.css';

export function NickList() {
  const personas = useRoom((s) => s.personas);

  return (
    <aside className={styles.nicks}>
      <div className={styles.header}>nicks</div>
      <ul className={styles.list}>
        <li style={{ color: 'var(--user-color)' }}>you</li>
        {personas.map((p) => (
          <li key={p.id} style={{ color: p.color }}>
            {p.name}
          </li>
        ))}
      </ul>
    </aside>
  );
}
