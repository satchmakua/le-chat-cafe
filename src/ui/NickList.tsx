import { useRoom } from '../state/store';
import styles from './NickList.module.css';

export function NickList() {
  const personas = useRoom((s) => s.personas);
  const generating = useRoom((s) => s.generating);

  return (
    <aside className={styles.nicks}>
      <div className={styles.header}>nicks · {personas.length + 1}</div>
      <ul className={styles.list}>
        <li style={{ color: 'var(--user-color)' }}>you</li>
        {personas.map((p) => (
          <li key={p.id} style={{ color: p.color }}>
            {p.name}
            {generating.includes(p.id) && <span className={styles.typing}> …</span>}
          </li>
        ))}
      </ul>
    </aside>
  );
}
