import { useEffect, useMemo } from 'react';
import { useRoom } from '../state/store';
import { onlineSet } from '../core/presence';
import { dmId, isDm, membersOf } from '../core/channels';
import { resolveModel } from '../llm/models';
import { ago, buildProfile, type ProfileStatus } from '../runtime/profile';
import styles from './ProfileCard.module.css';

const STATUS_TEXT: Record<ProfileStatus, string> = {
  here: 'here now',
  away: 'away',
  kicked: 'kicked',
};

/** A −1..1 feeling as a bar growing out of the centre (warm right, cool left). */
function Meter({ value }: { value: number }) {
  const width = Math.min(1, Math.abs(value)) * 50;
  const left = value >= 0 ? 50 : 50 - width;
  return (
    <div className={styles.meter} title={value.toFixed(2)}>
      <div
        className={styles.fill}
        style={{ left: `${left}%`, width: `${width}%`, background: value >= 0 ? '#6fd66f' : '#d9695a' }}
      />
      <div className={styles.zero} />
    </div>
  );
}

/** The `/whois` card (DESIGN §12.3): a read-out of state the sim already keeps. */
export function ProfileCard() {
  const profileId = useRoom((s) => s.profileId);
  const close = useRoom((s) => s.closeProfile);
  const personas = useRoom((s) => s.personas);
  const messages = useRoom((s) => s.messages);
  const muted = useRoom((s) => s.muted);
  const memory = useRoom((s) => s.memory);
  const relationships = useRoom((s) => s.relationships);
  const affinityOf = useRoom((s) => s.affinityOf);
  const availableModels = useRoom((s) => s.availableModels);
  const runCommand = useRoom((s) => s.runCommand);
  const openDm = useRoom((s) => s.openDm);
  const forget = useRoom((s) => s.forget);
  const channel = useRoom((s) => s.channel);
  const networked = useRoom((s) => s.networked);
  const canModerate = useRoom((s) => !s.networked || s.isHost);

  useEffect(() => {
    if (!profileId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [profileId, close]);

  const persona = personas.find((p) => p.id === profileId);
  // Status is about the window you're in: someone who doesn't hang out here is away.
  const inThisChannel = !!persona && membersOf(channel, personas).some((p) => p.id === persona.id);
  const profile = useMemo(
    () =>
      persona
        ? buildProfile(persona, {
            personas,
            messages,
            online: onlineSet(messages, membersOf(channel, personas)),
            muted,
            notes: memory[persona.id]?.notes ?? [],
            // Pure resolution — `modelFor` would post a notice, and render must not write.
            model: resolveModel(persona.model, availableModels),
            affinityOf,
          })
        : null,
    // `relationships` is listed so feelings refresh as affinity moves.
    [persona, personas, messages, channel, muted, memory, relationships, affinityOf, availableModels],
  );
  if (!persona || !profile) return null;

  const act = (cmd: string) => {
    runCommand(`/${cmd} ${profile.name}`);
    close();
  };

  return (
    <div className={styles.backdrop} onClick={close}>
      <div
        className={styles.card}
        role="dialog"
        aria-label={`${profile.name}'s profile`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.head}>
          <span className={styles.name} style={{ color: profile.color }}>
            {profile.name}
          </span>
          <span className={styles.status} data-status={profile.status}>
            {STATUS_TEXT[profile.status]}
          </span>
          <button className={styles.close} onClick={close} aria-label="close profile">
            ✕
          </button>
        </header>

        {profile.bio && <p className={styles.bio}>{profile.bio}</p>}

        <section className={styles.section}>
          <h4 className={styles.h4}>feels about you</h4>
          <div className={styles.feeling}>
            <Meter value={profile.towardYou.value} />
            <span className={styles.label}>{profile.towardYou.label}</span>
          </div>
        </section>

        <section className={styles.section}>
          <h4 className={styles.h4}>remembers</h4>
          {profile.remembers.length > 0 ? (
            <ul className={styles.notes}>
              {profile.remembers.map((n, i) => (
                <li key={i} className={styles.note}>
                  <span>{n}</span>
                  {/* Summaries can get a detail wrong; let them unlearn it. */}
                  <button
                    className={styles.forget}
                    onClick={() => forget(persona.id, n)}
                    title="forget this"
                    aria-label={`forget: ${n}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.dim}>nothing yet — talk a while and it'll stick</p>
          )}
        </section>

        <section className={styles.section}>
          <h4 className={styles.h4}>about the others</h4>
          {profile.peers.map((f) => (
            <div key={f.id} className={styles.peer}>
              <span className={styles.peerName} style={{ color: f.color }}>
                {f.name}
              </span>
              <Meter value={f.value} />
              <span className={styles.label}>{f.label}</span>
            </div>
          ))}
        </section>

        <section className={styles.section}>
          <h4 className={styles.h4}>into</h4>
          <div className={styles.chips}>
            {profile.interests.map((i) => (
              <span key={i} className={styles.chip}>
                {i}
              </span>
            ))}
          </div>
        </section>

        <footer className={styles.foot}>
          <span className={styles.dim}>
            {profile.model} · {profile.lastSpokeTs ? `last spoke ${ago(profile.lastSpokeTs)}` : 'hasn’t spoken yet'}
          </span>
          <span className={styles.actions}>
            {!networked && dmId(persona.id) !== channel && (
              <button
                className={styles.action}
                onClick={() => {
                  close();
                  openDm(persona.id);
                }}
              >
                message
              </button>
            )}
            {canModerate &&
              inThisChannel &&
              !isDm(channel) &&
              (profile.status === 'kicked' || profile.status === 'away' ? (
                <button className={styles.action} onClick={() => act('invite')}>
                  invite
                </button>
              ) : (
                <button className={styles.action} onClick={() => act('kick')}>
                  kick
                </button>
              ))}
          </span>
        </footer>
      </div>
    </div>
  );
}
