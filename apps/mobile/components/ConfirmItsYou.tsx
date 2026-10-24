import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { Card, P, Row } from '@/components/ui';
import { colors } from '@/lib/theme';

export type ConfirmState = 'idle' | 'pending' | 'ok' | 'failed';

/**
 * Wraps a biometric-gated native call (cancelSos / snatch dismiss). While the call runs the UI shows
 * "Confirm it's you"; the label stays up for at least `minMs` so the step is visible even when the
 * mock resolves instantly.
 */
export function useBiometricConfirm(action: () => Promise<boolean>, onDone?: (ok: boolean) => void, minMs = 4000) {
  const [state, setState] = useState<ConfirmState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const run = useCallback(async () => {
    if (state === 'pending') return;
    setState('pending');
    const started = Date.now();
    let ok = false;
    try { ok = await action(); } catch { ok = false; }
    const wait = Math.max(0, minMs - (Date.now() - started));
    timer.current = setTimeout(() => { setState(ok ? 'ok' : 'failed'); onDone?.(ok); }, wait);
  }, [action, minMs, onDone, state]);

  const reset = useCallback(() => setState('idle'), []);
  return { state, run, reset };
}

export function ConfirmItsYou({ state, what }: { state: ConfirmState; what: string }) {
  if (state === 'idle') return null;
  return (
    <Card tint={state === 'failed' ? colors.danger : colors.accent}>
      <Row style={{ justifyContent: 'space-between' }}>
        <P style={{ fontWeight: '700' }}>{state === 'pending' ? "Confirm it's you" : state === 'ok' ? 'Confirmed' : 'Could not confirm'}</P>
        {state === 'pending' && <ActivityIndicator color={colors.accent} />}
      </Row>
      <P muted>
        {state === 'pending' ? `Use your face or fingerprint to ${what}.` : state === 'ok' ? `${what[0].toUpperCase()}${what.slice(1)} — done.` : `Biometric check failed. ${what[0].toUpperCase()}${what.slice(1)} did not happen.`}
      </P>
    </Card>
  );
}
