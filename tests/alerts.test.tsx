// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useRoom } from '../src/state/store';
import { useRoomAlerts } from '../src/ui/useRoomAlerts';
import { playCue } from '../src/ui/sounds';
import type { Message } from '../src/core/types';

vi.mock('../src/ui/sounds', () => ({ playCue: vi.fn() }));
const played = vi.mocked(playCue);

function Alerts({ sound }: { sound: boolean }) {
  useRoomAlerts(sound);
  return null;
}

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};
const line = (id: string, author: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: 'cafe',
  author,
  text,
  ts: Date.now(),
  ...extra,
});
const append = (...ms: Message[]) => act(() => useRoom.setState((s) => ({ messages: [...s.messages, ...ms] })));

beforeEach(() => {
  played.mockClear();
  useRoom.setState({ messages: [], channel: 'cafe', logs: {}, networked: false, nick: 'Satchel' });
  document.title = 'le-chat-cafe';
});
afterEach(() => {
  cleanup();
  setHidden(false);
});

describe('room alerts (DESIGN §12.5)', () => {
  it('a persona arriving plays the door; with sound off, silence', () => {
    const { rerender } = render(<Alerts sound />);
    append(line('j', 'system', '* Mira has joined #cafe *', { presence: { who: 'mira', state: 'join' } }));
    expect(played).toHaveBeenLastCalledWith('door-open');

    rerender(<Alerts sound={false} />);
    append(line('l', 'system', '* Mira has quit *', { presence: { who: 'mira', state: 'leave' } }));
    expect(played).toHaveBeenCalledTimes(1);
  });

  it('a DM landing in a background window chimes', () => {
    render(<Alerts sound />);
    act(() => useRoom.setState({ logs: { 'dm:mira': [line('d', 'mira', 'psst', { channelId: 'dm:mira' })] } }));
    expect(played).toHaveBeenLastCalledWith('chime');
  });

  it('history is never news: a bulk load or a channel switch stays silent', () => {
    render(<Alerts sound />);
    append(
      line('1', 'mira', 'Satchel!'),
      line('2', 'dex', 'Satchel?'),
      line('3', 'juno', 'SATCHEL'),
    ); // three at once = a load
    act(() => useRoom.setState({ channel: 'arcade', messages: [line('4', 'juno', 'Satchel hi')] }));
    append(line('old', 'mira', 'Satchel, from last week', { ts: Date.now() - 86_400_000 }));
    expect(played).not.toHaveBeenCalled();
  });

  it('while the tab is hidden the title counts lines; coming back clears it', () => {
    render(<Alerts sound={false} />);
    setHidden(true);
    append(line('a', 'mira', 'you there?', { channelId: 'dm:mira' }));
    expect(document.title).toBe('(1) le-chat-cafe');
    append(line('b', 'user', 'my own line')); // yours don't count
    append(line('c', 'dex', 'hm'));
    expect(document.title).toBe('(2) le-chat-cafe');
    setHidden(false);
    expect(document.title).toBe('le-chat-cafe');
  });
});
