import { useEffect, useState } from 'react';
import { MessageList } from './ui/MessageList';
import { NickList } from './ui/NickList';
import { Composer } from './ui/Composer';
import { Playground } from './ui/Playground';
import { useRoom } from './state/store';
import styles from './App.module.css';

type Theme = 'crt' | 'aim';

export function App() {
  const init = useRoom((s) => s.init);
  const providerKind = useRoom((s) => s.providerKind);
  const topic = useRoom((s) => s.topic);
  const [showPlayground, setShowPlayground] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme | null) ?? 'crt',
  );

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

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
          <span># cafe{topic ? ` — ${topic}` : ' — late-night chat'}</span>
          <span className={styles.headRight}>
            <button
              className={styles.gear}
              onClick={() => setTheme((t) => (t === 'crt' ? 'aim' : 'crt'))}
              title="toggle CRT / AIM theme"
            >
              {theme === 'crt' ? '◓ aim' : '◑ crt'}
            </button>
            <button
              className={styles.gear}
              onClick={() => setShowPlayground((v) => !v)}
              title="playground"
            >
              ⚙
            </button>
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
          </span>
        </header>
        <MessageList />
        <Composer />
      </main>

      <NickList />

      {showPlayground && <Playground onClose={() => setShowPlayground(false)} />}
    </div>
  );
}
