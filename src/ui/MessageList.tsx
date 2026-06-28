import { useEffect, useRef } from 'react';
import { useRoom } from '../state/store';
import { formatTimestamp } from '../util/format';
import styles from './MessageList.module.css';

export function MessageList() {
  const messages = useRoom((s) => s.messages);
  const personas = useRoom((s) => s.personas);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const colorOf = (author: string) =>
    author === 'user'
      ? 'var(--user-color)'
      : (personas.find((p) => p.id === author)?.color ?? 'var(--fg)');

  const nameOf = (author: string) =>
    author === 'user' ? 'you' : (personas.find((p) => p.id === author)?.name ?? author);

  return (
    <div className={styles.list}>
      {messages.map((m) => (
        <div key={m.id} className={styles.line}>
          <span className={styles.ts}>{formatTimestamp(m.ts)}</span>{' '}
          <span className={styles.nick} style={{ color: colorOf(m.author) }}>
            {nameOf(m.author)}
          </span>{' '}
          <span className={styles.text}>
            {m.text}
            {m.pending && <span className={styles.cursor}>▋</span>}
          </span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
