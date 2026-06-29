import { useEffect, useRef } from 'react';
import { useRoom } from '../state/store';
import { formatTimestamp } from '../util/format';
import styles from './MessageList.module.css';

export function MessageList() {
  const messages = useRoom((s) => s.messages);
  const personas = useRoom((s) => s.personas);
  const forkAt = useRoom((s) => s.forkAt);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className={styles.list}>
      {messages.map((m) => {
        if (m.author === 'system') {
          return (
            <div key={m.id} className={styles.system}>
              <span className={styles.ts}>{formatTimestamp(m.ts)}</span> {m.text}
            </div>
          );
        }
        const persona = m.author === 'user' ? undefined : personas.find((p) => p.id === m.author);
        const name = m.author === 'user' ? 'you' : (persona?.name ?? m.author);
        const color = m.author === 'user' ? 'var(--user-color)' : (persona?.color ?? 'var(--fg)');
        return (
          <div key={m.id} className={styles.line}>
            <span className={styles.ts}>{formatTimestamp(m.ts)}</span>{' '}
            <span className={styles.nick} style={{ color }}>
              {name}
            </span>{' '}
            {m.pending && !m.text ? (
              <span className={styles.typing}>is typing…</span>
            ) : (
              <span className={styles.text}>
                {m.text}
                {m.pending && <span className={styles.cursor}>▋</span>}
              </span>
            )}
            {!m.pending && (
              <button
                className={styles.fork}
                onClick={() => forkAt(m.id)}
                title="rewind the conversation to here (discard everything after)"
                aria-label="rewind to here"
              >
                ⑂
              </button>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
