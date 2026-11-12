import { useMemo } from 'react';
import { selfName, useRoom } from '../state/store';
import { baselineAffinity } from '../runtime/affinity';
import { onlineSet } from '../core/presence';
import { membersOf } from '../core/channels';
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
  const me = useRoom(selfName);
  const openProfile = useRoom((s) => s.openProfile);
  const messages = useRoom((s) => s.messages);
  const muted = useRoom((s) => s.muted);
  const channel = useRoom((s) => s.channel);
  // Only this channel's crowd (DESIGN §12.4); presence is derived from its log
  // (§12.2), and present personas list first.
  const members = useMemo(() => membersOf(channel, personas), [channel, personas]);
  const online = useMemo(() => onlineSet(messages, members), [messages, members]);
  const isHere = (id: string) => online.has(id) && !muted.includes(id);
  const ordered = [...members].sort((a, b) => Number(isHere(b.id)) - Number(isHere(a.id)));
  const presentCount = members.filter((p) => isHere(p.id)).length;

  return (
    <aside className={styles.nicks}>
      <div className={styles.header}>nicks · {presentCount + 1 + remoteHumans.length}</div>
      <ul className={styles.list}>
        <li style={{ color: 'var(--user-color)' }}>
          {me || 'you'}
          {me && <span className={styles.aff}> (you)</span>}
        </li>
        {remoteHumans.map((h) => (
          <li key={h.id} style={{ color: 'var(--user-color)' }}>
            {h.name}
            {h.isHost && <span className={styles.aff}> (host)</span>}
          </li>
        ))}
        {ordered.map((p) => {
          const aff = relationships[`${p.id}:user`]?.affinity ?? baselineAffinity(p, 'user');
          const here = isHere(p.id);
          return (
            <li key={p.id} style={{ color: p.color }} className={here ? undefined : styles.away}>
              <button
                className={styles.nickButton}
                style={{ color: p.color }}
                onClick={() => openProfile(p.id)}
                title={`${p.name}'s profile`}
              >
                {p.name}
              </button>
              {!here && <span className={styles.awayTag}> away</span>}
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
