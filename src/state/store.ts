import { create } from 'zustand';
import type { LLMProvider, ChatTurn } from '../llm/provider';
import { MockProvider } from '../llm/mock';
import type { Message, Persona } from '../core/types';

// M0 ships one hardcoded persona behind the LLMProvider port. M1 loads a roster
// from personas/*.json and introduces the Conductor to pick who speaks.
export const HOST_PERSONA: Persona = {
  id: 'caius',
  name: 'Caius',
  color: '#7cc4ff',
  systemPrompt:
    'You are Caius, a wry, warm regular at a late-night café chat room. ' +
    'Keep replies short and conversational.',
  model: 'mock',
  params: { temperature: 0.8, topP: 0.9 },
  temperament: { talkativeness: 0.6, warmth: 0.5, pettiness: 0.2 },
  interests: ['music', 'games', 'coffee'],
};

const CHANNEL_ID = 'cafe';

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

interface RoomState {
  personas: Persona[];
  messages: Message[];
  provider: LLMProvider;
  sending: boolean;
  sendUserMessage: (text: string) => Promise<void>;
}

export const useRoom = create<RoomState>((set, get) => ({
  personas: [HOST_PERSONA],
  messages: [
    {
      id: uid(),
      channelId: CHANNEL_ID,
      author: HOST_PERSONA.id,
      text: '* welcome to le-chat-cafe — say hi *',
      ts: Date.now(),
    },
  ],
  provider: new MockProvider(),
  sending: false,

  async sendUserMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || get().sending) return;

    const { provider, personas } = get();
    const persona = personas[0];

    const userMsg: Message = {
      id: uid(),
      channelId: CHANNEL_ID,
      author: 'user',
      text: trimmed,
      ts: Date.now(),
    };
    const replyId = uid();
    const replyMsg: Message = {
      id: replyId,
      channelId: CHANNEL_ID,
      author: persona.id,
      text: '',
      ts: Date.now(),
      pending: true,
    };

    set((s) => ({ messages: [...s.messages, userMsg, replyMsg], sending: true }));

    const turns: ChatTurn[] = [
      { role: 'system', content: persona.systemPrompt },
      { role: 'user', content: trimmed },
    ];

    try {
      for await (const chunk of provider.chat({
        model: persona.model,
        messages: turns,
        options: { temperature: persona.params.temperature, top_p: persona.params.topP },
      })) {
        if (!chunk.token) continue;
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === replyId ? { ...m, text: m.text + chunk.token } : m,
          ),
        }));
      }
    } finally {
      set((s) => ({
        messages: s.messages.map((m) => (m.id === replyId ? { ...m, pending: false } : m)),
        sending: false,
      }));
    }
  },
}));
