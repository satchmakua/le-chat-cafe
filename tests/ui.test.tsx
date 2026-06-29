// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageList } from '../src/ui/MessageList';
import { NickList } from '../src/ui/NickList';

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
});
