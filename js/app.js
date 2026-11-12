/* Redacta — app.js: UI orchestration.
   Inference goes through js/hybrid.js when a Firebase project is configured;
   otherwise js/sim.js drives a clearly-labelled simulation of the same flow.
   The redaction boundary is structural: analysis only ever receives the
   RedactedArtefact built in buildArtefact(). */
import { initHybrid, deviceModelStatus, prepareDeviceModel, scanOnDevice, analyseRedacted, normaliseScanData } from "./hybrid.js";
import { simScan, simAnalyse, ENTITY_TYPES, wait } from "./sim.js";
import { buildRedactedText, auditArtefact, keptBytes } from "./redact.js";

const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/* Tween a displayed integer toward a new value (hero counters, score). */
function tweenNumber(el, to, suffix = "") {
  const from = parseInt(el.dataset.v ?? "0", 10) || 0;
  el.dataset.v = String(to);
  if (REDUCED || from === to) { el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 700;
  (function tick(t) {
    const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e) + suffix;
    if (p < 1 && parseInt(el.dataset.v, 10) === to) requestAnimationFrame(tick);
  })(t0);
}
const els = {
  modePill: $("modePill"), engineNote: $("engineNote"),
  modelStatusPill: $("modelStatusPill"), modelMeter: $("modelMeter"), modelMeterLabel: $("modelMeterLabel"),
  btnPrepare: $("btnPrepare"), docInput: $("docInput"), charCount: $("charCount"), sampleError: $("sampleError"),
  btnScan: $("btnScan"), docView: $("docView"), scanSweep: $("scanSweep"), scanSourceTag: $("scanSourceTag"),
  payloadBox: $("payloadBox"),
  scoreNum: $("scoreNum"), localSummary: $("localSummary"), entityList: $("entityList"),
  btnDefaults: $("btnDefaults"), btnKeepAll: $("btnKeepAll"),
  redactedView: $("redactedView"), btnCopyRedacted: $("btnCopyRedacted"),
  payloadLen: $("payloadLen"), payloadHash: $("payloadHash"), payloadPii: $("payloadPii"), netNote: $("netNote"),
  btnAnalyse: $("btnAnalyse"), analysisOut: $("analysisOut"),
  ledgerBody: $("ledgerBody"), ledgerStats: $("ledgerStats"), ledgerRawBytes: $("ledgerRawBytes"),
  statRawBytes: $("statRawBytes"), statOnDevice: $("statOnDevice"), statSpans: $("statSpans"),
  btnExportRedacted: $("btnExportRedacted"), btnExportReport: $("btnExportReport"),
};

const S = {
  engine: "simulation",
  engineReason: "",
  modelStatus: "unknown",
  sampleId: null,
  scan: null,          // { documentType, entities[], sensitivityScore, localSummary }
  analysis: null,
  ledger: [],
  totalSpansFound: 0,
  rawBytesSent: 0,     // kept-span bytes actually handed to the live analysis lane
};

/* ---------------- hashing ---------------- */
async function fingerprint(text) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16) + "…";
  } catch {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return "fnv1a:" + h.toString(16).padStart(8, "0");
  }
}
const byteLen = (t) => new TextEncoder().encode(t).length;
const esc = (t) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- ledger ---------------- */
async function logLedger(step, source, mode, latencyMs, payloadText) {
  const entry = {
    time: new Date().toLocaleTimeString("en-GB"),
    step, source, mode,
    simulated: S.engine !== "live",
    latencyMs,
    payloadBytes: payloadText ? byteLen(payloadText) : 0,
    hash: payloadText ? await fingerprint(payloadText) : "—",
  };
  S.ledger.push(entry);
  renderLedger();
  return entry;
}
function renderLedger() {
  if (!S.ledger.length) return;
  /* Newest entry first: it slides in at the top with its lane colour. */
  els.ledgerBody.innerHTML = [...S.ledger].reverse().map((e, i) => `<tr${i === 0 ? ` class="row-new" style="--row-lane:${e.source === "ON_DEVICE" ? "var(--green)" : "var(--sky)"}"` : ""}>
    <td class="mono">${e.time}</td><td>${esc(e.step)}</td>
    <td><span class="src ${e.source === "ON_DEVICE" ? "src-device" : "src-cloud"}">${e.source.replace("_", "-")}</span>${e.simulated ? ' <span class="src src-sim">SIM</span>' : ""}</td>
    <td class="mono">${esc(e.mode)}</td><td class="mono">${e.latencyMs} ms</td>
    <td class="mono">${e.payloadBytes.toLocaleString()} B</td><td class="fp">${e.hash}</td></tr>`).join("");
  const onDev = S.ledger.filter((e) => e.source === "ON_DEVICE").length;
  const inCloud = S.ledger.filter((e) => e.source === "IN_CLOUD").length;
  els.ledgerStats.textContent = `${S.ledger.length} entries · ${onDev} on-device · ${inCloud} in-cloud`;
  const total = onDev + inCloud;
  if (total) tweenNumber(els.statOnDevice, Math.round((onDev / total) * 100), "%");
}

/* ---------------- model status ---------------- */
function setModelStatus(status, label) {
  S.modelStatus = status;
  els.modelStatusPill.textContent = status + (S.engine !== "live" ? " · simulated" : "");
  els.modelStatusPill.className = "status-pill st-" + status;
  if (label) els.modelMeterLabel.textContent = label;
  els.modelMeter.style.width = status === "available" ? "100%" : status === "downloading" ? els.modelMeter.style.width : "0%";
}
async function onPrepare() {
  els.btnPrepare.disabled = true;
  let prepared = false;
  if (S.engine === "live") {
    try {
      setModelStatus("downloading", "Downloading Gemini Nano…");
      const status = await prepareDeviceModel((p) => { els.modelMeter.style.width = `${Math.round(p * 100)}%`; });
      setModelStatus(status, status === "available" ? "Gemini Nano is ready on this device." : `Gemini Nano reports: ${status}.`);
      prepared = status === "available";
    } catch (err) {
      setModelStatus("unavailable", `On-device model could not be prepared: ${err.message}`);
    }
    if (!prepared) {
      // A failed prepare must not be logged as a success or labelled ready:
      // the ledger entry and the button text below are only for a model
      // that actually prepared. Re-enable so the user can retry.
      els.btnPrepare.disabled = false;
      return;
    }
  } else {
    setModelStatus("downloading", "Simulated download of Gemini Nano (multi-GB model, managed by Chrome)…");
    els.modelMeter.classList.add("shimmer");
    for (let p = 0; p <= 100; p += 10) { els.modelMeter.style.width = p + "%"; els.modelMeterLabel.textContent = `Simulated download… ${p}%`; await wait(110); }
    els.modelMeter.classList.remove("shimmer");
    setModelStatus("available", "Simulated state: Gemini Nano ready. Scans below run in simulation and are labelled SIM in the ledger.");
    prepared = true;
  }
  if (!prepared) return;
  await logLedger("On-device model prepared", "ON_DEVICE", "ONLY_ON_DEVICE", 0, "");
  els.btnPrepare.textContent = "On-device model ready";
}

/* ---------------- document input ---------------- */
async function loadSample(id, btn) {
  let res;
  try {
    res = await fetch(`data/samples/${id}.txt`);
  } catch (err) {
    showSampleError(`Could not load the sample document (${err.message}). Check the connection and try again.`);
    return;
  }
  if (!res.ok) {
    // Never pour an error page into the editor as if it were a document:
    // a 404 body once loaded here as the "medical" sample. Leave the
    // current text, sample id and chip state untouched.
    showSampleError(`Could not load the sample document (HTTP ${res.status}). The current text is untouched.`);
    return;
  }
  els.sampleError.hidden = true;
  document.querySelectorAll(".chip-sample").forEach((c) => c.classList.toggle("active", c === btn));
  els.docInput.value = await res.text();
  S.sampleId = id;
  onInputChanged();
}
function showSampleError(msg) {
  els.sampleError.textContent = msg;
  els.sampleError.hidden = false;
}
/* A scan's span offsets belong to the exact text that was scanned. Once
   the document changes, the scan, the artefact and the analysis are stale
   and must not be reused: re-applying old offsets to new text misplaces
   every highlight and can leave PII unredacted in the artefact. */
function invalidateScan() {
  if (!S.scan && !S.artefact) return;
  S.scan = null; S.artefact = null; S.analysis = null;
  els.docView.innerHTML = '<p class="doc-placeholder">Your document will appear here with every sensitive span highlighted in place, exactly where the scanner found it.</p>';
  els.scanSourceTag.textContent = "awaiting scan";
  els.scanSourceTag.className = "lane-tag lane-device";
  els.entityList.innerHTML = '<p class="fineprint">No entities yet.</p>';
  els.scoreNum.textContent = "—";
  els.scoreNum.parentElement.className = "score-big";
  els.localSummary.textContent = "Run a scan to see the on-device summary and the redaction plan. You stay in control: every span can be kept or redacted individually before anything leaves this page.";
  els.redactedView.textContent = "The exact text a cloud model is allowed to see will appear here — nothing more, nothing hidden.";
  els.payloadLen.textContent = "—";
  els.payloadHash.textContent = "—";
  els.payloadPii.textContent = "—";
  els.payloadPii.style.color = "";
  els.analysisOut.innerHTML = '<p class="fineprint">Analysis will appear here after the redacted document is sent.</p>';
  els.btnCopyRedacted.disabled = true;
  els.btnAnalyse.disabled = true;
  els.btnExportRedacted.disabled = true;
  els.btnExportReport.disabled = true;
}
function onInputChanged() {
  const n = els.docInput.value.length;
  els.charCount.textContent = `${n.toLocaleString()} characters`;
  els.btnScan.disabled = n === 0;
  invalidateScan();
}
els.docInput.addEventListener("input", () => { S.sampleId = null; els.sampleError.hidden = true; document.querySelectorAll(".chip-sample").forEach((c) => c.classList.remove("active")); onInputChanged(); });
document.querySelectorAll(".chip-sample").forEach((b) => b.addEventListener("click", () => loadSample(b.dataset.sample, b)));

/* ---------------- scan ---------------- */
async function onScan() {
  const text = els.docInput.value;
  if (!text.trim()) return;
  els.btnScan.disabled = true; els.btnScan.textContent = "Scanning on-device…";
  els.btnScan.classList.add("busy"); els.scanSweep.classList.add("on");
  const t0 = performance.now();
  let result = null, liveSource = null;
  if (S.engine === "live") {
    try {
      const r = await scanOnDevice(text);
      liveSource = r.inferenceSource;
      result = normaliseScanData(r.data, text);
    } catch (err) {
      /* Two honest failures, told apart: an ONLY_ON_DEVICE refusal (Nano
         could not run — the guarantee working as designed) versus a
         malformed model reply (BAD_SCAN_OUTPUT). Conflating them would
         misreport a parse failure as a refusal. */
      const badOutput = err.code === "BAD_SCAN_OUTPUT";
      els.scanSourceTag.textContent = badOutput ? "scan failed — model output unparsable" : "scan refused — on-device unavailable";
      els.scanSourceTag.className = "lane-tag lane-sim";
      els.localSummary.textContent = badOutput
        ? `The on-device model replied with output Redacta could not parse (${err.message}). Nothing was sent to the cloud. Try the scan again.`
        : `The on-device model could not run (${err.message}). Redacta will not send a raw document to the cloud as a fallback, so the scan stopped here.`;
      els.btnScan.disabled = false; els.btnScan.textContent = "Scan on-device";
      els.btnScan.classList.remove("busy"); els.scanSweep.classList.remove("on");
      return;
    }
  } else {
    result = simScan(text, S.sampleId);
    await wait(Math.min(result.simulatedLatencyMs, 1400));
  }
  const latency = Math.round(performance.now() - t0);
  result.entities.forEach((e) => { e.redact = e.redactByDefault; });
  S.scan = result;
  S.totalSpansFound = result.entities.length;
  tweenNumber(els.statSpans, result.entities.length);
  /* In live mode the ledger records the SDK-reported inferenceSource, not
     an assumed value; in simulation the row carries the SIM tag. */
  await logLedger("Document scan — entity extraction", S.engine === "live" ? (liveSource ?? "ON_DEVICE") : "ON_DEVICE", "ONLY_ON_DEVICE", latency, text);
  els.btnScan.classList.remove("busy"); els.scanSweep.classList.remove("on");
  renderScan(text, true);
  els.btnScan.disabled = false; els.btnScan.textContent = "Scan on-device";
}
function renderScan(text, animate = false) {
  const { entities, sensitivityScore, localSummary } = S.scan;
  /* highlighted document */
  const lastIdx = entities.length - 1;
  let html = "", last = 0;
  entities.forEach((e, i) => {
    if (e.start < last) return;
    html += esc(text.slice(last, e.start));
    html += `<mark class="ent sev-${e.sensitivity}${e.redact ? "" : " kept"}${animate ? " arrive" : ""}${animate && i === lastIdx ? " newest" : ""}"${animate ? ` style="--d:${Math.min(i * 90, 1600)}ms"` : ""} data-eid="${e.id}" title="${esc(ENTITY_TYPES[e.type]?.label ?? e.type)} · ${Math.round(e.confidence * 100)}% confidence">${esc(e.value)}</mark>`;
    last = e.end;
  });
  html += esc(text.slice(last));
  els.docView.innerHTML = html;
  els.scanSourceTag.textContent = S.engine === "live" ? "served on-device · inferenceSource verified" : "simulated on-device scan";
  els.scanSourceTag.className = "lane-tag " + (S.engine === "live" ? "lane-device" : "lane-sim");
  /* score + summary */
  tweenNumber(els.scoreNum, sensitivityScore);
  els.scoreNum.parentElement.className = "score-big" + (sensitivityScore >= 70 ? " hot" : sensitivityScore >= 40 ? " warm" : "");
  els.localSummary.textContent = localSummary + " Generated on-device; it names no entity values.";
  /* entity list */
  els.entityList.innerHTML = entities.length ? entities.map((e) => `
    <div class="ent-row${e.redact ? "" : " off"}" data-eid="${e.id}">
      <span class="ent-type sev-${e.sensitivity}">${esc(ENTITY_TYPES[e.type]?.label ?? e.type)}</span>
      <span class="ent-val" title="${esc(e.value)}">${esc(e.value)}</span>
      <span class="ent-conf">${Math.round(e.confidence * 100)}%</span>
      <label class="switch" title="Redact this span"><input type="checkbox" data-toggle="${e.id}" ${e.redact ? "checked" : ""}><span class="track"></span></label>
    </div>`).join("") : '<p class="fineprint">No sensitive spans found in this document.</p>';
  els.entityList.querySelectorAll("[data-toggle]").forEach((cb) => cb.addEventListener("change", () => {
    const e = S.scan.entities.find((x) => x.id === cb.dataset.toggle);
    if (e) {
      e.redact = cb.checked;
      const row = cb.closest(".ent-row");
      if (row && !REDUCED) { row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash"); }
      renderScan(els.docInput.value); // renderScan rebuilds the redaction too
    }
  }));
  refreshRedaction();
}

/* ---------------- redaction + artefact ---------------- */
/* THE artefact: the only object the analysis lane may receive. */
function buildArtefact() {
  const redacted = S.scan.entities.filter((e) => e.redact);
  return {
    redactedText: buildRedactedText(els.docInput.value, S.scan.entities),
    documentType: S.scan.documentType,
    entityStats: {
      total: redacted.length,
      critical: redacted.filter((e) => e.sensitivity === "critical").length,
      high: redacted.filter((e) => e.sensitivity === "high").length,
      medium: redacted.filter((e) => e.sensitivity === "medium").length,
      low: redacted.filter((e) => e.sensitivity === "low").length,
    },
  };
}
async function refreshRedaction() {
  if (!S.scan) return;
  const artefact = buildArtefact();
  S.artefact = artefact;
  const changed = els.redactedView.textContent !== artefact.redactedText;
  els.redactedView.textContent = artefact.redactedText;
  if (changed && !REDUCED) { els.redactedView.classList.remove("settle"); void els.redactedView.offsetWidth; els.redactedView.classList.add("settle"); }
  els.btnCopyRedacted.disabled = false;
  els.btnAnalyse.disabled = false;
  els.btnExportRedacted.disabled = false;
  els.payloadLen.textContent = `${artefact.redactedText.length.toLocaleString()} chars · ${byteLen(artefact.redactedText).toLocaleString()} bytes`;
  els.payloadHash.textContent = await fingerprint(artefact.redactedText);
  /* Honest payload check: a leak (redacted value still present) is a
     failure; a kept span is the user's choice — but it IS verbatim raw
     text in the payload, so it must be reported, never answered "No". */
  const { leaked, kept } = auditArtefact(artefact.redactedText, S.scan.entities);
  if (leaked.length > 0) {
    els.payloadPii.textContent = `WARNING: ${leaked.length} redacted span(s) still present`;
    els.payloadPii.style.color = "var(--red)";
  } else if (kept.length > 0) {
    els.payloadPii.textContent = `Yes — ${kept.length} kept span(s) remain in the payload (your choice)`;
    els.payloadPii.style.color = "var(--orange)";
  } else {
    els.payloadPii.textContent = "No — verified against every redacted span";
    els.payloadPii.style.color = "var(--green2)";
  }
}

/* ---------------- analysis ---------------- */
async function onAnalyse() {
  if (!S.artefact) return;
  els.btnAnalyse.disabled = true; els.btnAnalyse.textContent = "Analysing…";
  /* The send moment: only the redacted payload leaves — the card lifts,
     glows sky (cloud lane colour), and the payload rows reveal in sequence. */
  const analysisCard = els.payloadBox.closest(".card");
  if (!REDUCED) {
    els.payloadBox.classList.remove("sending"); analysisCard.classList.remove("sending");
    void els.payloadBox.offsetWidth;
    els.payloadBox.classList.add("sending"); analysisCard.classList.add("sending");
    setTimeout(() => { els.payloadBox.classList.remove("sending"); analysisCard.classList.remove("sending"); }, 1900);
  }
  const t0 = performance.now();
  let out, source = "IN_CLOUD";
  try {
    if (S.engine === "live") {
      const r = await analyseRedacted(S.artefact); // hybrid.js: redacted artefact only
      out = { summary: r.text, watchOuts: [], obligations: [], redactionNote: "" };
      source = r.inferenceSource;
    } else {
      out = simAnalyse(S.artefact);
      await wait(Math.min(out.simulatedLatencyMs, 1600));
    }
  } catch (err) {
    /* A failed analysis must say so and free the button — the old code let
       the rejection escape, leaving the button disabled on "Analysing…"
       forever with no error shown. No ledger row: nothing was served. */
    els.analysisOut.innerHTML = `<p class="fineprint">Analysis failed: ${esc(err.message)} The redacted document above is unchanged; try again.</p>`;
    els.btnAnalyse.disabled = false; els.btnAnalyse.textContent = "Analyse redacted document";
    return;
  }
  const latency = Math.round(performance.now() - t0);
  S.analysis = out;
  if (S.engine === "live" && S.scan) {
    // The "raw bytes sent" counters are computed, not hardcoded: kept
    // spans are verbatim raw text inside the payload the lane received.
    // (Simulation sends nothing over the network, so it adds nothing.)
    S.rawBytesSent += keptBytes(S.artefact.redactedText, S.scan.entities);
    els.statRawBytes.textContent = S.rawBytesSent.toLocaleString();
    els.ledgerRawBytes.textContent = S.rawBytesSent.toLocaleString();
  }
  await logLedger("Deep analysis of redacted document", source === "ON_DEVICE" ? "ON_DEVICE" : "IN_CLOUD", "PREFER_IN_CLOUD", latency, S.artefact.redactedText);
  els.analysisOut.innerHTML = `
    <div class="analysis-block"><h3>What this document is</h3><p>${esc(out.summary)}</p></div>
    ${out.watchOuts.length ? `<div class="analysis-block"><h3>Worth a second look</h3><ul>${out.watchOuts.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
    ${out.obligations.length ? `<div class="analysis-block"><h3>Dated obligations in the text</h3><ul>${out.obligations.map((o) => `<li>${esc(o)}</li>`).join("")}</ul></div>` : ""}
    ${out.redactionNote ? `<div class="analysis-block"><h3>Redaction note</h3><p>${esc(out.redactionNote)}</p></div>` : ""}
    <p class="fineprint">${S.engine === "live" ? "Served per the SDK's own inferenceSource, recorded in the ledger." : "Simulated cloud analysis (SIM in the ledger). It received the redacted artefact only — the same boundary the live lane enforces."}</p>`;
  els.btnExportReport.disabled = false;
  els.btnAnalyse.disabled = false; els.btnAnalyse.textContent = "Analyse redacted document";
}

/* ---------------- misc actions ---------------- */
els.btnPrepare.addEventListener("click", onPrepare);
els.btnScan.addEventListener("click", onScan);
els.btnAnalyse.addEventListener("click", onAnalyse);
els.btnDefaults.addEventListener("click", () => { if (!S.scan) return; S.scan.entities.forEach((e) => { e.redact = e.redactByDefault; }); renderScan(els.docInput.value); });
els.btnKeepAll.addEventListener("click", () => { if (!S.scan) return; S.scan.entities.forEach((e) => { e.redact = false; }); renderScan(els.docInput.value); });
els.btnCopyRedacted.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(els.redactedView.textContent); els.btnCopyRedacted.textContent = "Copied"; setTimeout(() => (els.btnCopyRedacted.textContent = "Copy"), 1400); } catch { /* clipboard unavailable */ }
});
function download(name, content, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
els.btnExportRedacted.addEventListener("click", () => { if (S.artefact) download("redacta-redacted-document.txt", S.artefact.redactedText); });
els.btnExportReport.addEventListener("click", () => {
  const rows = S.ledger.map((e) => `| ${e.time} | ${e.step} | ${e.source}${e.simulated ? " (SIM)" : ""} | ${e.mode} | ${e.latencyMs} ms | ${e.payloadBytes} B | ${e.hash} |`).join("\n");
  const md = `# Redacta session report\n\nDocument type: ${S.scan?.documentType ?? "—"} · Sensitivity score: ${S.scan?.sensitivityScore ?? "—"}/100 · Spans found: ${S.scan?.entities.length ?? 0}\n\n## Redacted document\n\n\`\`\`\n${S.artefact?.redactedText ?? ""}\n\`\`\`\n\n## Analysis\n\n${S.analysis ? `${S.analysis.summary}\n\nWatch-outs:\n${(S.analysis.watchOuts ?? []).map((w) => `- ${w}`).join("\n")}\n\nObligations:\n${(S.analysis.obligations ?? []).map((o) => `- ${o}`).join("\n")}` : "No analysis run."}\n\n## Privacy ledger\n\n| Time | Step | Source | Mode | Latency | Payload | Fingerprint |\n|---|---|---|---|---|---|---|\n${rows}\n\nRaw document bytes sent to the cloud in this session: ${S.rawBytesSent}${S.engine === "live" ? "" : " (simulation: no network calls were made)"}.\n`;
  download("redacta-session-report.md", md, "text/markdown");
});

/* ---------------- connectivity ----------------
   Offline is a first-class state, not a silent failure. The scan lane
   never needs the network. The analysis lane (PREFER_IN_CLOUD) falls back
   to the on-device model when a fetch fails, and the ledger records
   whichever engine actually answered. */
function updateNetNote() {
  const offline = !navigator.onLine;
  els.netNote.hidden = !offline;
  if (offline) {
    els.netNote.textContent = S.engine === "live"
      ? "You are offline. The cloud lane is unreachable, so this step will fall back to the on-device model if Nano can run it — the ledger will record ON_DEVICE for it. The scan and redaction above never needed the network."
      : "You are offline. The simulated analysis below still runs locally, exactly as the live lane would degrade: scan and redaction never needed the network, and the ledger records where each step ran.";
  }
}
window.addEventListener("online", updateNetNote);
window.addEventListener("offline", updateNetNote);

/* ---------------- reveal ---------------- */
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add("in"); }), { threshold: 0.08 });
document.querySelectorAll(".rv").forEach((el) => io.observe(el));

/* ---------------- init ---------------- */
(async function init() {
  const params = new URLSearchParams(location.search);
  const shot = params.has("shot");
  const demo = params.has("demo");
  if (shot) document.body.classList.add("shot");
  const res = await initHybrid();
  S.engine = res.mode;
  updateNetNote();
  if (res.mode === "live") {
    els.modePill.textContent = "LIVE · FIREBASE AI LOGIC";
    els.modePill.className = "pill pill-live";
    els.engineNote.textContent = "Firebase AI Logic connected. Scan lane is ONLY_ON_DEVICE; analysis receives redacted text only." + (res.appCheckWarning ? " " + res.appCheckWarning : "");
    setModelStatus(await deviceModelStatus(), "Gemini Nano state reported by Chrome.");
  } else {
    els.engineNote.textContent = res.reason + " The full flow below is functional; every simulated inference is labelled SIM in the privacy ledger.";
    setModelStatus("downloadable", "Gemini Nano can be prepared on a qualifying Chrome desktop. In this prototype the preparation is simulated.");
  }
  if (shot) {
    /* Deterministic screenshot mode: populate the whole flow. */
    await onPrepare();
    const btn = document.querySelector('[data-sample="contract"]');
    await loadSample("contract", btn);
    await onScan();
    await onAnalyse();
    window.scrollTo(0, 0);
  }
  if (demo) {
    /* Animated auto-flow for the motion-preview capture: same flow as
       ?shot=1, but animations stay on and the view follows the action. */
    const follow = (sel) => document.querySelector(sel)?.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
    await wait(900);
    await onPrepare();
    const btn = document.querySelector('[data-sample="contract"]');
    await loadSample("contract", btn);
    follow(".card-input"); await wait(600);
    await onScan();
    follow(".card-doc"); await wait(1500);
    follow(".card-redacted"); await wait(900);
    follow(".card-analysis"); await onAnalyse();
    await wait(700);
    follow(".card-ledger"); await wait(1200);
    window.__demoDone = true;
  }
})();
