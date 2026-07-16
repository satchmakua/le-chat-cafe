import { describe, it, expect } from 'vitest';
import { modelFamily, resolveModel } from '../src/llm/models';

describe('modelFamily', () => {
  it('extracts the leading letters of a tag', () => {
    expect(modelFamily('llama3.2:3b')).toBe('llama');
    expect(modelFamily('qwen2.5:7b-instruct')).toBe('qwen');
    expect(modelFamily('Gemma3:4b')).toBe('gemma');
  });
});

describe('resolveModel', () => {
  const installed = ['qwen2.5:1.5b-instruct', 'qwen2.5:7b-instruct', 'llama3.1:8b'];

  it('keeps an exactly-installed tag', () => {
    expect(resolveModel('llama3.1:8b', installed)).toBe('llama3.1:8b');
  });

  it('falls back to the same family when the exact tag is missing', () => {
    expect(resolveModel('llama3.2:3b', installed)).toBe('llama3.1:8b');
    expect(resolveModel('qwen3:8b', installed)).toBe('qwen2.5:1.5b-instruct');
  });

  it('falls back to any installed model when the family is missing', () => {
    expect(resolveModel('gemma3:4b', installed)).toBe('qwen2.5:1.5b-instruct');
  });

  it('trusts the requested tag when the installed list is unknown', () => {
    expect(resolveModel('llama3.2:3b', [])).toBe('llama3.2:3b'); // mock / probe failed
  });
});
