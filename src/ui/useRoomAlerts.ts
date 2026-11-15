import { useEffect, useRef } from 'react';
import { selfName, useRoom } from '../state/store';
import { LIVE_BATCH, countsAsUnread, cueFor, newlyFinal, pickCue, titleFor } from '../util/cues';
import { playCue } from './sounds';

/**
 * Room alerts (DESIGN §12.5): a sound for arrivals, departures, mentions, and DMs, and
 * unread counts in the tab title while it's hidden. Watches the store from outside —
 * the store stays free of audio and DOM — and acts only on *live* lines: a channel
 * switch, a hydrate, or a relay snapshot swaps in history, which is never news.
 */
export function useRoomAlerts(soundOn: boolean): void {
  // Read through a ref so toggling sound doesn't resubscribe (and reset the counts).
  const soundRef = useRef(soundOn);
  useEffect(() => {
    soundRef.current = soundOn;
  }, [soundOn]);

  useEffect(() => {
    const since = Date.now(); // anything older was loaded, not lived
    let hiddenUnread = 0;
    const showTitle = () => {
      document.title = titleFor(hiddenUnread);
    };
    const onVisibility = () => {
      if (document.hidden) return;
      hiddenUnread = 0;
      showTitle();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const unsubscribe = useRoom.subscribe((s, prev) => {
      // A different window or a (dis)connect replaces what's on screen wholesale.
      if (s.channel !== prev.channel || s.networked !== prev.networked) return;
      const fresh = [
        ...newlyFinal(prev.messages, s.messages),
        ...Object.keys(s.logs).flatMap((id) => newlyFinal(prev.logs[id] ?? [], s.logs[id])),
      ].filter((m) => m.ts >= since);
      if (fresh.length === 0 || fresh.length > LIVE_BATCH) return;

      const mine = (author: string) => author === 'user' || s.myIds.includes(author);
      if (document.hidden) {
        const n = fresh.filter((m) => countsAsUnread(m, mine)).length;
        if (n > 0) {
          hiddenUnread += n;
          showTitle();
        }
      }
      if (soundRef.current) {
        const cue = pickCue(fresh.map((m) => cueFor(m, { me: selfName(s), mine })));
        if (cue) playCue(cue);
      }
    });

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
