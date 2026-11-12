import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRoom } from '../state/store';
import { dmPersonaId } from '../core/channels';
import styles from './Composer.module.css';

export function Composer() {
  const [text, setText] = useState('');
  const sendUserMessage = useRoom((s) => s.sendUserMessage);
  // In a DM, say who's listening; in a channel, the usual prompt.
  const placeholder = useRoom((s) => {
    const dm = dmPersonaId(s.channel);
    const name = dm ? s.personas.find((p) => p.id === dm)?.name : undefined;
    return name ? `message ${name}…` : 'say something…';
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pending = text;
    setText('');
    sendUserMessage(pending);
  };

  return (
    <form className={styles.composer} onSubmit={submit}>
      <input
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        autoFocus
      />
      <button className={styles.send} type="submit">
        send
      </button>
    </form>
  );
}
