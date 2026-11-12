/* ============================================================================
   Redacta — hybrid.js
   Real Firebase AI Logic integration for #BuildHybridAI 2026.

   Two lanes, two opposite guarantees:

   SCAN LANE  (privacy-critical)
     getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE,
                              onDeviceParams: {...} })
     If Gemini Nano cannot run, the call THROWS. Redacta treats that throw as
     a hard stop for real data: it never silently re-routes a raw document to
     the cloud. That is the product promise, enforced by a mode constant.
     Note what is NOT here: the scan model has no inCloudParams at all. No
     cloud model is even configured for raw text, so there is no fallback
     for a bug to find.

   ANALYSIS LANE  (capability-critical)
     getGenerativeModel(ai, { mode: InferenceMode.PREFER_IN_CLOUD, ... })
     This model instance is only ever constructed FROM a RedactedArtefact
     (see analyseRedacted below). Its call signature accepts the artefact —
     { redactedText, documentType, entityStats } — and nothing else. There is
     no code path in this module that passes raw document text to it.

   Both lanes read result.response.inferenceSource and hand the normalised
   value (ON_DEVICE / IN_CLOUD) to the caller's ledger, so every claim the UI
   makes about where inference ran is backed by the SDK, not by our say-so.

   SDK surface verified 12 Nov 2026 against the official Firebase docs AND
   the published 13.0.0 bundle (www.gstatic.com/firebasejs/13.0.0/):
   - getAI(app, { backend: new GoogleAIBackend() }) — the Gemini Developer
     API provider. There is no `GeminiDevBackend` export; an earlier draft
     of this file used that name and it would have thrown at runtime.
   - model.initializeDeviceModel(progressCallback) exists in 13.0.0 and
     does NOT exist in 12.5.0, which is why the pinned version is 13.0.0.
   - response.inferenceSource values in the bundle are the lowercase enum
     values "on_device" / "in_cloud"; the docs prose writes ON_DEVICE /
     IN_CLOUD. normaliseSource() accepts both, so the ledger is stable
     across SDK versions.
   - A plain JSON schema object is accepted both as the cloud
     responseSchema and as the on-device responseConstraint (docs:
     "Generate structured output for hybrid experiences"). SCAN_SCHEMA is
     used as-is; it is NOT wrapped in Schema.object(), which expects
     Schema-helper instances, not a JSON schema.
   - initialPrompts entries use the documented parts form:
     { role: "system", content: [{ type: "text", value: "..." }] }.
   - LanguageModel.availability() is the documented way to report Nano
     state without starting a download (get-started guide, Step 1).

   When no Firebase config is present (this prototype), init() reports
   mode "simulation" and app.js drives js/sim.js instead, with the UI stating
   that plainly. Detection is honest: absence of config, absence of the SDK,
   or absence of Gemini Nano all surface as first-class states.
   ========================================================================== */

/* Paste the web config from Firebase console > Project settings after the
   guided "AI Services > AI Logic > Get started" flow enables the Gemini
   Developer API provider and App Check. null = prototype simulation mode. */
export const FIREBASE_CONFIG = null;

/* App Check is auto-enforced by the guided console setup. When a Firebase
   project is configured, fill this in: the reCAPTCHA Enterprise site key
   from the console, plus the debug token flow for localhost (see README and
   SPIKES.md Spike 2). null = App Check initialisation is skipped; against
   an enforced project, cloud calls will then fail with the real server
   error instead of failing silently. */
export const APP_CHECK_CONFIG = null;
// Example shape when configured:
// export const APP_CHECK_CONFIG = {
//   recaptchaEnterpriseSiteKey: "6L…",
//   debugToken: true, // localhost only: prints a debug token to register
//                     // in console > Security > App Check > Manage debug
//                     // tokens. Never enable on a deployed origin.
// };

/* 13.0.0: first version verified to expose model.initializeDeviceModel()
   (absent from the 12.5.0 bundle) and the gemini-3.5-flash-lite default
   cloud fallback. inferenceSource exists since 12.5.0. */
const SDK_VERSION = "13.0.0";
const CDN = (pkg) => `https://www.gstatic.com/firebasejs/${SDK_VERSION}/${pkg}`;

/* Plain JSON schema, used verbatim as the on-device responseConstraint.
   Mirrors data/schema.json (the documented shape; the file carries the
   descriptions, this copy carries the wire format). */
export const SCAN_SCHEMA = {
  type: "object",
  properties: {
    documentType: {
      type: "string",
      enum: ["contract", "payslip", "invoice", "medical_letter", "admin_letter", "other"],
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "PERSON_NAME", "NATIONAL_ID", "TAX_ID", "EMPLOYEE_ID",
              "MEDICAL_RECORD_ID", "INSURANCE_ID", "BANK_ACCOUNT", "EMAIL",
              "PHONE", "ADDRESS", "DATE_OF_BIRTH", "AMOUNT", "DATE",
              "REFERENCE_NO",
            ],
          },
          value: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          sensitivity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          redactByDefault: { type: "boolean" },
        },
        required: ["type", "value", "confidence", "sensitivity", "redactByDefault"],
      },
    },
    sensitivityScore: { type: "integer", minimum: 0, maximum: 100 },
    localSummary: { type: "string" },
  },
  required: ["documentType", "entities", "sensitivityScore", "localSummary"],
};

const SCAN_SYSTEM_PROMPT = [
  "You are the on-device redaction scanner inside Redacta.",
  "Extract every span of personal or sensitive data from the document.",
  "Return ONLY JSON matching the provided schema.",
  "localSummary must describe the document without repeating any entity value.",
].join(" ");

const state = {
  mode: "unknown", // "live" | "simulation"
  reason: "",
  appCheckWarning: "",
  app: null,
  ai: null,
  sdk: null,
  scanModel: null,
  analysisModel: null,
  deviceStatus: "unknown", // available | downloadable | downloading | unavailable
};

/** The SDK's InferenceSource enum values are lowercase; the docs write them
    uppercase. Accept both, emit one canonical form for the ledger. */
export function normaliseSource(value, fallback) {
  if (value === "ON_DEVICE" || value === "on_device") return "ON_DEVICE";
  if (value === "IN_CLOUD" || value === "in_cloud") return "IN_CLOUD";
  return fallback;
}

/** Initialise Firebase AI Logic if a config exists. Never throws. */
export async function initHybrid() {
  if (!FIREBASE_CONFIG) {
    state.mode = "simulation";
    state.reason = "No Firebase project configured yet — prototype simulation mode.";
    return { mode: state.mode, reason: state.reason };
  }
  try {
    const [appMod, aiMod] = await Promise.all([
      import(/* @vite-ignore */ CDN("firebase-app.js")),
      import(/* @vite-ignore */ CDN("firebase-ai.js")),
    ]);
    state.sdk = { appMod, aiMod };
    state.app = appMod.initializeApp(FIREBASE_CONFIG);
    // Gemini Developer API provider (free tier on Spark). App Check is
    // enforced by the guided console setup; initialise it when configured
    // so cloud calls carry an attestation token.
    if (APP_CHECK_CONFIG) {
      try {
        const appCheckMod = await import(/* @vite-ignore */ CDN("firebase-app-check.js"));
        if (APP_CHECK_CONFIG.debugToken) {
          // Localhost debug flow (docs Step 4): must be set BEFORE
          // initializeAppCheck. The printed token is registered in the
          // console under Security > App Check > Manage debug tokens.
          self.FIREBASE_APPCHECK_DEBUG_TOKEN = APP_CHECK_CONFIG.debugToken;
        }
        appCheckMod.initializeAppCheck(state.app, {
          provider: new appCheckMod.ReCaptchaEnterpriseProvider(
            APP_CHECK_CONFIG.recaptchaEnterpriseSiteKey
          ),
          isTokenAutoRefreshEnabled: true,
        });
      } catch (err) {
        state.appCheckWarning = `App Check could not be initialised: ${err.message}. Cloud calls may be rejected by the enforced project.`;
      }
    }
    state.ai = aiMod.getAI(state.app, { backend: new aiMod.GoogleAIBackend() });
    state.mode = "live";
    return { mode: state.mode, appCheckWarning: state.appCheckWarning };
  } catch (err) {
    state.mode = "simulation";
    state.reason = `Firebase AI Logic SDK unavailable: ${err.message}`;
    return { mode: state.mode, reason: state.reason };
  }
}

function buildModels() {
  const { getGenerativeModel, InferenceMode } = state.sdk.aiMod;

  /* SCAN LANE — ONLY_ON_DEVICE, on-device params only. Deliberately no
     inCloudParams: no cloud model is configured for raw document text, so
     a fallback cannot happen by accident, only by editing this call. */
  state.scanModel = getGenerativeModel(state.ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        initialPrompts: [{ role: "system", content: [{ type: "text", value: SCAN_SYSTEM_PROMPT }] }],
      },
      promptOptions: { responseConstraint: SCAN_SCHEMA },
    },
  });

  /* ANALYSIS LANE — PREFER_IN_CLOUD: strong reasoning when online, honest
     on-device degradation when offline (the SDK falls back on fetch
     errors). Both parameter bags configured, per the docs. Fed redacted
     text only (see analyseRedacted). */
  state.analysisModel = getGenerativeModel(state.ai, {
    mode: InferenceMode.PREFER_IN_CLOUD,
    inCloudParams: {
      model: "gemini-3.5-flash",
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
    },
  });
  return state;
}

/**
 * Report Gemini Nano availability without starting a download.
 * The documented check (get-started guide, Step 1): the Prompt API's own
 * LanguageModel.availability() → available | downloadable | downloading |
 * unavailable.
 */
export async function deviceModelStatus() {
  if (state.mode !== "live") {
    state.deviceStatus = "unavailable";
    return state.deviceStatus;
  }
  try {
    if (typeof LanguageModel !== "undefined" && LanguageModel.availability) {
      state.deviceStatus = await LanguageModel.availability();
    } else {
      state.deviceStatus = "unavailable";
    }
  } catch {
    state.deviceStatus = "unavailable";
  }
  return state.deviceStatus;
}

/**
 * Download/prepare the on-device model. MUST be called from a user
 * interaction (Chrome user-activation requirement) and before the first
 * on-device prompt. Progress is reported 0..1 via onProgress (the SDK
 * passes the download fraction through). Returns the availability state
 * observed afterwards.
 */
export async function prepareDeviceModel(onProgress) {
  if (state.mode !== "live") throw new Error("prepareDeviceModel: not in live mode");
  if (!state.scanModel) buildModels();
  state.deviceStatus = "downloading";
  await state.scanModel.initializeDeviceModel((progress) => {
    if (typeof onProgress === "function") onProgress(progress);
  });
  state.deviceStatus = await deviceModelStatus();
  return state.deviceStatus;
}

/**
 * SCAN LANE (live). Runs ONLY_ON_DEVICE; a throw means Nano could not run
 * and the caller must stop — not fall back. Returns the parsed schema JSON
 * plus the SDK-reported inferenceSource for the ledger.
 */
export async function scanOnDevice(rawText) {
  if (state.mode !== "live") throw new Error("scanOnDevice: not in live mode");
  if (!state.scanModel) buildModels();
  const started = performance.now();
  const result = await state.scanModel.generateContent(
    `Scan this document and extract all sensitive entities as JSON:\n\n${rawText}`
  );
  const latencyMs = Math.round(performance.now() - started);
  return {
    data: JSON.parse(result.response.text()),
    inferenceSource: normaliseSource(result.response.inferenceSource, "ON_DEVICE"),
    latencyMs,
  };
}

/**
 * ANALYSIS LANE (live) — THE REDACTION BOUNDARY.
 * The only input is a RedactedArtefact:
 *   { redactedText: string, documentType: string, entityStats: object }
 * Raw document text cannot reach this function without changing its
 * signature, and no other function in this module sends text to the cloud.
 */
export async function analyseRedacted(redactedArtefact) {
  if (state.mode !== "live") throw new Error("analyseRedacted: not in live mode");
  if (!redactedArtefact || typeof redactedArtefact.redactedText !== "string") {
    throw new TypeError("analyseRedacted requires a RedactedArtefact with redactedText");
  }
  if (!state.analysisModel) buildModels();
  const prompt = [
    "You are analysing a REDACTED document. Personal data has already been",
    "removed on the owner's device; tokens like [PERSON_NAME] are expected.",
    "Explain, in plain language: (1) what this document commits each side to,",
    "(2) clauses or terms that deserve a second look and why, (3) every dated",
    "obligation or deadline still visible in the text.",
    `Document type: ${redactedArtefact.documentType}`,
    `Redaction stats: ${JSON.stringify(redactedArtefact.entityStats)}`,
    "",
    redactedArtefact.redactedText,
  ].join("\n");
  const started = performance.now();
  const result = await state.analysisModel.generateContent(prompt);
  const latencyMs = Math.round(performance.now() - started);
  return {
    text: result.response.text(),
    inferenceSource: normaliseSource(result.response.inferenceSource, "IN_CLOUD"),
    latencyMs,
    payloadSent: prompt,
  };
}

export function hybridState() {
  return { ...state, scanModel: undefined, analysisModel: undefined, app: undefined, ai: undefined, sdk: undefined };
}
