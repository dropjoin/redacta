/* Redacta — verification suite.
 *
 * Runs with plain Node, no dependencies:  node test/verify.mjs
 *
 * What this proves (and what it deliberately does NOT prove):
 *  - The simulated scan returns the documented schema shape, spans point
 *    at real substrings, spans never overlap, the local summary never
 *    repeats an entity value, and documentType is a schema-enum value.
 *  - Redaction actually removes every redacted span value from the text
 *    the cloud lane would receive, and keeps the spans the user kept;
 *    overlapping spans cannot corrupt the redacted text, and the payload
 *    audit tells kept spans apart from real leaks.
 *  - Live scan output is parsed and normalised defensively: malformed
 *    JSON is a distinct failure, empty values cannot hang the locator,
 *    duplicated rows collapse, overlaps resolve, missing fields default.
 *  - The simulated analysis returns the sections the UI renders.
 *  - js/hybrid.js carries the same schema as data/schema.json, and its
 *    inferenceSource normalisation accepts both SDK spellings.
 *  - The committed tree carries no Firebase config (no accidental keys),
 *    every DOM id the UI code references exists in index.html, and every
 *    sample button resolves to a real sample file.
 * It does NOT prove anything about Gemini Nano quality, App Check, or the
 * cloud region — those need real Chrome hardware and are tracked openly
 * in SPIKES.md. Browser behaviour of the DOM wiring is guarded here only
 * by static checks; the live flow still needs the Spike 4 rehearsal.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simScan, simAnalyse, ENTITY_TYPES } from "../js/sim.js";
import { buildRedactedText, auditArtefact, keptBytes, resolveSpans } from "../js/redact.js";
import { SCAN_SCHEMA, normaliseSource, FIREBASE_CONFIG, APP_CHECK_CONFIG, parseScanOutput, normaliseScanData } from "../js/hybrid.js";

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
/* Sample ids are file names; the schema enum value for the medical sample
   is "medical_letter", not "medical". */
const EXPECTED_DOC_TYPE = { contract: "contract", payslip: "payslip", medical: "medical_letter" };
const DOC_TYPE_ENUM = JSON.parse(read("data/schema.json")).properties.documentType.enum;
const counts = {};
for (const [id, path] of SAMPLES) {
  const text = read(path);
  const scan = simScan(text, id);
  counts[id] = scan.entities.length;
  ok(scan.entities.length > 0, `${id}: finds spans`);
  ok(scan.documentType === EXPECTED_DOC_TYPE[id], `${id}: documentType is ${EXPECTED_DOC_TYPE[id]} (got ${scan.documentType})`);
  ok(DOC_TYPE_ENUM.includes(scan.documentType), `${id}: documentType is a schema-enum value`);
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
  /* Exercise the real builder from js/redact.js, not a reimplementation. */
  const withFlags = scan.entities.map((e) => ({ ...e, redact: e.redactByDefault }));
  const redacted = buildRedactedText(text, withFlags);
  const redact = scan.entities.filter((e) => e.redactByDefault);
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
ok(read(".gitignore").includes("js/firebase-config.js"), ".gitignore lists js/firebase-config.js");

/* ---- 8. Scan output parsing: malformed replies are a distinct failure -- */
{
  const good = parseScanOutput('{"documentType":"other","entities":[],"sensitivityScore":0,"localSummary":"x"}');
  ok(good.documentType === "other", "parseScanOutput accepts valid scan JSON");
  for (const [label, raw] of [["not JSON", "not json at all"], ["JSON array", "[1,2]"], ["JSON null", "null"], ["empty", ""]]) {
    let err = null;
    try { parseScanOutput(raw); } catch (e) { err = e; }
    ok(err && err.code === "BAD_SCAN_OUTPUT", `parseScanOutput rejects ${label} with BAD_SCAN_OUTPUT`);
  }
}

/* ---- 9. Live scan normalisation: hostile model output ------------------- */
{
  const text = "Call Dewi Anggraini at 1. Dewi Anggraini again.";
  // Empty value: the old indexOf loop spun forever here (indexOf("", n) === n).
  const empty = normaliseScanData({ documentType: "other", entities: [{ value: "", type: "EMAIL" }], sensitivityScore: 0, localSummary: "" }, text);
  ok(empty.entities.length === 0, "normaliseScanData skips empty values (terminates)");
  // Non-string values are skipped, not coerced into phantom spans.
  const weird = normaliseScanData({ documentType: "other", entities: [{ value: 42, type: "EMAIL" }, { value: null, type: "EMAIL" }, null], sensitivityScore: 0, localSummary: "" }, text);
  ok(weird.entities.length === 0, "normaliseScanData skips non-string values");
  // Duplicated model rows collapse to one span per occurrence.
  const dup = normaliseScanData({ documentType: "other", entities: [
    { value: "Dewi Anggraini", type: "PERSON_NAME", confidence: 0.9, sensitivity: "high", redactByDefault: true },
    { value: "Dewi Anggraini", type: "PERSON_NAME", confidence: 0.9, sensitivity: "high", redactByDefault: true },
  ], sensitivityScore: 50, localSummary: "" }, text);
  ok(dup.entities.length === 2, `duplicated rows collapse to 2 occurrence spans (got ${dup.entities.length})`);
  // A span and its sub-span resolve to the longer span only.
  const ov = normaliseScanData({ documentType: "other", entities: [
    { value: "Dewi Anggraini", type: "PERSON_NAME", confidence: 0.9, sensitivity: "high", redactByDefault: true },
    { value: "Anggraini", type: "PERSON_NAME", confidence: 0.9, sensitivity: "high", redactByDefault: true },
  ], sensitivityScore: 50, localSummary: "" }, text);
  ok(ov.entities.length === 2 && ov.entities.every((e) => e.value === "Dewi Anggraini"), "overlapping sub-spans resolve to the longer span");
  // Missing/invalid fields get safe defaults, never NaN/undefined.
  const def = normaliseScanData({ documentType: "bogus", entities: [
    { value: "Dewi Anggraini", type: "PERSON_NAME" },
  ], sensitivityScore: 999, localSummary: 7 }, text);
  ok(def.documentType === "other", "invalid documentType defaults to other");
  ok(def.sensitivityScore === 100, "sensitivityScore clamps to 100");
  ok(def.localSummary === "", "non-string localSummary defaults to empty string");
  const d0 = def.entities[0];
  ok(d0.confidence === 0.5 && d0.sensitivity === "medium" && d0.redactByDefault === false, "missing confidence/sensitivity/defaults are safe");
  const crit = normaliseScanData({ documentType: "other", entities: [
    { value: "Dewi Anggraini", type: "PERSON_NAME", sensitivity: "critical" },
  ], sensitivityScore: 0, localSummary: "" }, text);
  ok(crit.entities[0].redactByDefault === true, "missing redactByDefault derives from critical sensitivity");
  const badConf = normaliseScanData({ documentType: "other", entities: [
    { value: "Dewi Anggraini", type: "PERSON_NAME", confidence: 42, sensitivity: "low", redactByDefault: false },
  ], sensitivityScore: 0, localSummary: "" }, text);
  ok(badConf.entities[0].confidence === 1, "confidence clamps to [0,1]");
  // Values absent from the text produce no spans; non-array entities is safe.
  const absent = normaliseScanData({ documentType: "other", entities: [{ value: "Nobody Here", type: "PERSON_NAME" }], sensitivityScore: 0, localSummary: "" }, text);
  ok(absent.entities.length === 0, "values absent from the text produce no spans");
  const noArr = normaliseScanData({ documentType: "other", entities: "nope", sensitivityScore: 0, localSummary: "" }, text);
  ok(noArr.entities.length === 0, "non-array entities yields no spans");
  // Ids are sequential in document order.
  ok(dup.entities.map((e) => e.id).join(",") === "e1,e2", "normalised spans get sequential ids");
}

/* ---- 10. Redaction builder + payload audit (js/redact.js) --------------- */
{
  const text = "Call Dewi Anggraini at 1. Dewi Anggraini again.";
  const overlapping = [
    { value: "Dewi Anggraini", type: "PERSON_NAME", start: 5, end: 19, redact: true },
    { value: "Anggraini", type: "PERSON_NAME", start: 10, end: 19, redact: true },
    { value: "Dewi Anggraini", type: "PERSON_NAME", start: 26, end: 40, redact: true },
    { value: "Anggraini", type: "PERSON_NAME", start: 31, end: 40, redact: true },
  ];
  ok(buildRedactedText(text, overlapping) === "Call [PERSON_NAME] at 1. [PERSON_NAME] again.",
    "overlapping spans redact without eating surrounding text");
  ok(resolveSpans(overlapping).length === 2, "resolveSpans drops overlapped spans");
  ok(buildRedactedText(text, []) === text, "no spans leaves text untouched");

  // Keep-all: the artefact IS the raw text, and the audit must say so.
  const kept = [
    { value: "Dewi Anggraini", type: "PERSON_NAME", start: 5, end: 19, redact: false },
    { value: "Dewi Anggraini", type: "PERSON_NAME", start: 26, end: 40, redact: false },
  ];
  const keepAll = buildRedactedText(text, kept);
  ok(keepAll === text, "keep-all artefact equals the raw text");
  const auditKeep = auditArtefact(keepAll, kept);
  ok(auditKeep.leaked.length === 0 && auditKeep.kept.length === 2, "keep-all audit reports kept spans, not a clean bill of health");
  ok(keptBytes(keepAll, kept) === 2 * new TextEncoder().encode("Dewi Anggraini").length, "keptBytes counts kept span bytes");

  // True leak: a redacted value present with no kept span to explain it.
  const red = [{ value: "Dewi Anggraini", type: "PERSON_NAME", start: 5, end: 19, redact: true }];
  ok(auditArtefact(text, red).leaked.length === 1, "redacted value still present is a leak");
  ok(auditArtefact("Call [PERSON_NAME] at 1.", red).leaked.length === 0, "properly redacted value is not a leak");
  // Same value kept once and redacted once: presence is explained by the
  // kept occurrence, so it is `kept`, not `leaked`.
  const mixed = [
    { value: "Dewi Anggraini", type: "PERSON_NAME", start: 5, end: 19, redact: true },
    { value: "Dewi Anggraini", type: "PERSON_NAME", start: 26, end: 40, redact: false },
  ];
  const auditMixed = auditArtefact("Call [PERSON_NAME] at 1. Dewi Anggraini again.", mixed);
  ok(auditMixed.leaked.length === 0 && auditMixed.kept.length === 1, "value present via a kept occurrence is not a leak");
}

/* ---- 11. Static wiring: DOM ids, samples, title, ledger source ---------- */
{
  const html = read("index.html");
  const appSrc = read("js/app.js");
  const ids = [...appSrc.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  ok(ids.length > 20, `app.js references DOM ids (${ids.length} found)`);
  for (const id of [...new Set(ids)]) {
    ok(html.includes(`id="${id}"`), `index.html defines id="${id}"`);
  }
  const samples = [...html.matchAll(/data-sample="([^"]+)"/g)].map((m) => m[1]);
  ok(samples.length === 3, "three sample buttons exist");
  for (const id of samples) {
    ok(read(`data/samples/${id}.txt`).length > 0, `sample file data/samples/${id}.txt exists and is non-empty`);
  }
  const title = html.match(/<title>([^<]*)<\/title>/)[1];
  ok(!title.includes("—"), "page title contains no em dash");
  ok(appSrc.includes("res.ok"), "loadSample guards the fetch response status");
  ok(appSrc.includes("liveSource ?? "), "scan ledger uses the SDK-reported inferenceSource in live mode");
  ok(appSrc.includes("invalidateScan()"), "editing the document invalidates a stale scan");
  ok(!read("js/hybrid.js").includes("JSON.parse(result.response.text())"), "scan lane parses via parseScanOutput, not a bare JSON.parse");
}

/* ---- 12. No secret-shaped values in the committed tree ------------------ */
{
  // Deliberately skips: .git, binary assets, and the gitignored local
  // config file, which this suite must never read.
  const SECRET_PATTERNS = [
    [/AIza[0-9A-Za-z\-_]{35}/, "Google API key shape"],
    [/["']apiKey["']\s*:\s*"[A-Za-z0-9]/, "apiKey assignment"],
    [/6L[A-Za-z0-9\-_]{10,}/, "reCAPTCHA site key shape"],
  ];
  const skipDirs = new Set([".git", "node_modules"]);
  const walk = (dir) => {
    let out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (!skipDirs.has(name)) out = out.concat(walk(p)); }
      else out.push(p);
    }
    return out;
  };
  let scanned = 0;
  for (const p of walk(root)) {
    const rel = p.slice(root.length + 1);
    if (rel === "js/firebase-config.js") continue;
    if (/\.(png|mp4|woff2)$/.test(rel)) continue;
    const content = readFileSync(p, "utf8");
    scanned++;
    for (const [re, label] of SECRET_PATTERNS) {
      ok(!re.test(content), `${rel}: no ${label}`);
    }
  }
  ok(scanned > 10, `secret scan covered ${scanned} files`);
}

/* ---- 13. Guessed document types stay inside the schema enum ------------- */
{
  ok(DOC_TYPE_ENUM.includes(simScan("patient referral letter", null).documentType), "guessed medical type is schema-valid");
  ok(simScan("patient referral letter", null).documentType === "medical_letter", "guessed medical type is medical_letter");
  ok(simScan("invoice number 5, payment due", null).documentType === "invoice", "guessed invoice type is invoice");
  const medAnalysis = simAnalyse({ redactedText: "Referral text.", documentType: "medical_letter", entityStats: { total: 1, critical: 1, high: 0, medium: 0, low: 0 } });
  ok(/specialist/i.test(medAnalysis.summary), "medical_letter analysis uses the referral summary line");
}

console.log(`\nPASS: ${checks} checks, span counts ${JSON.stringify(counts)}`);
