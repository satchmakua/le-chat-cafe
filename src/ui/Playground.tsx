import { useState } from 'react';
import { useRoom } from '../state/store';
import styles from './Playground.module.css';

export function Playground({ onClose }: { onClose: () => void }) {
  const personas = useRoom((s) => s.personas);
  const config = useRoom((s) => s.config);
  const ab = useRoom((s) => s.ab);
  const updatePersona = useRoom((s) => s.updatePersona);
  const updateConfig = useRoom((s) => s.updateConfig);
  const regenerateLast = useRoom((s) => s.regenerateLast);
  const runAB = useRoom((s) => s.runAB);
  const networked = useRoom((s) => s.networked);
  const isHost = useRoom((s) => s.isHost);
  const connect = useRoom((s) => s.connect);
  const disconnect = useRoom((s) => s.disconnect);

  const [relayUrl, setRelayUrl] = useState('ws://localhost:8787');
  const [room, setRoom] = useState('cafe');
  const [nick, setNick] = useState('guest');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');

  const [editId, setEditId] = useState(personas[0]?.id ?? '');
  const persona = personas.find((p) => p.id === editId) ?? personas[0];

  const [abPrompt, setAbPrompt] = useState('pitch me a weekend plan');
  const [abA, setAbA] = useState(personas[0]?.id ?? '');
  const [abB, setAbB] = useState(personas[1]?.id ?? '');

  if (!persona) return null;
  const nameOf = (id: string) => personas.find((p) => p.id === id)?.name ?? id;

  return (
    <aside className={styles.panel}>
      <header className={styles.head}>
        <span>⚙ playground</span>
        <button className={styles.close} onClick={onClose} aria-label="close playground">
          ✕
        </button>
      </header>

      {/* Persona editor */}
      <section className={styles.section}>
        <h3 className={styles.h3}>Persona</h3>
        <select
          className={styles.input}
          value={editId}
          onChange={(e) => setEditId(e.target.value)}
        >
          {personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <label className={styles.label}>system prompt</label>
        <textarea
          className={styles.textarea}
          value={persona.systemPrompt}
          onChange={(e) => updatePersona(persona.id, { systemPrompt: e.target.value })}
          rows={5}
        />

        <label className={styles.label}>model</label>
        <input
          className={styles.input}
          value={persona.model}
          onChange={(e) => updatePersona(persona.id, { model: e.target.value })}
        />

        <div className={styles.row}>
          <div>
            <label className={styles.label}>temperature {persona.params.temperature.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={persona.params.temperature}
              onChange={(e) =>
                updatePersona(persona.id, {
                  params: { temperature: Number(e.target.value), topP: persona.params.topP },
                })
              }
            />
          </div>
          <div>
            <label className={styles.label}>top_p {persona.params.topP.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={persona.params.topP}
              onChange={(e) =>
                updatePersona(persona.id, {
                  params: { temperature: persona.params.temperature, topP: Number(e.target.value) },
                })
              }
            />
          </div>
        </div>
        <p className={styles.hint}>Edits apply on this persona's next turn, and persist.</p>
      </section>

      {/* Conductor tuning */}
      <section className={styles.section}>
        <h3 className={styles.h3}>Room energy (Conductor)</h3>
        <label className={styles.label}>idle break (seconds): {(config.idleMs / 1000).toFixed(0)}</label>
        <input
          type="range"
          min={3}
          max={60}
          step={1}
          value={config.idleMs / 1000}
          onChange={(e) => updateConfig({ idleMs: Number(e.target.value) * 1000 })}
        />
        <label className={styles.label}>max concurrent: {config.maxConcurrent}</label>
        <input
          type="range"
          min={1}
          max={4}
          step={1}
          value={config.maxConcurrent}
          onChange={(e) => updateConfig({ maxConcurrent: Number(e.target.value) })}
        />
        <label className={styles.label}>min score (higher = quieter): {config.minScore}</label>
        <input
          type="range"
          min={0}
          max={60}
          step={1}
          value={config.minScore}
          onChange={(e) => updateConfig({ minScore: Number(e.target.value) })}
        />
      </section>

      {/* Actions */}
      <section className={styles.section}>
        <h3 className={styles.h3}>Timeline</h3>
        <button className={styles.btn} onClick={regenerateLast}>
          ↻ regenerate last line
        </button>
        <p className={styles.hint}>Fork/rewind: hover any message and click ⑂.</p>
      </section>

      {/* Multiplayer (DESIGN §11) */}
      <section className={styles.section}>
        <h3 className={styles.h3}>Multiplayer</h3>
        {networked ? (
          <>
            <p className={styles.hint}>
              Connected to "{room}" as {nick} — {isHost ? 'host (you drive the personas)' : 'viewer'}.
            </p>
            <button className={styles.btn} onClick={disconnect}>
              disconnect
            </button>
          </>
        ) : (
          <>
            <label className={styles.label}>relay URL</label>
            <input className={styles.input} value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
            <div className={styles.row}>
              <input className={styles.input} value={room} onChange={(e) => setRoom(e.target.value)} placeholder="room" />
              <input className={styles.input} value={nick} onChange={(e) => setNick(e.target.value)} placeholder="nick" />
            </div>
            <button
              className={styles.btn}
              disabled={connecting}
              onClick={() => {
                setConnecting(true);
                setConnectError('');
                connect(relayUrl, room, nick)
                  .catch(() => setConnectError('could not reach the relay — is `npm run relay` running?'))
                  .finally(() => setConnecting(false));
              }}
            >
              {connecting ? 'connecting…' : 'connect'}
            </button>
            {connectError && <p className={styles.hint}>{connectError}</p>}
            <p className={styles.hint}>Run `npm run relay`, then connect two tabs to the same room.</p>
          </>
        )}
      </section>

      {/* A/B */}
      <section className={styles.section}>
        <h3 className={styles.h3}>A/B test</h3>
        <textarea
          className={styles.textarea}
          value={abPrompt}
          onChange={(e) => setAbPrompt(e.target.value)}
          rows={2}
        />
        <div className={styles.row}>
          <select className={styles.input} value={abA} onChange={(e) => setAbA(e.target.value)}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select className={styles.input} value={abB} onChange={(e) => setAbB(e.target.value)}>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button
          className={styles.btn}
          disabled={ab.running}
          onClick={() => void runAB(abPrompt, abA, abB)}
        >
          {ab.running ? 'running…' : 'run A/B'}
        </button>
        {ab.a && ab.b && (
          <div className={styles.row}>
            <div className={styles.abOut}>
              <div className={styles.abName}>{nameOf(ab.a.personaId)}</div>
              {ab.a.text}
              {ab.a.pending && '▋'}
            </div>
            <div className={styles.abOut}>
              <div className={styles.abName}>{nameOf(ab.b.personaId)}</div>
              {ab.b.text}
              {ab.b.pending && '▋'}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}
