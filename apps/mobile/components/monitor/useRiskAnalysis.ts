// Drives the AI read on the monitor. Free OpenRouter models allow few requests a day (and Claude costs per call), so the model is only asked
// when the incident picture changes (new / cleared / answered record, escalation step, check-in, friend action),
// debounced, at most once per MIN_GAP_MS unless the escalation went up, and never while the log is empty.
// The last answer is cached per subject so a page refresh does not spend a request.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isCheckPending, type EscalationLevel } from '@/modules/safety-native';
import { chat, llmConfigured, LlmError } from '@/lib/llm';
import { ANALYSIS_SCHEMA, buildMessages, parseAnalysis, riskFloor, type Analysis, type AnalysisInput, type Urgency } from './riskAnalysis';

const DEBOUNCE_MS = 4_000;
const URGENT_DEBOUNCE_MS = 1_500;
const MIN_GAP_MS = 45_000;
const ERROR_RETRY_MS = 30_000;
const RATE_LIMIT_RETRY_MS = 90_000;
const CACHE_PREFIX = 'safe.monitor.ai.v3.'; // v3: structured timeline, score / drivers

export type Reminder = { id: string; text: string; urgency: Urgency; atMs: number };
export type AnalysisStatus = 'off' | 'quiet' | 'cleared' | 'waiting' | 'running' | 'ready' | 'error';
export type AnalysisState = {
  status: AnalysisStatus;
  analysis: Analysis | null;
  atMs: number;
  model: string | null;
  error: string | null;
  retryAt: number | null;
  reminders: Reminder[];
};
type Inner = Omit<AnalysisState, 'status'> & {
  subject: string | null;
  phase: 'idle' | 'running' | 'error';
  /** the digest the shown analysis was made from */
  doneDigest: string | null;
  /** the friend cleared the messages; stays empty until the incidents change */
  cleared: boolean;
};
/** analysis null = cleared at `digest` */
type Cached = { digest: string; analysis: Analysis | null; atMs: number; model: string | null; reminders: Reminder[] };

const RANK: Record<EscalationLevel, number> = { idle: 0, resolved: 0, check: 1, heads_up: 2, unlocked: 3, snatch: 3 };
export const escalationRank = (l: EscalationLevel | null | undefined) => (l ? RANK[l] ?? 0 : 0);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const empty = (subject: string | null): Inner => ({ subject, phase: 'idle', analysis: null, atMs: 0, model: null, error: null, retryAt: null, reminders: [], doneDigest: null, cleared: false });

function readCache(subject: string): Cached | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_PREFIX + subject);
    return raw ? (JSON.parse(raw) as Cached) : null;
  } catch {
    return null;
  }
}
function writeCache(subject: string, c: Cached | null) {
  try {
    if (c) globalThis.localStorage?.setItem(CACHE_PREFIX + subject, JSON.stringify(c));
    else globalThis.localStorage?.removeItem(CACHE_PREFIX + subject);
  } catch {}
}
/** A subject's starting point: its cached read, if any (no request while nothing changed since). */
function initial(subject: string | null): Inner {
  const c = subject ? readCache(subject) : null;
  return c ? { ...empty(subject), analysis: c.analysis, atMs: c.atMs, model: c.model, reminders: c.reminders, doneDigest: c.digest, cleared: !c.analysis } : empty(subject);
}

export function useRiskAnalysis(opts: {
  subjectId: string | null;
  /** fingerprint of everything the read depends on; a new value schedules a new read */
  digest: string;
  /** nothing to analyze (empty log, engine idle) */
  quiet: boolean;
  /** quiet is confirmed by the phone itself (live tick says its log is empty): drop the old read */
  quietConfirmed: boolean;
  escalation: EscalationLevel | null;
  buildInput: () => Omit<AnalysisInput, 'previous' | 'shownReminders'>;
  onNewReminders?: (r: Reminder[]) => void;
}) {
  const { subjectId, digest, quiet, quietConfirmed, escalation } = opts;
  const configured = llmConfigured();
  const [inner, setInner] = useState<Inner>(() => initial(subjectId));
  const [kick, setKick] = useState(0);

  // Adjust state while rendering (React's pattern for "reset when a prop changes"): new subject → its cached read;
  // the phone confirms an empty log → drop the stale read.
  if (inner.subject !== subjectId) setInner(initial(subjectId));
  else if (quietConfirmed && inner.analysis && inner.phase !== 'running') setInner(empty(subjectId));

  const innerRef = useRef(inner);
  const buildRef = useRef(opts.buildInput);
  const onNewRef = useRef(opts.onNewReminders);
  const digestRef = useRef(digest);
  const subjectRef = useRef(subjectId);
  const lastCallAt = useRef(0);
  const lastRank = useRef(0);
  const inFlight = useRef(false);
  const blocked = useRef(false); // bad key / no credit: wait for a manual retry
  const gen = useRef(0); // bumped by clear(): an answer to a request sent before it is dropped
  useEffect(() => { innerRef.current = inner; buildRef.current = opts.buildInput; onNewRef.current = opts.onNewReminders; digestRef.current = digest; });
  useEffect(() => {
    subjectRef.current = subjectId;
    lastCallAt.current = 0;
    lastRank.current = 0;
    blocked.current = false;
  }, [subjectId]);
  useEffect(() => { if (quietConfirmed && subjectId) writeCache(subjectId, null); }, [quietConfirmed, subjectId]);

  const run = useCallback(async (force = false) => {
    const subject = subjectRef.current;
    if (!subject || inFlight.current || !llmConfigured()) return;
    if (force) blocked.current = false;
    inFlight.current = true;
    const g = gen.current;
    const startDigest = digestRef.current;
    const prev = innerRef.current.subject === subject ? innerRef.current : empty(subject);
    const input: AnalysisInput = {
      ...buildRef.current(),
      previous: prev.analysis ? { risk: prev.analysis.risk, score: prev.analysis.score, headline: prev.analysis.headline, atMs: prev.atMs } : null,
      shownReminders: prev.reminders.slice(0, 6).map((r) => r.text),
    };
    const rankAtStart = escalationRank(input.tick?.escalation);
    lastCallAt.current = Date.now();
    setInner((s) => ({ ...s, phase: 'running', error: null, retryAt: null }));
    try {
      const { text, model } = await chat(buildMessages(input), { json: true, schema: ANALYSIS_SCHEMA });
      if (subjectRef.current !== subject || gen.current !== g) return;
      const analysis = parseAnalysis(text, riskFloor(input.tick?.escalation, isCheckPending(input.tick)));
      const atMs = Date.now();
      const seen = new Set(prev.reminders.map((r) => norm(r.text)));
      const fresh: Reminder[] = analysis.reminders
        .filter((r) => !seen.has(norm(r.text)))
        .map((r, i) => ({ ...r, id: `${atMs}-${i}`, atMs }));
      const reminders = [...fresh, ...prev.reminders].slice(0, 20);
      lastRank.current = rankAtStart;
      setInner({ subject, phase: 'idle', analysis, atMs, model, error: null, retryAt: null, reminders, doneDigest: startDigest, cleared: false });
      writeCache(subject, { digest: startDigest, analysis, atMs, model, reminders });
      if (fresh.length) onNewRef.current?.(fresh);
    } catch (e) {
      if (subjectRef.current !== subject || gen.current !== g) return;
      const err = e instanceof LlmError ? e : new LlmError(String(e), 0);
      const fatal = err.status === 401 || err.status === 402 || err.status === 403;
      blocked.current = fatal;
      const retryAt = fatal ? null : Date.now() + (err.status === 429 ? err.retryAfterMs ?? RATE_LIMIT_RETRY_MS : ERROR_RETRY_MS);
      const msg = err.status === 429 ? `Rate-limited (${err.message}).` : fatal ? `${err.message} (check the API key / credits)` : err.message;
      setInner((s) => ({ ...s, phase: 'error', error: msg, retryAt }));
    } finally {
      inFlight.current = false;
      setKick((k) => k + 1); // re-check: the picture may have changed while the request ran
    }
  }, []);

  // Schedule a read when the picture changes.
  useEffect(() => {
    if (!configured || !subjectId || quiet) return;
    if (inFlight.current || blocked.current || digest === innerRef.current.doneDigest) return;
    const now = Date.now();
    const escalated = escalationRank(escalation) > lastRank.current;
    const retryAt = innerRef.current.retryAt ?? 0;
    const wait = Math.max(
      escalated ? URGENT_DEBOUNCE_MS : DEBOUNCE_MS,
      escalated ? 0 : lastCallAt.current + MIN_GAP_MS - now,
      retryAt - now,
    );
    const t = setTimeout(() => void run(), wait);
    return () => clearTimeout(t);
  }, [configured, subjectId, digest, quiet, escalation, kick, run]);

  const refresh = useCallback(() => void run(true), [run]);
  /** Drops the analysis and reminder history (and any answer still on its way). The next read comes when the
   * incidents change, or on Re-analyze, and starts fresh: no previous read or shown reminders in the prompt. */
  const clear = useCallback(() => {
    const subject = subjectRef.current;
    if (!subject) return;
    gen.current += 1;
    const d = digestRef.current;
    setInner({ ...empty(subject), doneDigest: d, cleared: true });
    writeCache(subject, { digest: d, analysis: null, atMs: Date.now(), model: null, reminders: [] });
  }, []);
  const status: AnalysisStatus =
    !configured ? 'off'
    : inner.phase === 'running' ? 'running'
    : inner.phase === 'error' ? 'error'
    : !quiet && digest !== inner.doneDigest ? 'waiting'
    : inner.analysis ? 'ready'
    : inner.cleared && !quiet ? 'cleared' : 'quiet';
  const { subject: _s, phase: _p, doneDigest: _d, cleared: _c, ...view } = inner;
  return { ...view, status, configured, refresh, clear };
}
