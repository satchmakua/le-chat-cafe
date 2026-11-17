import { useEffect, useState } from 'react';
import { MessageList } from './ui/MessageList';
import { NickList } from './ui/NickList';
import { Composer } from './ui/Composer';
import { Playground } from './ui/Playground';
import { ProfileCard } from './ui/ProfileCard';
import { ChannelList } from './ui/ChannelList';
import { OfflineBanner } from './ui/OfflineBanner';
import { useRoomAlerts } from './ui/useRoomAlerts';
import { playCue } from './ui/sounds';
import { useRoom } from './state/store';
import { channelLabel, isDm } from './core/channels';
import { channels } from './channels';
import styles from './App.module.css';

type Theme = 'crt' | 'aim';

export function App() {
  const init = useRoom((s) => s.init);
  const providerKind = useRoom((s) => s.providerKind);
  const ready = useRoom((s) => s.ready);
  const channel = useRoom((s) => s.channel);
  const personas = useRoom((s) => s.personas);
  // A DM has no topic; a channel shows its /topic, else the default from its JSON.
  const topic = useRoom((s) =>
    isDm(s.channel)
      ? 'private chat'
      : s.topics[s.channel] || (channels.find((c) => c.id === s.channel)?.topic ?? ''),
  );
  const [showPlayground, setShowPlayground] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme | null) ?? 'crt',
  );
  // Room sounds (DESIGN §12.5): on unless this browser turned them off.
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('sounds') !== 'off');
  useRoomAlerts(soundOn);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    localStorage.setItem('sounds', next ? 'on' : 'off');
    if (next) playCue('chime'); // a preview — and the click unlocks audio for the page
  };

  return (
    <div className={styles.app}>
      <nav className={styles.channels}>
        <div className={styles.logo}>le-chat-cafe</div>
        <ChannelList />
      </nav>

      <main className={styles.main}>
        <header className={styles.topic}>
          <span>
            {channelLabel(channel, personas)}
            {topic ? ` — ${topic}` : ''}
          </span>
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
              onClick={toggleSound}
              title={soundOn ? 'sounds on — click to mute' : 'sounds off — click to turn on'}
              aria-pressed={soundOn}
              aria-label="room sounds"
            >
              {soundOn ? '♪ on' : '♪ off'}
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
                  : providerKind === 'offline'
                    ? 'Ollama not reachable — the personas are offline until it is.'
                    : 'Demo mode — placeholder lines, not the personas.'
              }
            >
              ● {!ready ? '…' : providerKind === 'mock' ? 'demo' : providerKind}
            </span>
          </span>
        </header>
        <MessageList />
        <OfflineBanner />
        <Composer />
      </main>

      <NickList />

      {showPlayground && <Playground onClose={() => setShowPlayground(false)} />}
      <ProfileCard />
    </div>
  );
}
