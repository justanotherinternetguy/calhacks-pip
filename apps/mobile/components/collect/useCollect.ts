// The recording side of /collect: one CollectRecorder fed straight from the subject's telemetry (the shared hub in
// lib/telemetry, so it sees every frame, not only the ones the console redraws), the phone commands, the 60 s
// keepalive and the 10 s autosave to IndexedDB.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { TelemetryTick } from '@/modules/safety-native';
import { sendTelemetryCommand, subscribeTelemetry, type TelemetryCommand } from '@/lib/telemetry';
import { uuidv4 } from '@/lib/uuid';
import { CollectRecorder, KEEPALIVE_MINUTES, KEEPALIVE_MS, newSession, type CollectSession } from './session';
import { deleteSession, listSessions, saveSession } from './storage';

const AUTOSAVE_MS = 10_000;

export type Note = { text: string; ok: boolean; at: number };
export type StartOptions = { subjectId: string; subjectName: string; participant: string; notes: string; placement: string; action: string | null };

export function useCollect(subjectId: string | null) {
  const recRef = useRef<CollectRecorder | null>(null);
  const [recorder, setRecorder] = useState<CollectRecorder | null>(null);
  /** bumped on every structural change (label, start, stop) so the page re-renders at once */
  const [, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => n + 1), []);
  const [cmdNote, setCmdNote] = useState<Note | null>(null);
  const [saveNote, setSaveNote] = useState<Note | null>(null);
  const [sessions, setSessions] = useState<CollectSession[]>([]);

  const refresh = useCallback(async () => {
    const all = await listSessions();
    const live = recRef.current?.session;
    setSessions(live ? [live, ...all.filter((s) => s.id !== live.id)].sort((a, b) => b.createdAt - a.createdAt) : all);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Every frame of the subject, into the recorder while it records that subject.
  useEffect(() => {
    if (!subjectId) return;
    return subscribeTelemetry(subjectId, (tick: TelemetryTick, at: number) => {
      const r = recRef.current;
      if (r && r.recording && r.session.subjectId === subjectId) r.push(tick, at);
    }, () => {});
  }, [subjectId]);

  const send = useCallback(async (to: string, command: TelemetryCommand, what: string) => {
    const res = await sendTelemetryCommand(to, command).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    setCmdNote({ text: res === 'ok' ? `${what}: sent` : `${what}: failed (${res})`, ok: res === 'ok', at: Date.now() });
    return res;
  }, []);

  const save = useCallback(async (s: CollectSession) => {
    const res = await saveSession(s);
    setSaveNote({ text: res === 'ok' ? 'Saved' : `Not saved (${res})`, ok: res === 'ok', at: Date.now() });
    return res;
  }, []);

  const recording = !!recorder?.recording;
  const recSubject = recorder?.session.subjectId ?? null;

  // Keepalive: the phone stops by itself a few minutes after the last collect_start (closed tab, lost laptop).
  useEffect(() => {
    if (!recording || !recSubject) return;
    const id = setInterval(() => {
      const r = recRef.current;
      if (!r?.recording) return;
      void send(recSubject, { cmd: 'collect_start', minutes: KEEPALIVE_MINUTES, label: r.currentAction() ?? undefined }, 'Keepalive');
    }, KEEPALIVE_MS);
    return () => clearInterval(id);
  }, [recording, recSubject, send]);

  // Autosave, and a last save when the tab closes or reloads.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => { const r = recRef.current; if (r) void save(r.session); }, AUTOSAVE_MS);
    const onUnload = () => { const r = recRef.current; if (r) void saveSession(r.session); };
    const w = Platform.OS === 'web' ? (globalThis as { addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] }) : null;
    w?.addEventListener?.('beforeunload', onUnload);
    return () => { clearInterval(id); w?.removeEventListener?.('beforeunload', onUnload); };
  }, [recording, save]);

  const begin = useCallback(async (r: CollectRecorder, what: string) => {
    recRef.current = r;
    setRecorder(r);
    bump();
    await save(r.session);
    void refresh();
    await send(r.session.subjectId, { cmd: 'collect_start', minutes: KEEPALIVE_MINUTES, label: r.currentAction() ?? undefined }, what);
  }, [bump, refresh, save, send]);

  const start = useCallback(async (o: StartOptions) => {
    if (recRef.current?.recording) return;
    const s = newSession({
      id: uuidv4(), subjectId: o.subjectId, subjectName: o.subjectName, participant: o.participant.trim() || 'anon',
      notes: o.notes, placement: o.placement, createdAt: Date.now(), action: o.action,
    });
    await begin(new CollectRecorder(s), 'Start');
  }, [begin]);

  /** Continue an interrupted session (the tab was closed or reloaded while it recorded). */
  const resume = useCallback(async (s: CollectSession) => {
    if (recRef.current?.recording) return;
    await begin(new CollectRecorder({ ...s, status: 'recording' }), 'Resume');
  }, [begin]);

  /** Re-send collect_start now (after a failed send). */
  const resend = useCallback(async () => {
    const r = recRef.current;
    if (!r?.recording) return;
    await send(r.session.subjectId, { cmd: 'collect_start', minutes: KEEPALIVE_MINUTES, label: r.currentAction() ?? undefined }, 'Start');
  }, [send]);

  const stop = useCallback(async () => {
    const r = recRef.current;
    if (!r?.recording) return;
    r.stop();
    bump();
    await Promise.all([save(r.session), send(r.session.subjectId, { cmd: 'collect_stop' }, 'Stop')]);
    void refresh();
  }, [bump, refresh, save, send]);

  /** Switch the action. Returns false when not recording (the page keeps it as the label to start with). */
  const setAction = useCallback((label: string) => {
    const r = recRef.current;
    if (!r?.recording) return false;
    if (r.setAction(label)) {
      bump();
      void send(r.session.subjectId, { cmd: 'collect_label', label }, 'Label');
    }
    return true;
  }, [bump, send]);

  const setPlacement = useCallback((label: string) => {
    const r = recRef.current;
    if (!r?.recording) return false;
    if (r.setPlacement(label)) bump();
    return true;
  }, [bump]);

  const remove = useCallback(async (id: string) => {
    if (recRef.current?.session.id === id) {
      if (recRef.current.recording) return 'Stop the session first.';
      recRef.current = null;
      setRecorder(null);
    }
    const res = await deleteSession(id);
    void refresh();
    return res;
  }, [refresh]);

  return { recorder, recording, start, resume, resend, stop, setAction, setPlacement, sessions, refresh, remove, cmdNote, saveNote };
}
