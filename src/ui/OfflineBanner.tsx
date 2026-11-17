import { useState } from 'react';
import { useRoom } from '../state/store';
import styles from './OfflineBanner.module.css';

/**
 * Says plainly when the personas aren't really there (DESIGN §9): Ollama can't be
 * reached, or the room is in demo mode on placeholder lines. The store keeps probing
 * and switches over by itself; "try again" just does it now.
 */
export function OfflineBanner() {
  const kind = useRoom((s) => s.providerKind);
  const ready = useRoom((s) => s.ready);
  // In a shared room only the host runs the personas; a viewer has nothing to fix.
  const drives = useRoom((s) => !s.networked || s.isHost);
  const reconnect = useRoom((s) => s.reconnect);
  const startDemo = useRoom((s) => s.startDemo);
  const [state, setState] = useState<'idle' | 'checking' | 'failed'>('idle');

  if (!ready || kind === 'ollama' || !drives) return null;

  const retry = async () => {
    setState('checking');
    setState((await reconnect()) ? 'idle' : 'failed');
  };

  return (
    <div className={styles.banner} role="status" data-kind={kind}>
      {kind === 'offline' ? (
        <div className={styles.text}>
          <strong>The regulars are offline.</strong> This page can&apos;t reach Ollama on this
          computer, so nobody can answer yet. Open the Ollama app (or run{' '}
          <code>ollama serve</code>) and they&apos;ll come back on their own.
          <span className={styles.hint}>
            Already running? It may be refusing this page: start it with{' '}
            <code>OLLAMA_ORIGINS=*</code>.
          </span>
        </div>
      ) : (
        <div className={styles.text}>
          <strong>Demo mode.</strong> These are placeholder lines, not the personas. Start Ollama
          and the real ones take over.
        </div>
      )}
      <div className={styles.actions}>
        {state === 'failed' && <span className={styles.hint}>still no answer</span>}
        <button className={styles.button} onClick={() => void retry()} disabled={state === 'checking'}>
          {state === 'checking' ? 'checking…' : 'try again'}
        </button>
        {kind === 'offline' && (
          <button className={styles.button} onClick={startDemo} title="placeholder lines, to look around">
            demo mode
          </button>
        )}
      </div>
    </div>
  );
}
