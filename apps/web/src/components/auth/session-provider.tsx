'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MeView } from '@/server/trpc/routers/auth';
import { AUTH_EVENT, useTRPC, type AuthEventDetail } from '@/trpc/client';
import { LockScreen } from './lock-screen';

/** Activity pings to the server at most this often (the server decides idle from them). */
const HEARTBEAT_EVERY_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'] as const;

interface SessionContextValue {
  me: MeView;
  locked: boolean;
  lock: () => void;
  switchUser: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/**
 * Client half of the idle lock (docs/01 §5, docs/03 §6). Tracks keyboard/pointer/touch
 * activity; after `idleLockMinutes` without any it locks (server too), and covers the screen
 * with the PIN keypad. Activity is reported with a throttled `auth.heartbeat`; background
 * polling does not count. Any "locked" error from the server also shows the lock screen,
 * "signed out" goes to the login page.
 */
export function SessionProvider({ initial, children }: { initial: MeView; children: ReactNode }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [locked, setLocked] = useState(initial.state === 'locked');
  // Timestamps start at mount (set in the effect below), refs mirror state for listeners.
  const lastActivity = useRef(0);
  const lastBeat = useRef(0);
  const lockedRef = useRef(locked);
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);
  useEffect(() => {
    lastActivity.current = Date.now();
    lastBeat.current = Date.now();
  }, []);

  const heartbeat = useMutation(trpc.auth.heartbeat.mutationOptions());
  const lockMutation = useMutation(trpc.auth.lock.mutationOptions());
  const logout = useMutation(trpc.auth.logout.mutationOptions());

  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setLocked(true);
    lockMutation.mutate();
  }, [lockMutation]);

  const switchUser = useCallback(() => {
    logout.mutate(undefined, {
      onSettled: () => {
        queryClient.clear();
        router.replace('/login');
        router.refresh();
      },
    });
  }, [logout, queryClient, router]);

  const unlocked = useCallback(() => {
    lastActivity.current = Date.now();
    lastBeat.current = Date.now();
    lockedRef.current = false;
    setLocked(false);
    void queryClient.invalidateQueries();
  }, [queryClient]);

  // Activity tracking + heartbeat.
  useEffect(() => {
    const onActivity = () => {
      if (lockedRef.current) return;
      const now = Date.now();
      lastActivity.current = now;
      if (now - lastBeat.current >= HEARTBEAT_EVERY_MS) {
        lastBeat.current = now;
        heartbeat.mutate();
      }
    };
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, onActivity, { passive: true });
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, onActivity);
    };
  }, [heartbeat]);

  // Idle timer.
  useEffect(() => {
    const idleMs = initial.idleLockMinutes * 60_000;
    const timer = window.setInterval(() => {
      if (!lockedRef.current && Date.now() - lastActivity.current >= idleMs) lock();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [initial.idleLockMinutes, lock]);

  // Server says locked / signed out.
  useEffect(() => {
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent<AuthEventDetail>).detail;
      if (detail === 'locked') {
        lockedRef.current = true;
        setLocked(true);
      }
      if (detail === 'signed-out') {
        queryClient.clear();
        router.replace('/login?notice=signedOut');
      }
    };
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, [queryClient, router]);

  return (
    <SessionContext value={{ me: initial, locked, lock, switchUser }}>
      {/* `inert` keeps keyboard focus and screen readers out of the page while locked. */}
      <div
        inert={locked}
        aria-hidden={locked || undefined}
        className={locked ? 'invisible' : undefined}
      >
        {children}
      </div>
      {locked && <LockScreen me={initial} onUnlocked={unlocked} onSwitchUser={switchUser} />}
    </SessionContext>
  );
}
