import { useEffect } from 'react';
import { MessageList } from './ui/MessageList';
import { NickList } from './ui/NickList';
import { Composer } from './ui/Composer';
import { useRoom } from './state/store';
import styles from './App.module.css';

export function App() {
  const init = useRoom((s) => s.init);
  const providerKind = useRoom((s) => s.providerKind);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div className={styles.app}>
      <nav className={styles.channels}>
        <div className={styles.logo}>le-chat-cafe</div>
        <ul>
          <li className={styles.active}># cafe</li>
        </ul>
      </nav>

      <main className={styles.main}>
        <header className={styles.topic}>
          <span># cafe — late-night chat</span>
          <span
            className={styles.status}
            data-kind={providerKind}
            title={
              providerKind === 'ollama'
                ? 'Connected to local Ollama'
                : 'Ollama not reachable — using stub replies. Start Ollama with OLLAMA_ORIGINS set, then reload.'
            }
          >
            ● {providerKind}
          </span>
        </header>
        <MessageList />
        <Composer />
      </main>

      <NickList />
    </div>
  );
}
