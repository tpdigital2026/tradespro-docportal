'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { joinSpoken } from '../../lib/scope/items';

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
type Ctor = new () => Recognition;

function ctor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MESSAGES: Record<string, string> = {
  'not-allowed': 'The microphone is blocked. Allow it in your browser settings, or use the microphone on your keyboard.',
  'service-not-allowed': 'The microphone is blocked. Allow it in your browser settings, or use the microphone on your keyboard.',
  'no-speech': 'We did not hear anything. Try again, or use the microphone on your keyboard.',
  'audio-capture': 'No microphone was found. You can type, or use the microphone on your keyboard.',
  network: 'Dictation needs a connection. You can type, or use the microphone on your keyboard.',
};

/**
 * Dictation into one box at a time, in the browser's own speech recognition (English, UK). Where the browser has
 * none, `supported` stays false and the keyboard's microphone does the same job. Only text ever leaves this hook.
 */
export function useDictation() {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => {
    setSupported(ctor() !== null);
    return () => rec.current?.abort();
  }, []);

  const stop = useCallback(() => {
    rec.current?.stop();
  }, []);

  /** Start listening for box `id`. `base` is what is in the box now; `apply` receives the whole new text as it is spoken. */
  const start = useCallback((id: string, base: string, apply: (text: string) => void, max: number) => {
    const C = ctor();
    if (!C) return;
    rec.current?.abort();
    setProblem(null);
    const r = new C();
    r.lang = 'en-GB';
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      let said = '';
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0]?.transcript ?? '';
      apply(joinSpoken(base, said, max));
    };
    r.onerror = (e) => setProblem(MESSAGES[e.error ?? ''] ?? 'Dictation stopped. You can type, or use the microphone on your keyboard.');
    r.onend = () => {
      setActive((a) => (a === id ? null : a));
      if (rec.current === r) rec.current = null;
    };
    rec.current = r;
    setActive(id);
    try {
      r.start();
    } catch {
      setActive(null);
      rec.current = null;
    }
  }, []);

  return { supported, active, problem, start, stop };
}
