import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { fmtClock } from '@/components/telemetry/labels';
import type { AnalysisState } from './useRiskAnalysis';
import type { Analysis, Assessment, Driver, Effect, RiskLevel, Trajectory, Urgency } from './riskAnalysis';
import { useAnchor, useFocusKey, type LinkSpec } from './ReasoningLinks';

export const RISK_COLOR: Record<RiskLevel, string> = { low: colors.ok, elevated: colors.warn, high: colors.danger, critical: colors.danger };
export const URGENCY_COLOR: Record<Urgency, string> = { info: colors.accent, warn: colors.warn, urgent: colors.danger };
const RISK_LABEL: Record<RiskLevel, string> = { low: 'low risk', elevated: 'elevated', high: 'high risk', critical: 'critical' };
const TRAJECTORY_LABEL: Record<Trajectory, string> = { rising: '↑ rising', steady: '→ steady', easing: '↓ easing' };

const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};
const shortModel = (m: string) => m.split('/').pop()?.replace(/:free$/, '') ?? m;

/**
 * Right-hand column of the monitor: the LM's read of the subject's incident log (risk, what the chain adds up to,
 * the innocent reading, what would change it) and the reminders it has shown the friends.
 */
export function AnalysisPanel({ state, subjectName, now, onRefresh, onClear, kindOf, timeOf }: {
  state: AnalysisState & { configured: boolean };
  subjectName: string;
  now: number;
  onRefresh: () => void;
  /** clears the analysis, reminder history and pop-ups */
  onClear: () => void;
  /** display name of incident #id's kind, if the console still holds it */
  kindOf?: (id: number) => string | null;
  /** when incident #id started (phone ms), to list the readings in the log's order */
  timeOf?: (id: number) => number | null;
}) {
  const a = state.analysis;
  const status =
    state.status === 'running' ? 'analyzing…'
    : state.status === 'waiting' ? 'new incidents · analysis starts soon'
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
          <Text style={styles.body}>AI analysis is off. Add a key to <Text style={styles.code}>apps/mobile/.env</Text>:</Text>
          <Text style={styles.code}>EXPO_PUBLIC_ANTHROPIC_API_KEY=sk-ant-…</Text>
          <Text style={styles.meta}>The default model is Claude Haiku 5.5. Set EXPO_PUBLIC_ANTHROPIC_MODEL to pick another. A free OpenRouter key (OPENROUTER_API_KEY) also works and acts as the fallback. Restart Metro after you edit the file.</Text>
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
          <Text style={[styles.meta, { textAlign: 'center' }]}>The console runs a new analysis after each new event on {subjectName}'s phone. Press Re-analyze to run one now.</Text>
        </Card>
      )}

      {state.status === 'quiet' && !state.error && (
        <Card tint={colors.ok} style={styles.quiet}>
          <View style={styles.okDot} />
          <Text style={styles.quietTitle}>Nothing to analyze</Text>
          <Text style={[styles.meta, { textAlign: 'center' }]}>The engine has not flagged anything for {subjectName}. Analysis starts with the first logged incident.</Text>
        </Card>
      )}

      {a && (
        <>
          <Card tint={RISK_COLOR[a.risk]} style={{ gap: 8 }}>
            <View style={styles.riskRow}>
              <View style={styles.riskLeft}>
                <Pill text={RISK_LABEL[a.risk]} color={RISK_COLOR[a.risk]} />
                <Text style={[styles.score, { color: RISK_COLOR[a.risk] }]}>{a.score}<Text style={styles.meta}>/100</Text></Text>
              </View>
              <Text style={styles.meta}>{subjectName}</Text>
            </View>
            <View style={styles.meter}>
              <View style={[styles.meterFill, { width: `${a.score}%`, backgroundColor: RISK_COLOR[a.risk] }]} />
            </View>
            <Text style={styles.meta}>
              {TRAJECTORY_LABEL[a.trajectory]} · {a.confidence} confidence{a.floor ? ` · raised to ${RISK_LABEL[a.risk]}: ${a.floor}` : ''}
            </Text>
            <Text style={styles.headline}>{a.headline}</Text>
            {!!a.analysis && <Text style={styles.body}>{a.analysis}</Text>}
          </Card>

          {(a.assessments.length > 0 || a.drivers.length > 0) && <ReasoningFlow a={a} kindOf={kindOf} timeOf={timeOf} />}

          {a.chain.length > 0 && (
            <View style={{ gap: 6 }}>
              <Text style={styles.h3}>Chain of events</Text>
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
              <Text style={styles.h3}>Signs that would change this read</Text>
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
          This browser sends the incident timeline to the model provider (Claude, or OpenRouter as fallback) for an AI
          reading. It sends kinds, order, gaps and durations, with no measurements, location or audio. The AI can be
          wrong. Trust the engine's escalation and your own judgment first.
        </Text>
      )}
    </View>
  );
}

const EFFECT_COLOR: Record<Effect, string> = { up: colors.danger, down: colors.ok, none: colors.muted };
const pts = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const lineWidth = (n: number) => 1 + Math.min(3, Math.abs(n) / 10);

/**
 * The links the console draws for a read: each incident row → the model's reading of it → the reasoning steps that
 * combine it → the total. An OK confirmation row links straight to the total when it reset the read.
 */
export function reasoningLinks(a: Analysis | null): LinkSpec[] {
  if (!a) return [];
  const out: LinkSpec[] = [];
  const assessed = new Set(a.assessments.map((x) => x.id));
  const combined = new Set<number>();
  for (const x of a.assessments) {
    out.push({ from: `inc-${x.id}`, to: `as-${x.id}`, color: EFFECT_COLOR[x.effect], width: lineWidth(x.points), kind: 'cross', focus: [`i${x.id}`] });
  }
  a.drivers.forEach((d, k) => {
    const color = EFFECT_COLOR[d.effect];
    for (const id of d.ids) {
      combined.add(id);
      out.push(assessed.has(id)
        ? { from: `as-${id}`, to: `dr-${k}`, color, width: 1.5, kind: 'inner', focus: [`i${id}`, `d${k}`] }
        : { from: `inc-${id}`, to: `dr-${k}`, color, width: 1.5, kind: 'cross', focus: [`i${id}`, `d${k}`] });
    }
    out.push({ from: `dr-${k}`, to: 'ai-total', color, width: lineWidth(d.points), kind: 'inner', focus: [`d${k}`, ...d.ids.map((id) => `i${id}`)] });
  });
  for (const x of a.assessments) {
    if (!combined.has(x.id) && x.points !== 0) {
      out.push({ from: `as-${x.id}`, to: 'ai-total', color: EFFECT_COLOR[x.effect], width: lineWidth(x.points), kind: 'inner', focus: [`i${x.id}`] });
    }
  }
  if (a.okReset) out.push({ from: `ok-${a.okReset.atMs}`, to: 'ai-total', color: colors.ok, width: 2.5, kind: 'cross', focus: ['ok'] });
  return out;
}

/** The model's work, top to bottom: one node per incident it weighed, the steps that combine them, the total. */
function ReasoningFlow({ a, kindOf, timeOf }: { a: Analysis; kindOf?: (id: number) => string | null; timeOf?: (id: number) => number | null }) {
  // Newest first, like the incident log, so the arrows between the columns run roughly level instead of crossing.
  const ordered = timeOf ? [...a.assessments].sort((x, y) => (timeOf(y.id) ?? 0) - (timeOf(x.id) ?? 0)) : a.assessments;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.h3}>How the score was built</Text>
      <View style={[styles.box, { gap: 6, paddingRight: 34 }]}>
        {ordered.map((x) => <AssessmentNode key={x.id} x={x} kind={kindOf?.(x.id) ?? null} />)}
        {a.drivers.length > 0 && <Text style={[styles.meta, styles.flowSep]}>{a.assessments.length ? 'then combined' : 'reasoning'}</Text>}
        {a.drivers.map((d, k) => <DriverNode key={k} k={k} d={d} />)}
        <TotalNode a={a} />
      </View>
    </View>
  );
}

function AssessmentNode({ x, kind }: { x: Assessment; kind: string | null }) {
  const ref = useAnchor(`as-${x.id}`);
  const f = useFocusKey(`i${x.id}`);
  const c = EFFECT_COLOR[x.effect];
  return (
    <Pressable ref={ref as never} {...f.hover} style={[styles.node, { borderLeftColor: c }, f.focused && styles.nodeFocus, f.dimmed && styles.nodeDim]}>
      <View style={styles.nodeHead}>
        <Text style={styles.nodeId}>#{x.id}</Text>
        {kind && <Text style={styles.nodeKind} numberOfLines={1}>{kind}</Text>}
        <View style={{ flex: 1 }} />
        <Text style={[styles.points, { color: c }]}>{pts(x.points)}</Text>
      </View>
      {!!x.reading && <Text style={styles.nodeText}>{x.reading}</Text>}
    </Pressable>
  );
}

function DriverNode({ k, d }: { k: number; d: Driver }) {
  const ref = useAnchor(`dr-${k}`);
  const f = useFocusKey(`d${k}`);
  const c = EFFECT_COLOR[d.effect];
  return (
    <Pressable ref={ref as never} {...f.hover} style={[styles.node, styles.driverNode, { borderLeftColor: c }, f.focused && styles.nodeFocus, f.dimmed && styles.nodeDim]}>
      <View style={styles.nodeHead}>
        <Text style={[styles.driverSign, { color: c }]}>{d.effect === 'up' ? '▲' : '▼'}</Text>
        <Text style={[styles.nodeText, { flex: 1 }]}>
          {d.factor}
          {d.ids.length > 0 && <Text style={styles.meta}>{'  '}{d.ids.map((id) => `#${id}`).join(' ')}</Text>}
        </Text>
        <Text style={[styles.points, { color: c }]}>{pts(d.points)}</Text>
      </View>
    </Pressable>
  );
}

function TotalNode({ a }: { a: Analysis }) {
  const ref = useAnchor('ai-total');
  const fitted = !a.okReset && a.ledger !== a.score;
  return (
    <View ref={ref as never} style={[styles.node, styles.totalNode, { borderLeftColor: RISK_COLOR[a.risk] }]}>
      <View style={styles.nodeHead}>
        <Text style={styles.totalLabel}>{a.okReset ? 'Reset' : 'Total'}</Text>
        {!a.okReset && <Text style={styles.meta}>{pts(a.ledger)}</Text>}
        <View style={{ flex: 1 }} />
        <Text style={[styles.points, { color: RISK_COLOR[a.risk] }]}>{a.score}/100 · {RISK_LABEL[a.risk]}</Text>
      </View>
      {a.okReset && <Text style={styles.meta}>Confirmed OK at {fmtClock(a.okReset.atMs)}: everything before it counts 0.</Text>}
      {fitted && <Text style={styles.meta}>The points add up to {a.ledger}; the score is fitted into the {RISK_LABEL[a.risk]} band{a.floor ? ` (${a.floor})` : ''}.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  node: { backgroundColor: colors.bg, borderRadius: 8, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, paddingVertical: 6, paddingHorizontal: 8, gap: 2 },
  nodeFocus: { borderColor: colors.accent },
  nodeDim: { opacity: 0.45 },
  nodeHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nodeId: { color: colors.text, fontSize: 12, fontWeight: '800', fontVariant: ['tabular-nums'] },
  nodeKind: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  nodeText: { color: colors.text, fontSize: 13, lineHeight: 18 },
  points: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  driverNode: { marginLeft: 14 },
  totalNode: { marginTop: 4 },
  totalLabel: { color: colors.text, fontSize: 13, fontWeight: '800' },
  flowSep: { textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 11, marginTop: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  btn: { paddingVertical: 4, paddingHorizontal: 10, minHeight: 0 },
  h3: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  headline: { color: colors.text, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  code: { color: colors.accent, fontFamily: 'monospace', fontSize: 13 },
  riskRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  riskLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  score: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  meter: { height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden' },
  meterFill: { height: 4, borderRadius: 2 },
  driverSign: { fontSize: 11, lineHeight: 20, width: 12 },
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
