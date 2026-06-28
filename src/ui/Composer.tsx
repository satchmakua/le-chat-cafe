import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRoom } from '../state/store';
import styles from './Composer.module.css';

export function Composer() {
  const [text, setText] = useState('');
  const sendUserMessage = useRoom((s) => s.sendUserMessage);

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
        placeholder="say something…"
        autoFocus
      />
      <button className={styles.send} type="submit">
        send
      </button>
    </form>
  );
}
