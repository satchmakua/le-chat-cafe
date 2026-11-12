import 'fake-indexeddb/auto'; // the store persists fire-and-forget; give it a database
import { describe, it, expect, beforeEach } from 'vitest';
import { useRoom } from '../src/state/store';
import type { ChatChunk, ChatRequest, LLMProvider } from '../src/llm/provider';

/** A provider that streams one canned reply in small chunks and records the request. */
function scripted(reply: string): LLMProvider & { last?: ChatRequest } {
  const provider: LLMProvider & { last?: ChatRequest } = {
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      provider.last = req;
      for (const token of reply.match(/[\s\S]{1,3}/g) ?? []) yield { token, done: false };
      yield { token: '', done: true };
    },
    async generate() {
      return '';
    },
  };
  return provider;
}

/** Streams the first few characters, then waits for `release()` to finish. */
function gated(reply: string): { provider: LLMProvider; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const provider: LLMProvider = {
    async *chat(): AsyncIterable<ChatChunk> {
      yield { token: reply.slice(0, 3), done: false };
      await gate;
      yield { token: reply.slice(3), done: false };
      yield { token: '', done: true };
    },
    async generate() {
      return '';
    },
  };
  return { provider, release };
}

const juno = () => useRoom.getState().personas.find((p) => p.id === 'juno')!;

beforeEach(() => {
  // Only Juno may speak, so the follow-up tick after her turn can't start others.
  useRoom.setState({
    messages: [],
    channel: 'cafe',
    logs: {},
    joined: ['cafe'],
    dms: [],
    unread: {},
    topics: {},
    generating: [],
    muted: ['caius', 'mira', 'dex'],
    networked: false,
  });
});

/** Let fire-and-forget generations finish (the scripted stream is synchronous-ish). */
const settle = () => new Promise((r) => setTimeout(r, 20));
const texts = (author: string, log = useRoom.getState().messages) =>
  log.filter((m) => m.author === author && !m.pending).map((m) => m.text);

describe('startGeneration turn guards (store wiring)', () => {
  it('cuts a reply that runs on into a fake "(system)" line and someone else’s turn', async () => {
    useRoom.setState({
      provider: scripted('omg the jukebox is BACK\n(system)\nCaius: *back again* hello all'),
    });
    await useRoom.getState().startGeneration(juno());
    const lines = useRoom.getState().messages.filter((m) => m.author === 'juno');
    expect(lines.map((m) => m.text)).toEqual(['omg the jukebox is BACK']);
  });

  it('drops a reply that is nothing but a fake room event', async () => {
    useRoom.setState({ provider: scripted('* Dex has quit (bye) *') });
    await useRoom.getState().startGeneration(juno());
    expect(useRoom.getState().messages.filter((m) => m.author === 'juno')).toEqual([]);
  });

  it('keeps UI notices out of the prompt but lets room events in', async () => {
    const provider = scripted('ha, hi!');
    useRoom.setState({ provider });
    useRoom.getState().postSystem('* unknown command: /frobnicate (try /help) *');
    useRoom.getState().postSystem('* Satchel waves at everyone *', 'event');
    await useRoom.getState().startGeneration(juno());
    const user = provider.last?.messages.find((t) => t.role === 'user')?.content ?? '';
    expect(user).not.toContain('frobnicate');
    expect(user).toContain('[Satchel waves at everyone]');
    expect(user).not.toMatch(/^system:/m);
  });
});

describe('channels & DMs (DESIGN §12.4)', () => {
  it('/join switches rooms with separate logs, and switching back restores #cafe', () => {
    useRoom.getState().sendUserMessage('anyone around?');
    useRoom.getState().runCommand('/join #arcade');
    const s = useRoom.getState();
    expect(s.channel).toBe('arcade');
    expect(s.joined).toEqual(['cafe', 'arcade']);
    expect(s.messages.map((m) => m.text)).toEqual(['* now talking in #arcade — insert coin *', '* you joined #arcade *']);
    expect(s.messages[1].notice).toBeUndefined(); // the crowd sees you walk in
    expect(texts('user', s.logs.cafe)).toEqual(['anyone around?']);

    useRoom.getState().switchChannel('cafe');
    expect(texts('user')).toEqual(['anyone around?']);
    expect(useRoom.getState().logs.arcade).toHaveLength(2);
  });

  it('a reply that finishes after you switch away lands in its own channel, unread', async () => {
    const { provider, release } = gated('ok so the jukebox is back');
    useRoom.setState({ provider });
    const turn = useRoom.getState().startGeneration(juno()); // starts in #cafe
    useRoom.getState().runCommand('/join #arcade');
    release();
    await turn;
    const s = useRoom.getState();
    expect(texts('juno', s.logs.cafe)).toEqual(['ok so the jukebox is back']);
    expect(texts('juno')).toEqual([]); // not in #arcade
    expect(s.unread.cafe).toBe(1);
    useRoom.getState().switchChannel('cafe');
    expect(useRoom.getState().unread.cafe).toBeUndefined();
  });

  it('/msg is private: a DM window opens and only that persona answers there', async () => {
    const provider = scripted('hi you! how was the trip?');
    useRoom.setState({ provider, muted: ['caius', 'dex', 'juno'] });
    useRoom.getState().runCommand('/msg Mira hi there');
    await settle();
    const s = useRoom.getState();
    expect(s.channel).toBe('dm:mira');
    expect(s.dms).toEqual(['mira']);
    expect(texts('user')).toEqual(['hi there']);
    expect(texts('mira')).toEqual(['hi you! how was the trip?']);
    expect(texts('user', s.logs.cafe)).toEqual([]); // nothing said in public
    const system = provider.last?.messages.find((t) => t.role === 'system')?.content ?? '';
    expect(system).toMatch(/^You are Mira, chatting in a private one-on-one chat with the user\./);
  });

  it('a persona who likes you DMs you first — rarely, and into an unread window', async () => {
    const provider = scripted('hey, you went quiet — all good?');
    useRoom.setState({
      provider,
      muted: ['caius', 'dex', 'juno'],
      relationships: { 'mira:user': { from: 'mira', to: 'user', affinity: 0.8, notes: [] } },
      config: { ...useRoom.getState().config, dmGapMs: 1 },
    });
    await settle(); // let the 1 ms gap pass
    expect(useRoom.getState().maybePersonaDm(() => 0)).toBe('mira');
    await settle();
    const s = useRoom.getState();
    expect(s.channel).toBe('cafe'); // you stay where you were
    expect(s.dms).toEqual(['mira']);
    expect(texts('mira', s.logs['dm:mira'])).toEqual(['hey, you went quiet — all good?']);
    expect(s.unread['dm:mira']).toBe(1);
    expect(provider.last?.messages.find((t) => t.role === 'user')?.content).toContain('private message');

    useRoom.setState({ config: { ...s.config, dmGapMs: 600_000 } });
    expect(useRoom.getState().maybePersonaDm(() => 0)).toBeNull(); // ≥ 10 min apart
  });

  it("the prompt header names the channel, what it's for, and a topic you set", async () => {
    const provider = scripted('any% or 100%?');
    useRoom.setState({ provider });
    useRoom.getState().runCommand('/join #arcade');
    useRoom.getState().runCommand('/topic speedrun night');
    await useRoom.getState().startGeneration(juno());
    const system = provider.last?.messages.find((t) => t.role === 'system')?.content ?? '';
    expect(system).toMatch(/^You are Juno, chatting in #arcade \(the games corner: .*; the topic right now: speedrun night\) with/);
  });

  it('/part leaves a channel for home; home itself cannot be parted', () => {
    useRoom.getState().runCommand('/join #library');
    useRoom.getState().runCommand('/part');
    expect(useRoom.getState().channel).toBe('cafe');
    expect(useRoom.getState().joined).toEqual(['cafe']);
    useRoom.getState().runCommand('/part');
    expect(useRoom.getState().messages.at(-1)?.text).toBe("* #cafe is home — it can't be parted *");
  });
});
