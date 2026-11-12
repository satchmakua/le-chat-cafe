// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MessageList } from '../src/ui/MessageList';
import { NickList } from '../src/ui/NickList';
import { ProfileCard } from '../src/ui/ProfileCard';
import { ChannelList } from '../src/ui/ChannelList';
import { useRoom } from '../src/state/store';

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView (MessageList calls it on mount).
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

describe('MessageList', () => {
  it('renders the seed welcome notice as a system line', () => {
    render(<MessageList />);
    expect(screen.getByText(/welcome to le-chat-cafe/i)).toBeTruthy();
  });

  it('never shows machine markup, even in a line stored before a strip rule caught it', () => {
    const before = useRoom.getState().messages;
    const leaked = (id: string, text: string) => ({ id, channelId: 'cafe', author: 'dex', text, ts: 1 });
    act(() =>
      useRoom.setState({
        messages: [
          leaked('a', '§{"user": 0.15}'),
          leaked('c', '[Dex] §{"user": -0.2}  '), // live: only a self-label left
          leaked('b', 'compiling. §{"user": -0.2}'),
        ],
      }),
    );
    const { container } = render(<MessageList />);
    expect(container.textContent).not.toContain('§');
    expect(container.textContent).toContain('compiling.');
    expect(container.querySelectorAll('[class*="line"]')).toHaveLength(1); // the bare one is gone
    act(() => useRoom.setState({ messages: before }));
  });
});

describe('NickList', () => {
  it('lists you plus the data-driven personas with affinity hearts', () => {
    render(<NickList />);
    expect(screen.getByText('you')).toBeTruthy();
    expect(screen.getByText('Caius')).toBeTruthy();
    expect(screen.getByText('Mira')).toBeTruthy();
    // one heart per persona
    expect(screen.getAllByText('♥').length).toBeGreaterThanOrEqual(4);
  });

  it('clicking a nick opens that persona’s profile card', () => {
    render(
      <>
        <NickList />
        <ProfileCard />
      </>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTitle("Mira's profile"));
    const card = screen.getByRole('dialog', { name: "Mira's profile" });
    expect(card.textContent).toContain('feels about you');
    expect(card.textContent).toContain('remembers');
    act(() => useRoom.getState().closeProfile());
  });
});

describe('ChannelList', () => {
  it('lists joined channels and DMs with unread badges; clicking switches the view', () => {
    act(() =>
      useRoom.setState({ joined: ['cafe', 'arcade'], dms: ['mira'], unread: { 'dm:mira': 2 } }),
    );
    render(<ChannelList />);
    expect(screen.getByText('# cafe')).toBeTruthy();
    expect(screen.getByText('# arcade')).toBeTruthy();
    expect(screen.getByLabelText('2 unread')).toBeTruthy();
    fireEvent.click(screen.getByText('@Mira'));
    expect(useRoom.getState().channel).toBe('dm:mira');
    expect(screen.queryByLabelText('2 unread')).toBeNull(); // reading it clears the badge
    act(() => useRoom.getState().switchChannel('cafe'));
  });
});

describe('ProfileCard', () => {
  it('shows bio and feelings, writes nothing to the log, and Esc closes it', () => {
    const before = useRoom.getState().messages.length;
    act(() => useRoom.getState().openProfile('dex'));
    render(<ProfileCard />);
    const card = screen.getByRole('dialog', { name: "Dex's profile" });
    expect(card.textContent).toContain('kernel drivers'); // his bio
    expect(card.textContent).toMatch(/fond|friendly|neutral|guarded|cold/);
    expect(useRoom.getState().messages.length).toBe(before); // UI-only (§12.3)
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a wrong memory can be forgotten from the card', () => {
    const wrong = "Satchel's hardware project makes AI landscapes";
    act(() =>
      useRoom.setState({
        memory: { dex: { personaId: 'dex', notes: [wrong, 'Satchel likes Zig'], lastSummarizedTs: 0 } },
      }),
    );
    act(() => useRoom.getState().openProfile('dex'));
    render(<ProfileCard />);
    fireEvent.click(screen.getByLabelText(`forget: ${wrong}`));
    expect(useRoom.getState().memory.dex.notes).toEqual(['Satchel likes Zig']);
    expect(screen.queryByText(wrong)).toBeNull();
    act(() => useRoom.getState().runCommand('/forget Dex'));
    expect(useRoom.getState().memory.dex.notes).toEqual([]);
    act(() => useRoom.getState().closeProfile());
  });
});
