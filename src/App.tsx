import { MessageList } from './ui/MessageList';
import { NickList } from './ui/NickList';
import { Composer } from './ui/Composer';
import styles from './App.module.css';

export function App() {
  return (
    <div className={styles.app}>
      <nav className={styles.channels}>
        <div className={styles.logo}>le-chat-cafe</div>
        <ul>
          <li className={styles.active}># cafe</li>
        </ul>
      </nav>

      <main className={styles.main}>
        <header className={styles.topic}># cafe — late-night chat</header>
        <MessageList />
        <Composer />
      </main>

      <NickList />
    </div>
  );
}
