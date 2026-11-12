# Redacta — Spikes still open

Prototype status (2026-11-09, updated 2026-11-12): the full product flow
runs end to end in clearly-labelled simulation mode. `js/hybrid.js`
implements the same flow against the real Firebase AI Logic SDK. The
Firebase project now exists ("redacta", ID redacta-440cf, Spark plan, AI
Logic Get Started completed with the Gemini Developer API), and the web
config lives only in the local gitignored `js/firebase-config.js` — but no
live call has been exercised yet: App Check has no provider registered,
enforcement is Unenforced, and no debug token exists. Each spike below
needs a real Chrome desktop (Chrome 139+, Prompt API stable for pages
since Chrome 148) on a machine with ≥22 GB free disk and a GPU with >4 GB
VRAM (or 16 GB RAM + 4 CPU cores). The Muse VM has no usable Chrome at
all, so these are explicitly NOT verified yet.

## Verified from the VM on 2026-11-12 (what this file does NOT claim is open)

- `node test/verify.mjs`: 568 checks pass — span offsets real and
  non-overlapping, local summaries leak no entity values, redaction
  removes every redacted span from the artefact, `SCAN_SCHEMA` in
  `js/hybrid.js` deep-equals `data/schema.json`, `inferenceSource`
  normalisation accepts both SDK spellings, no Firebase config committed,
  live scan output is parsed/normalised defensively (empty values,
  duplicates, overlaps, missing fields), the payload audit separates
  kept spans from real leaks, and every DOM id and sample file the UI
  references resolves. A DOM-stub harness (kept out of the repo, run
  from /tmp) additionally exercised the simulation flow end to end:
  sample load + 404 handling, stale-scan invalidation on edit, keep-all
  audit honesty, analysis and prepare flows — 23 checks, all passing.
- SDK surface checked against the official Firebase docs AND the published
  CDN bundles: `GoogleAIBackend` is the real export (`GeminiDevBackend`
  does not exist — an earlier draft used it and would have thrown);
  `model.initializeDeviceModel()` exists in the 13.0.0 bundle and NOT in
  12.5.0, so the pinned version is 13.0.0; `inferenceSource` enum values
  in the bundle are lowercase (`on_device`/`in_cloud`); a plain JSON
  schema is accepted as `responseConstraint`; `initialPrompts` uses the
  documented parts form. `js/hybrid.js` was corrected on all five points.
- Static wiring check: every DOM id referenced by `js/app.js` exists in
  `index.html`; every local asset reference resolves. This check caught
  two real bugs on 12 Nov: the medical sample file was named
  `medical-letter.txt` while the loader fetched `medical.txt` (renamed),
  and five font files were byte-identical duplicates of the two actually
  referenced (removed).
- NOT verified from the VM: any browser run of the page (no Chrome
  available here), any live Firebase call, any Nano behaviour. The
  `?shot=1` screenshot in `shots/` dates from 9 Nov and predates the
  12 Nov fixes; re-capture before submission.

## Spike 1 — Nano structured-extraction quality (the make-or-break test)
- Run the entity schema in `data/schema.json` (wired in hybrid.js as both
  the cloud `responseSchema` and the on-device `responseConstraint`)
  against the three bundled sample documents in `data/samples/`.
- Measure: spans found vs the curated ground truth in `js/sim.js`
  (contract 17 span types / 20 occurrences, payslip 13 types / 14
  occurrences, medical 16 — counts verified by `node test/verify.mjs`,
  12 Nov 2026; an earlier draft of this file said 19/13 and was wrong),
  false positives, and whether `localSummary` leaks any entity value.
- Decision rule from the dossier: if extraction quality is too weak on
  messy documents, the fallback concept is ReplyDesk (classification +
  short drafts tolerate a small model better). The human review step and
  confidence display are already product features, not patches.

## Spike 2 — Firebase project + App Check end-to-end
- DONE 12 Nov 2026: Firebase project created (Spark plan, no billing),
  web app registered, guided console flow "AI Services > AI Logic > Get
  started" completed with the Gemini Developer API provider. The web
  config lives ONLY in the local gitignored `js/firebase-config.js`,
  which `js/hybrid.js` imports once at startup (or reads via the preset
  `globalThis.__REDACTA_FIREBASE_CONFIG__`). NEVER paste the config into
  `js/hybrid.js` or any committed file — an earlier draft of this spike
  said exactly that, and following it would have committed the config.
- STILL OPEN: App Check has no provider registered, enforcement is
  Unenforced, and no debug token exists. Register the reCAPTCHA
  Enterprise provider, put the site key in the same gitignored file as
  `globalThis.__REDACTA_APP_CHECK_CONFIG__`, and on localhost run the
  debug-token flow (register the printed token in console: App Check >
  Apps > Manage debug tokens). A deployed demo needs a real attested
  domain — deploy target is a subdomain of an existing owned domain per
  house rules.
- Verify in the Firebase console that AI monitoring shows ONLY the cloud
  analysis requests, and that the scan produces zero Gemini API calls in
  the browser Network tab (dossier section 3, judge-verifiability checks).

## Spike 3 — Indonesia region check for the cloud lane
- The Gemini Developer API is region-gated server-side (unsupported
  locations fail with 400 FAILED_PROCONDITION). Mirrors of Google's
  official "Available regions for Google AI Studio and Gemini API" page
  checked on 2026-11-09 LIST Indonesia, so the cloud lane is provisionally
  OK from Indonesia. Re-verify on the official page at build time and with
  one real free-tier call from the deployed origin before relying on it.
- On-device inference has no region dependency; this spike gates only the
  PREFER_IN_CLOUD analysis lane. Documented fallback if a region failure
  ever appears: the Agent Platform (Vertex AI) provider, which requires
  billing.

## Spike 4 — Verifiability rehearsal (demo-critical)
- Rehearse the exact judge checks from dossier section 3 in the live
  build: `response.inferenceSource` values in the ledger, Network-tab
  silence during scan, `chrome://on-device-internals` showing the model,
  and the mid-demo airplane-mode flip (scan + redaction keep working,
  analysis degrades honestly).
- Record the demo video only after this rehearsal passes; the rules-check
  for the hackathon itself (official rules publish 2026-11-09 23:00 WIB)
  gates any build-out beyond this prototype.
