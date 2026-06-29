import { describe, it, expect } from 'vitest';
import { parseFrame } from '../src/net/protocol';

describe('parseFrame', () => {
  it('parses valid JSON frames', () => {
    expect(parseFrame<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null on malformed input instead of throwing', () => {
    expect(parseFrame('not json')).toBeNull();
    expect(parseFrame('')).toBeNull();
  });
});
