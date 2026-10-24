#!/usr/bin/env node
// Append / list labels on a recorded trace JSON.
//
//   node src/label.ts <recording.json> --start <ms> --end <ms> --label <name>
//   node src/label.ts <recording.json> --list
//   node src/label.ts <recording.json> --scenario <name>     # set meta.scenario
//
// Labels are scenario names (normal_walking, impairment_goggles, padded_fall,
// phone_drop, dancing, sitting, transit) or segment tags (stumble, impact, still,
// pickup, in_hand, in_pocket, in_bag, screen_on, noise). Use --force for others.
import { readFileSync, writeFileSync } from 'node:fs';
import { ALL_LABELS, isRecording, isScenario, type Label, type Recording } from './schema.ts';

function fail(msg: string): never { console.error(`label: ${msg}`); process.exit(1); }

const argv = process.argv.slice(2);
const file = argv.shift();
if (!file || file === '-h' || file === '--help') {
  console.error('usage: label <recording.json> (--start ms --end ms --label name [--force] | --list | --scenario name)');
  process.exit(file ? 0 : 1);
}

let start: number | undefined, end: number | undefined, label: string | undefined, scenario: string | undefined;
let list = false, force = false;
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  const v = () => { const x = argv[++i]; if (x === undefined) fail(`missing value for ${k}`); return x; };
  if (k === '--start') start = Number(v());
  else if (k === '--end') end = Number(v());
  else if (k === '--label') label = v();
  else if (k === '--scenario') scenario = v();
  else if (k === '--list') list = true;
  else if (k === '--force') force = true;
  else fail(`unknown arg ${k}`);
}

const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
if (!isRecording(raw)) fail(`${file} is not a Recording`);
const rec: Recording = raw;
rec.labels ??= [];

const lastT = rec.motion.length ? rec.motion[rec.motion.length - 1]!.t_ms : 0;

if (list) {
  console.log(`${file}: ${rec.motion.length} motion samples, ${(lastT / 1000).toFixed(1)}s, scenario=${rec.meta?.scenario ?? '-'}`);
  for (const l of rec.labels) console.log(`  ${String(l.t_start_ms).padStart(8)} - ${String(l.t_end_ms).padStart(8)}  ${l.label}`);
  process.exit(0);
}

if (scenario !== undefined) {
  if (!isScenario(scenario)) fail(`unknown scenario ${scenario}`);
  rec.meta = { ...rec.meta, scenario };
}

if (label !== undefined || start !== undefined || end !== undefined) {
  if (label === undefined || start === undefined || end === undefined) fail('--start, --end and --label are all required');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) fail('need 0 <= start < end (ms)');
  if (end > lastT + 1000) console.warn(`warning: end ${end} is past the last motion sample (${lastT})`);
  if (!ALL_LABELS.includes(label) && !force) fail(`unknown label ${label} (known: ${ALL_LABELS.join(', ')}; use --force)`);
  const l: Label = { t_start_ms: start, t_end_ms: end, label };
  rec.labels.push(l);
  rec.labels.sort((a, b) => a.t_start_ms - b.t_start_ms || a.t_end_ms - b.t_end_ms);
  console.log(`+ ${start}-${end} ${label}`);
}

writeFileSync(file, JSON.stringify(rec));
