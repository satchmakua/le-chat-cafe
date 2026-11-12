import { useRoom } from '../state/store';
import { HOME, dmId } from '../core/channels';
import styles from './ChannelList.module.css';

function Badge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className={styles.badge} aria-label={`${count} unread`}>
      {count}
    </span>
  );
}

/** The left pane (DESIGN §12.4): channels you've joined, then your DMs. A shared
 *  room is one channel, so while connected it shows only that. */
export function ChannelList() {
  const channel = useRoom((s) => s.channel);
  const joined = useRoom((s) => s.joined);
  const dms = useRoom((s) => s.dms);
  const unread = useRoom((s) => s.unread);
  const personas = useRoom((s) => s.personas);
  const networked = useRoom((s) => s.networked);
  const connection = useRoom((s) => s.connection);
  const switchChannel = useRoom((s) => s.switchChannel);
  const closeWindow = useRoom((s) => s.closeWindow);

  if (networked) {
    return (
      <ul className={styles.list}>
        <li>
          <span className={`${styles.item} ${styles.active}`}># {connection?.room ?? HOME}</span>
        </li>
      </ul>
    );
  }

  const dmPersonas = dms
    .map((id) => personas.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => !!p);

  return (
    <>
      <ul className={styles.list}>
        {joined.map((id) => (
          <li key={id}>
            <button
              className={`${styles.item} ${id === channel ? styles.active : ''}`}
              onClick={() => switchChannel(id)}
              aria-current={id === channel ? 'page' : undefined}
            >
              # {id}
              <Badge count={unread[id]} />
            </button>
          </li>
        ))}
      </ul>
      {dmPersonas.length > 0 && (
        <>
          <div className={styles.heading}>messages</div>
          <ul className={styles.list}>
            {dmPersonas.map((p) => {
              const id = dmId(p.id);
              return (
                <li key={id} className={styles.row}>
                  <button
                    className={`${styles.item} ${id === channel ? styles.active : ''}`}
                    onClick={() => switchChannel(id)}
                    aria-current={id === channel ? 'page' : undefined}
                  >
                    <span style={{ color: p.color }}>@{p.name}</span>
                    <Badge count={unread[id]} />
                  </button>
                  <button
                    className={styles.close}
                    onClick={() => closeWindow(id)}
                    title={`close the chat with ${p.name}`}
                    aria-label={`close the chat with ${p.name}`}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
