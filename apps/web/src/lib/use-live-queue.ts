'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { POLL_MS, SAFETY_POLL_MS, startLiveEvents } from './live-events';

/**
 * Live updates for the queue screens: opens `/api/events` and refreshes every `queue.*` query on
 * each server event. Returns `live` and the `refetchInterval` to give the board query: 5 s while
 * there is no stream (the polling fallback), a slow safety poll while there is one.
 */
export function useLiveQueue(): { live: boolean; refetchInterval: number } {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    const stop = startLiveEvents({
      open: () =>
        new EventSource('/api/events') as unknown as ReturnType<
          Parameters<typeof startLiveEvents>[0]['open']
        >,
      onChange: () => void queryClient.invalidateQueries({ queryKey: [['queue']] }),
      onStatus: setLive,
    });
    return stop;
  }, [queryClient]);
  return { live, refetchInterval: live ? SAFETY_POLL_MS : POLL_MS };
}
