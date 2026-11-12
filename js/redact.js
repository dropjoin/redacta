/* ============================================================================
   Redacta — redact.js
   Pure redaction helpers, shared by the UI and the verification suite.

   Two invariants live here:

   1. The redacted text is built from the same non-overlapping span set the
      highlight view shows. Overlapping spans (a live model can return a
      span and a sub-span of it) must never corrupt the output: spans are
      resolved longest-first per start offset, and any span that starts
      inside an already-accepted span is skipped.
   2. The payload audit is honest about KEPT spans. A span the user chose
      to keep is verbatim raw text in the payload the cloud lane receives.
      Reporting "no raw personal data" while kept spans are present — the
      old check only looked at redacted spans, so "Keep all" produced a
      clean bill of health for a payload identical to the raw document —
      is false. auditArtefact() separates true leaks (a redacted value
      present with no kept span to explain it) from kept values (present
      because the user kept that span).
   ========================================================================== */

import { ENTITY_TYPES } from "./sim.js";

/** Resolve spans to a non-overlapping set: earliest start wins, and for
    equal starts the longest span wins. Input spans are not mutated. */
export function resolveSpans(entities) {
  const sorted = [...entities]
    .filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let lastEnd = -1;
  for (const e of sorted) {
    if (e.start >= lastEnd) {
      out.push(e);
      lastEnd = e.end;
    }
  }
  return out;
}

/** Build the redacted text: every redacted span in the resolved set is
    replaced by its type token; kept spans and plain text survive verbatim. */
export function buildRedactedText(text, entities) {
  const spans = resolveSpans(entities.filter((e) => e.redact));
  let out = "";
  let last = 0;
  for (const e of spans) {
    out += text.slice(last, e.start);
    out += ENTITY_TYPES[e.type]?.token ?? "[REDACTED]";
    last = e.end;
  }
  out += text.slice(last);
  return out;
}

/**
 * Audit a redacted artefact against the scan's entities.
 * Returns { leaked, kept } where:
 *  - leaked: redacted spans whose value is still present in the artefact
 *    AND no kept span carries the same value (a real redaction failure).
 *  - kept: kept spans whose value is present in the artefact (verbatim
 *    raw text the user chose to send; not a failure, but it must be
 *    reported, never hidden behind a clean "No").
 * A value present only because another occurrence of it was kept is
 * attributed to `kept`, not `leaked`.
 */
export function auditArtefact(redactedText, entities) {
  const keptValues = new Set(
    entities.filter((e) => !e.redact).map((e) => e.value).filter((v) => typeof v === "string" && v.length > 0)
  );
  const leaked = [];
  const kept = [];
  for (const e of entities) {
    if (typeof e.value !== "string" || e.value.length === 0) continue;
    if (!redactedText.includes(e.value)) continue;
    if (e.redact) {
      if (!keptValues.has(e.value)) leaked.push(e);
    } else {
      kept.push(e);
    }
  }
  return { leaked, kept };
}

/** UTF-8 byte length of the kept span values present in the artefact —
    the raw bytes a cloud call over this artefact would actually carry. */
export function keptBytes(redactedText, entities) {
  const { kept } = auditArtefact(redactedText, entities);
  const enc = new TextEncoder();
  return kept.reduce((sum, e) => sum + enc.encode(e.value).length, 0);
}
