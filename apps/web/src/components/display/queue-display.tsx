'use client';

import {
  DISPLAY_KEY_HEADER,
  newAnnouncements,
  type DisplayDoctor,
  type DisplayFeed,
  type DisplayToken,
} from '@hmis/shared';
import { Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Bi = { en: string; hi: string };
export interface DisplayLabels {
  title: Bi;
  now: Bi;
  next: Bi;
  waiting: Bi;
  nobody: Bi;
  idle: Bi;
  reconnecting: Bi;
  enableSound: Bi;
  invalid: Bi;
  /** ICU-free template with `{no}` and `{doctor}` placeholders. */
  announceHi: string;
}

const POLL_MS = 2_000;
const FETCH_TIMEOUT_MS = 4_000;
/** Failed polls in a row before "Reconnecting…" shows (one blip is invisible). */
const FAILS_BEFORE_NOTICE = 2;

type Status = 'loading' | 'ok' | 'reconnecting' | 'invalid';

/** Two-tone chime from the Web Audio API (no audio file to ship). */
function chime(ctx: AudioContext) {
  const t0 = ctx.currentTime;
  [880, 660].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + i * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + i * 0.35 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.35 + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + i * 0.35);
    osc.stop(t0 + i * 0.35 + 0.65);
  });
}

function speakHindi(text: string) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  const voice = synth?.getVoices().find((v) => v.lang.toLowerCase().startsWith('hi'));
  if (!synth || !voice) return; // no Hindi voice installed: the chime alone announces
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = 'hi-IN';
  synth.speak(u);
}

/**
 * Waiting-hall TV (REG-05, docs/10 §6): per doctor "Now: 23" and "Next: 24, 25, …", polled every
 * 2 s with the key in a header. A chime (and, if switched on, a Hindi voice line) plays when a
 * token is called or recalled. Network blips keep the last board and show "Reconnecting…" in a
 * corner; polling carries on and recovers by itself.
 */
export function QueueDisplay({
  displayKey,
  labels,
}: {
  displayKey: string;
  labels: DisplayLabels;
}) {
  const [feed, setFeed] = useState<DisplayFeed | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [needsSound, setNeedsSound] = useState(false);
  const prev = useRef<DisplayFeed | null>(null);
  const fails = useRef(0);
  const audio = useRef<AudioContext | null>(null);

  const ensureAudio = useCallback((): AudioContext | null => {
    if (typeof AudioContext === 'undefined') return null;
    audio.current ??= new AudioContext();
    return audio.current;
  }, []);

  const announce = useCallback(
    (next: DisplayFeed) => {
      const calls = newAnnouncements(prev.current, next);
      if (calls.length === 0) return;
      const ctx = ensureAudio();
      if (ctx && ctx.state === 'running') chime(ctx);
      else setNeedsSound(true);
      if (next.voice) {
        for (const c of calls) {
          const d = next.doctors.find((x) => x.id === c.doctorId);
          speakHindi(
            labels.announceHi
              .replace('{no}', String(c.tokenNo))
              .replace('{doctor}', d?.nameHi ?? d?.name ?? ''),
          );
        }
      }
    },
    [ensureAudio, labels.announceHi],
  );

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const ctl = new AbortController();
      const abort = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch('/api/display/queue', {
          headers: { [DISPLAY_KEY_HEADER]: displayKey },
          cache: 'no-store',
          signal: ctl.signal,
        });
        if (res.status === 404) {
          if (!stopped) {
            setFeed(null); // rotated away: show nothing old, keep checking
            prev.current = null;
            setStatus('invalid');
          }
        } else if (!res.ok) {
          throw new Error(String(res.status));
        } else {
          const next = (await res.json()) as DisplayFeed;
          if (stopped) return;
          fails.current = 0;
          announce(next);
          prev.current = next;
          setFeed(next);
          setStatus('ok');
        }
      } catch {
        fails.current++;
        if (!stopped && fails.current >= FAILS_BEFORE_NOTICE) setStatus('reconnecting');
      } finally {
        clearTimeout(abort);
        if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [displayKey, announce]);

  const enableSound = () => {
    const ctx = ensureAudio();
    void ctx?.resume().then(() => {
      setNeedsSound(false);
      if (ctx) chime(ctx);
    });
  };

  return (
    <main
      className="flex min-h-dvh flex-col bg-slate-950 p-6 text-white"
      data-testid="queue-display"
      data-status={status}
    >
      <header className="mb-6 flex items-baseline justify-between border-b border-slate-700 pb-3">
        <h1 className="text-3xl font-semibold">
          {labels.title.hi} · {labels.title.en}
        </h1>
        <p
          className="text-lg text-slate-300"
          role="status"
          data-testid="display-status"
          hidden={status === 'ok' || status === 'loading'}
        >
          {status === 'invalid' ? labels.invalid.en : labels.reconnecting.en}
        </p>
      </header>

      {feed && feed.doctors.length === 0 && status !== 'invalid' && (
        <p className="m-auto text-center text-4xl text-slate-300">
          {labels.idle.hi}
          <br />
          {labels.idle.en}
        </p>
      )}

      <div className="grid flex-1 [grid-template-columns:repeat(auto-fit,minmax(24rem,1fr))] content-start gap-6">
        {feed?.doctors.map((d) => (
          <DoctorPanel key={d.id} doctor={d} labels={labels} />
        ))}
      </div>

      {needsSound && (
        <button
          type="button"
          onClick={enableSound}
          className="fixed bottom-4 left-4 flex min-h-11 items-center gap-2 rounded-full border-2 border-slate-400 bg-slate-800 px-4 py-2 text-lg text-white"
        >
          <Volume2 aria-hidden className="size-5" />
          {labels.enableSound.hi} · {labels.enableSound.en}
        </button>
      )}
    </main>
  );
}

function DoctorPanel({ doctor, labels }: { doctor: DisplayDoctor; labels: DisplayLabels }) {
  return (
    <section
      className="rounded-2xl border-2 border-slate-600 bg-slate-900 p-6"
      aria-label={doctor.name}
      data-testid={`display-doctor-${doctor.id}`}
    >
      <h2 className="mb-4 text-3xl font-semibold">
        {doctor.nameHi ? `${doctor.nameHi} / ` : ''}
        {doctor.name}
      </h2>
      <div className="mb-5">
        <p className="text-xl text-emerald-300">
          {labels.now.hi} · {labels.now.en}
        </p>
        {doctor.now.length > 0 ? (
          <ul className="flex flex-wrap items-baseline gap-x-8">
            {doctor.now.map((t) => (
              <li key={t.no} data-testid="display-now">
                <span className="text-9xl font-bold tabular-nums">{t.no}</span>
                <TokenName token={t} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-6xl text-slate-500">—</p>
        )}
      </div>
      <div>
        <p className="text-xl text-sky-300">
          {labels.next.hi} · {labels.next.en}
        </p>
        {doctor.next.length > 0 ? (
          <ul className="flex flex-wrap gap-x-6 gap-y-1">
            {doctor.next.map((t) => (
              <li
                key={t.no}
                className="text-5xl font-semibold tabular-nums"
                data-testid="display-next"
              >
                {t.no}
                <TokenName token={t} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-3xl text-slate-400">{labels.nobody.en}</p>
        )}
        {doctor.waiting > doctor.next.length && (
          <p className="mt-2 text-xl text-slate-300">
            +{doctor.waiting - doctor.next.length} {labels.waiting.en}
          </p>
        )}
      </div>
    </section>
  );
}

function TokenName({ token }: { token: DisplayToken }) {
  if (!token.name) return null;
  return <span className="ml-3 text-2xl font-normal text-slate-300">{token.name}</span>;
}
