import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button, Card, Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { fmtClock } from '@/components/telemetry/labels';
import type { AnalysisState } from './useRiskAnalysis';
import type { RiskLevel, Urgency } from './riskAnalysis';

export const RISK_COLOR: Record<RiskLevel, string> = { low: colors.ok, elevated: colors.warn, high: colors.danger, critical: colors.danger };
export const URGENCY_COLOR: Record<Urgency, string> = { info: colors.accent, warn: colors.warn, urgent: colors.danger };
const RISK_LABEL: Record<RiskLevel, string> = { low: 'low risk', elevated: 'elevated', high: 'high risk', critical: 'critical' };

const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};
const shortModel = (m: string) => m.split('/').pop()?.replace(/:free$/, '') ?? m;

/**
 * Right-hand column of the monitor: the LM's read of the subject's incident log (risk, what the chain adds up to,
 * the innocent reading, what would change it) and the reminders it has shown the friends.
 */
export function AnalysisPanel({ state, subjectName, now, onRefresh, onClear }: {
  state: AnalysisState & { configured: boolean };
  subjectName: string;
  now: number;
  onRefresh: () => void;
  /** clears the analysis, reminder history and pop-ups */
  onClear: () => void;
}) {
  const a = state.analysis;
  const status =
    state.status === 'running' ? 'analyzing…'
    : state.status === 'waiting' ? 'new incidents · analyzing shortly'
    : state.status === 'error' && state.retryAt ? `retrying in ${Math.max(0, Math.ceil((state.retryAt - now) / 1000))} s`
    : a ? `updated ${ago(state.atMs, now)}`
    : '';

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.head}>
        <Text style={styles.title}>AI incident analysis</Text>
        <View style={{ flex: 1 }} />
        {state.configured && (a || state.reminders.length > 0 || state.status === 'running' || !!state.error) && (
          <Button title="Clear" kind="ghost" onPress={onClear} style={styles.btn} testID="ai-clear" />
        )}
        {state.configured && <Button title={state.status === 'running' ? 'Analyzing' : 'Re-analyze'} kind="ghost" onPress={onRefresh} loading={state.status === 'running'} style={styles.btn} testID="ai-refresh" />}
      </View>
      {!!status && <Text style={styles.meta}>{status}{state.model && a ? ` · ${shortModel(state.model)}` : ''}</Text>}

      {!state.configured && (
        <Card>
          <Text style={styles.body}>AI analysis is off. Add an OpenRouter key to <Text style={styles.code}>apps/mobile/.env</Text>:</Text>
          <Text style={styles.code}>OPENROUTER_API_KEY=sk-or-…</Text>
          <Text style={styles.meta}>Then restart Metro. Free models are used by default (OPENROUTER_MODEL overrides).</Text>
        </Card>
      )}

      {state.error && (
        <View style={[styles.box, { borderColor: colors.warn }]}>
          <Text style={[styles.meta, { color: colors.warn }]}>{state.error}</Text>
        </View>
      )}

      {state.status === 'cleared' && !state.error && (
        <Card style={styles.quiet}>
          <Text style={styles.quietTitle}>Messages cleared</Text>
          <Text style={[styles.meta, { textAlign: 'center' }]}>A new analysis appears when {subjectName}'s incidents change, or press Re-analyze.</Text>
        </Card>
      )}

      {state.status === 'quiet' && !state.error && (
        <Card tint={colors.ok} style={styles.quiet}>
          <View style={styles.okDot} />
          <Text style={styles.quietTitle}>Nothing to analyze</Text>
          <Text style={[styles.meta, { textAlign: 'center' }]}>The engine has not flagged anything for {subjectName}. The analysis starts as soon as an incident is logged.</Text>
        </Card>
      )}

      {a && (
        <>
          <Card tint={RISK_COLOR[a.risk]} style={{ gap: 8 }}>
            <View style={styles.riskRow}>
              <Pill text={RISK_LABEL[a.risk]} color={RISK_COLOR[a.risk]} />
              <Text style={styles.meta}>{subjectName}</Text>
            </View>
            <Text style={styles.headline}>{a.headline}</Text>
            {!!a.analysis && <Text style={styles.body}>{a.analysis}</Text>}
          </Card>

          {a.chain.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={styles.h3}>How it adds up</Text>
              <View style={styles.box}>
                {a.chain.map((c, i) => (
                  <View key={i} style={styles.step}>
                    <View style={styles.stepRail}>
                      <View style={[styles.stepDot, { backgroundColor: RISK_COLOR[a.risk] }]} />
                      {i < a.chain.length - 1 && <View style={styles.stepLine} />}
                    </View>
                    <View style={{ flex: 1, paddingBottom: 8 }}>
                      <Text style={styles.meta}>{c.t}{c.id != null ? ` · #${c.id}` : ''}</Text>
                      <Text style={styles.body}>{c.note}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

          {!!a.benign && (
            <View style={{ gap: 4 }}>
              <Text style={styles.h3}>Innocent explanation</Text>
              <Text style={styles.body}>{a.benign}</Text>
            </View>
          )}
          {!!a.watchFor && (
            <View style={{ gap: 4 }}>
              <Text style={styles.h3}>What would change this read</Text>
              <Text style={styles.body}>{a.watchFor}</Text>
            </View>
          )}
        </>
      )}

      {state.reminders.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={styles.h3}>Reminders sent to this console</Text>
          {state.reminders.slice(0, 8).map((r) => (
            <View key={r.id} style={[styles.reminder, { borderLeftColor: URGENCY_COLOR[r.urgency] }]}>
              <Text style={styles.body}>{r.text}</Text>
              <Text style={styles.meta}>{fmtClock(r.atMs)} · {r.urgency}</Text>
            </View>
          ))}
        </View>
      )}

      {state.configured && (
        <Text style={styles.foot}>
          An AI reading of the incident reports (types and times only, no measurements, location or audio), sent from this
          browser to OpenRouter. It can be wrong:
          the engine's escalation and your own call come first.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  btn: { paddingVertical: 4, paddingHorizontal: 10, minHeight: 0 },
  h3: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  headline: { color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  code: { color: colors.accent, fontFamily: 'monospace', fontSize: 13 },
  riskRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  box: { backgroundColor: colors.card, borderRadius: radius - 4, padding: 10, borderWidth: 1, borderColor: colors.border },
  step: { flexDirection: 'row', gap: 10 },
  stepRail: { width: 10, alignItems: 'center' },
  stepDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  stepLine: { flex: 1, width: 2, backgroundColor: colors.muted, opacity: 0.35, marginTop: 2 },
  reminder: { backgroundColor: colors.card, borderRadius: 10, padding: 10, gap: 4, borderLeftWidth: 3, borderWidth: 1, borderColor: colors.border },
  quiet: { alignItems: 'center', gap: 8, paddingVertical: 22 },
  quietTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  okDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.ok },
  foot: { color: colors.muted, fontSize: 11, lineHeight: 16 },
});
