import { useRoom } from '../state/store';
import { baselineAffinity } from '../runtime/affinity';
import styles from './NickList.module.css';

function affColor(a: number): string {
  if (a >= 0.2) return '#6fd66f'; // warm
  if (a > -0.2) return 'var(--dim)'; // neutral
  return '#d9695a'; // cool
}

export function NickList() {
  const personas = useRoom((s) => s.personas);
  const generating = useRoom((s) => s.generating);
  const relationships = useRoom((s) => s.relationships);
  const myId = useRoom((s) => s.myId);
  const remoteHumans = useRoom((s) => s.remoteParticipants).filter(
    (p) => p.kind === 'human' && p.id !== myId,
  );

  return (
    <aside className={styles.nicks}>
      <div className={styles.header}>nicks · {personas.length + 1 + remoteHumans.length}</div>
      <ul className={styles.list}>
        <li style={{ color: 'var(--user-color)' }}>you</li>
        {remoteHumans.map((h) => (
          <li key={h.id} style={{ color: 'var(--user-color)' }}>
            {h.name}
            {h.isHost && <span className={styles.aff}> (host)</span>}
          </li>
        ))}
        {personas.map((p) => {
          const aff = relationships[`${p.id}:user`]?.affinity ?? baselineAffinity(p, 'user');
          return (
            <li key={p.id} style={{ color: p.color }}>
              {p.name}
              {generating.includes(p.id) && <span className={styles.typing}> …</span>}
              <span
                className={styles.aff}
                style={{ color: affColor(aff) }}
                title={`feels ${aff.toFixed(2)} toward you`}
              >
                ♥
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
