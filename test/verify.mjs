/* Redacta — verification suite.
 *
 * Runs with plain Node, no dependencies:  node test/verify.mjs
 *
 * What this proves (and what it deliberately does NOT prove):
 *  - The simulated scan returns the documented schema shape, spans point
 *    at real substrings, spans never overlap, and the local summary never
 *    repeats an entity value.
 *  - Redaction actually removes every redacted span value from the text
 *    the cloud lane would receive, and keeps the spans the user kept.
 *  - The simulated analysis returns the sections the UI renders.
 *  - js/hybrid.js carries the same schema as data/schema.json, and its
 *    inferenceSource normalisation accepts both SDK spellings.
 *  - The committed tree carries no Firebase config (no accidental keys).
 * It does NOT prove anything about Gemini Nano quality, App Check, or the
 * cloud region — those need real Chrome hardware and are tracked openly
 * in SPIKES.md.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simScan, simAnalyse, ENTITY_TYPES } from "../js/sim.js";
import { SCAN_SCHEMA, normaliseSource, FIREBASE_CONFIG, APP_CHECK_CONFIG } from "../js/hybrid.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

let checks = 0;
const ok = (cond, msg) => { checks++; assert.ok(cond, msg); };

/* ---- 1. Curated scans: spans are real, ordered, non-overlapping -------- */
const SAMPLES = [
  ["contract", "data/samples/contract.txt"],
  ["payslip", "data/samples/payslip.txt"],
  ["medical", "data/samples/medical.txt"],
];
const counts = {};
for (const [id, path] of SAMPLES) {
  const text = read(path);
  const scan = simScan(text, id);
  counts[id] = scan.entities.length;
  ok(scan.entities.length > 0, `${id}: finds spans`);
  ok(scan.documentType === id, `${id}: documentType is ${id}`);
  ok(Number.isInteger(scan.sensitivityScore) && scan.sensitivityScore >= 0 && scan.sensitivityScore <= 100,
    `${id}: sensitivityScore in 0..100 (got ${scan.sensitivityScore})`);
  let prevEnd = -1;
  for (const e of scan.entities) {
    ok(text.slice(e.start, e.end) === e.value, `${id}: span "${e.value}" matches its offsets`);
    ok(e.start >= prevEnd, `${id}: spans do not overlap (prev end ${prevEnd}, start ${e.start})`);
    prevEnd = e.end;
    ok(e.confidence > 0 && e.confidence <= 1, `${id}: confidence in (0,1] for "${e.value}"`);
    ok(["critical", "high", "medium", "low"].includes(e.sensitivity), `${id}: valid sensitivity`);
    ok(typeof e.redactByDefault === "boolean", `${id}: redactByDefault is boolean`);
    ok(ENTITY_TYPES[e.type], `${id}: known entity type ${e.type}`);
    ok(!scan.localSummary.includes(e.value), `${id}: localSummary leaks no entity value ("${e.value}")`);
  }
  console.log(`  ${id}: ${scan.entities.length} spans, score ${scan.sensitivityScore}/100`);

  /* ---- 2. Redaction: the artefact the cloud lane receives --------------- */
  const redact = scan.entities.filter((e) => e.redactByDefault).sort((a, b) => b.start - a.start);
  let redacted = text;
  for (const e of redact) redacted = redacted.slice(0, e.start) + ENTITY_TYPES[e.type].token + redacted.slice(e.end);
  for (const e of redact) {
    ok(!redacted.includes(e.value), `${id}: redacted span value absent from artefact ("${e.value}")`);
  }
  for (const e of scan.entities.filter((e) => !e.redactByDefault)) {
    ok(redacted.includes(e.value), `${id}: kept span value survives ("${e.value}")`);
  }

  /* ---- 3. Simulated analysis returns every rendered section ------------ */
  const artefact = {
    redactedText: redacted,
    documentType: scan.documentType,
    entityStats: { total: redact.length, critical: 0, high: 0, medium: 0, low: 0 },
  };
  const analysis = simAnalyse(artefact);
  ok(typeof analysis.summary === "string" && analysis.summary.length > 20, `${id}: analysis summary`);
  ok(Array.isArray(analysis.watchOuts) && analysis.watchOuts.length > 0, `${id}: watch-outs present`);
  ok(Array.isArray(analysis.obligations) && analysis.obligations.length > 0, `${id}: obligations present`);
  ok(analysis.redactionNote.includes(String(redact.length)), `${id}: redaction note counts spans`);
}
ok(counts.contract >= 19, `contract finds >=19 occurrences (got ${counts.contract})`);

/* ---- 4. Generic extraction for pasted (non-sample) text ----------------- */
const pasted = "Reach me at jane.doe@example.com or +62 812-3456-7890. My ID is 1234567890123456 and the fee is Rp 1.500.000.";
const generic = simScan(pasted, null);
const types = generic.entities.map((e) => e.type);
for (const t of ["EMAIL", "PHONE", "NATIONAL_ID", "AMOUNT"]) ok(types.includes(t), `generic scan finds ${t}`);
ok(generic.localSummary.length > 0, "generic scan has a summary");

/* ---- 5. Schema parity: hybrid.js SCAN_SCHEMA vs data/schema.json -------- */
const fileSchema = JSON.parse(read("data/schema.json"));
const strip = (s) => {
  const { $schema, title, description, ...rest } = s;
  const clean = (o) => {
    if (Array.isArray(o)) return o.map(clean);
    if (o && typeof o === "object") {
      const out = {};
      for (const [k, v] of Object.entries(o)) if (k !== "description") out[k] = clean(v);
      return out;
    }
    return o;
  };
  return clean(rest);
};
assert.deepEqual(strip(fileSchema), strip(SCAN_SCHEMA), "SCAN_SCHEMA matches data/schema.json");
checks++;

/* ---- 6. inferenceSource normalisation ----------------------------------- */
ok(normaliseSource("on_device", "X") === "ON_DEVICE", "lowercase on_device");
ok(normaliseSource("ON_DEVICE", "X") === "ON_DEVICE", "uppercase ON_DEVICE");
ok(normaliseSource("in_cloud", "X") === "IN_CLOUD", "lowercase in_cloud");
ok(normaliseSource("IN_CLOUD", "X") === "IN_CLOUD", "uppercase IN_CLOUD");
ok(normaliseSource(undefined, "FALLBACK") === "FALLBACK", "missing value falls back");
ok(normaliseSource("bogus", "FALLBACK") === "FALLBACK", "unknown value falls back");

/* ---- 7. No Firebase config committed ------------------------------------ */
ok(FIREBASE_CONFIG === null, "FIREBASE_CONFIG is null in the committed tree");
ok(APP_CHECK_CONFIG === null, "APP_CHECK_CONFIG is null in the committed tree");

console.log(`\nPASS: ${checks} checks, span counts ${JSON.stringify(counts)}`);
