#!/usr/bin/env node
// Convert recorded trace JSON into per-scenario folders for `sim batch`.
//
//   node src/export.ts --in recordings/ --out ../../core/traces [--split] [--scenario name]
//
// Input: one or more .json files (or a directory of them) matching `Recording`.
// Output: <out>/<scenario>/<id>.json (SimTrace) + <out>/index.json manifest.
//
// Scenario resolution per file: --scenario flag > meta.scenario > the longest
// scenario-named label. With --split, every scenario-labeled segment becomes its
// own trace (time rebased to 0) so one long session yields many files.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve, extname } from 'node:path';
import { isRecording, isScenario, SCENARIOS, type Recording, type SimTrace, type Scenario, type Label } from './schema.ts';

type Args = { in: string[]; out: string; split: boolean; scenario?: Scenario };

function parseArgs(argv: string[]): Args {
  const a: Args = { in: [], out: resolve('core/traces'), split: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) fail(`missing value for ${k}`); return x; };
    if (k === '--in') a.in.push(v());
    else if (k === '--out') a.out = resolve(v());
    else if (k === '--split') a.split = true;
    else if (k === '--scenario') { const s = v(); if (!isScenario(s)) fail(`unknown scenario ${s}`); a.scenario = s; }
    else if (k === '-h' || k === '--help') { usage(); process.exit(0); }
    else a.in.push(k);
  }
  if (a.in.length === 0) { usage(); fail('no input'); }
  return a;
}
function usage() { console.error('usage: export --in <file|dir>... [--out core/traces] [--split] [--scenario <name>]'); }
function fail(msg: string): never { console.error(`export: ${msg}`); process.exit(1); }

function listJson(p: string): string[] {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).filter(f => extname(f) === '.json').sort().map(f => join(p, f));
  return [p];
}

function scenarioOf(rec: Recording, flag?: Scenario): Scenario | null {
  if (flag) return flag;
  if (rec.meta?.scenario && isScenario(rec.meta.scenario)) return rec.meta.scenario;
  let best: { s: Scenario; dur: number } | null = null;
  for (const l of rec.labels ?? []) {
    if (!isScenario(l.label)) continue;
    const dur = l.t_end_ms - l.t_start_ms;
    if (!best || dur > best.dur) best = { s: l.label, dur };
  }
  return best?.s ?? null;
}

function slice<T extends { t_ms: number }>(xs: T[] | undefined, t0: number, t1: number, rebase: number): T[] {
  return (xs ?? []).filter(x => x.t_ms >= t0 && x.t_ms < t1).map(x => ({ ...x, t_ms: x.t_ms - rebase }));
}

/**
 * The sim's pass rule (synth::Expect) for a scenario: must snatch, must reach a location unlock, or must stay quiet
 * (no check-in). "At most Check" scenarios (unsteady walking, dancing…) count as quiet: a lone gait incident must not
 * ask "You okay?".
 */
function simExpect(scenario: Scenario): SimTrace['meta']['expect'] {
  const e = SCENARIOS[scenario];
  if (e.min_escalation === 'Snatch') return 'snatch';
  if (e.min_escalation) return 'unlock';
  return 'quiet';
}

function toTrace(rec: Recording, id: string, scenario: Scenario, window?: Label): SimTrace {
  const t0 = window?.t_start_ms ?? 0;
  const t1 = window?.t_end_ms ?? Number.POSITIVE_INFINITY;
  const labels: Label[] = (rec.labels ?? [])
    .filter(l => l.t_end_ms > t0 && l.t_start_ms < t1)
    .map(l => ({ label: l.label, t_start_ms: Math.max(l.t_start_ms, t0) - t0, t_end_ms: Math.min(l.t_end_ms, t1) - t0 }));
  return {
    version: 1,
    id,
    scenario,
    expect: SCENARIOS[scenario],
    meta: {
      ...rec.meta, scenario, expect: simExpect(scenario), night_mode: true,
      hour_local: rec.context.find(c => c.t_ms >= t0)?.hour_local ?? 23, incident_t_ms: null, seed: 0,
    },
    motion: slice(rec.motion, t0, t1, t0),
    context: slice(rec.context, t0, t1, t0),
    audio: slice(rec.audio, t0, t1, t0),
    actions: slice(rec.actions, t0, t1, t0),
    labels,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = args.in.flatMap(listJson);
  const manifest: { id: string; scenario: Scenario; path: string; samples: number; duration_ms: number }[] = [];
  let skipped = 0;

  for (const f of files) {
    let rec: unknown;
    try { rec = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.warn(`skip ${f}: ${(e as Error).message}`); skipped++; continue; }
    if (!isRecording(rec)) { console.warn(`skip ${f}: not a Recording (needs motion[] + context[])`); skipped++; continue; }
    const base = basename(f, '.json');

    const jobs: { id: string; scenario: Scenario; window?: Label }[] = [];
    if (args.split) {
      const segs = (rec.labels ?? []).filter(l => isScenario(l.label));
      segs.forEach((l, i) => jobs.push({ id: `${base}-${String(i + 1).padStart(2, '0')}`, scenario: l.label as Scenario, window: l }));
    }
    if (jobs.length === 0) {
      const s = scenarioOf(rec, args.scenario);
      if (!s) { console.warn(`skip ${f}: no scenario (use --scenario, meta.scenario, or a scenario label)`); skipped++; continue; }
      jobs.push({ id: base, scenario: s });
    }

    for (const j of jobs) {
      const trace = toTrace(rec, j.id, j.scenario, j.window);
      if (trace.motion.length === 0) { console.warn(`skip ${j.id}: empty motion`); skipped++; continue; }
      const dir = join(args.out, j.scenario);
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${j.id}.json`);
      writeFileSync(out, JSON.stringify(trace));
      const last = trace.motion[trace.motion.length - 1]!;
      manifest.push({ id: j.id, scenario: j.scenario, path: `${j.scenario}/${j.id}.json`, samples: trace.motion.length, duration_ms: last.t_ms });
      console.log(`${j.scenario}/${j.id}.json  ${trace.motion.length} samples  ${(last.t_ms / 1000).toFixed(0)}s`);
    }
  }

  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'index.json'), JSON.stringify({ version: 1, generated_at: new Date().toISOString(), traces: manifest }, null, 2));
  console.log(`wrote ${manifest.length} traces to ${args.out} (${skipped} skipped)`);
  if (manifest.length === 0) process.exit(1);
}

main();
