import { useEffect, useRef } from 'react';
import { selfName, useRoom } from '../state/store';
import { containsToken } from '../core/conductor';
import { cleanPersonaLine } from '../runtime/personaRuntime';
import { formatTimestamp } from '../util/format';
import styles from './MessageList.module.css';

export function MessageList() {
  const messages = useRoom((s) => s.messages);
  const personas = useRoom((s) => s.personas);
  const forkAt = useRoom((s) => s.forkAt);
  const myIds = useRoom((s) => s.myIds);
  const remoteParticipants = useRoom((s) => s.remoteParticipants);
  const participantNames = useRoom((s) => s.participantNames);
  const me = useRoom(selfName);
  const openProfile = useRoom((s) => s.openProfile);
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
        const isMe = m.author === 'user' || myIds.includes(m.author);
        const isHuman = isMe || m.author.startsWith('human:');
        const persona = isHuman ? undefined : personas.find((p) => p.id === m.author);
        // Render-side backstop (DESIGN §9): machine markup never shows, even in a line
        // stored before a strip rule caught it, or relayed by an older host.
        const text = persona ? cleanPersonaLine(m.text, persona.name) : m.text;
        if (persona && !m.pending && !text) return null;
        const name = isMe
          ? me || 'you'
          : isHuman
            ? (remoteParticipants.find((p) => p.id === m.author)?.name ??
              participantNames[m.author] ??
              m.author)
            : (persona?.name ?? m.author);
        const color = isHuman ? 'var(--user-color)' : (persona?.color ?? 'var(--fg)');
        // IRC-style highlight: someone else's line that says your name.
        const mentionsMe = !isMe && !m.pending && !!me && containsToken(text, me);
        return (
          <div key={m.id} className={mentionsMe ? `${styles.line} ${styles.mention}` : styles.line}>
            <span className={styles.ts}>{formatTimestamp(m.ts)}</span>{' '}
            <span
              className={persona ? `${styles.nick} ${styles.clickable}` : styles.nick}
              style={{ color }}
              onClick={persona ? () => openProfile(persona.id) : undefined}
            >
              {name}
            </span>{' '}
            {m.pending && !text ? (
              <span className={styles.typing}>is typing…</span>
            ) : (
              <span className={styles.text}>
                {text}
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
