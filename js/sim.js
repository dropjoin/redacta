/* ============================================================================
   Redacta — sim.js
   SIMULATED inference engine for the prototype.

   Everything in this file is a stand-in for Gemini Nano / cloud Gemini and is
   labelled SIMULATED in the UI and in every ledger entry it produces. It
   exists so the full product flow — scan, highlight, redact, analyse, ledger,
   export — can be exercised and judged before a real Chrome desktop with
   Gemini Nano and a configured Firebase project are wired in (see SPIKES.md).

   Extraction here is pattern-based: curated span definitions for the three
   bundled sample documents (their text is fixed, so spans are exact), plus
   generic regex extractors for pasted text. A real Nano scan returns the
   same shape (data/schema.json) with model judgement instead of patterns.
   ========================================================================== */

export const ENTITY_TYPES = {
  PERSON_NAME:       { label: "Person name",      token: "[PERSON_NAME]",       sensitivity: "high" },
  NATIONAL_ID:       { label: "National ID",      token: "[NATIONAL_ID]",       sensitivity: "critical" },
  TAX_ID:            { label: "Tax ID",           token: "[TAX_ID]",            sensitivity: "high" },
  EMPLOYEE_ID:       { label: "Employee ID",      token: "[EMPLOYEE_ID]",       sensitivity: "high" },
  MEDICAL_RECORD_ID: { label: "Medical record",   token: "[MEDICAL_RECORD_ID]", sensitivity: "critical" },
  INSURANCE_ID:      { label: "Insurance ID",     token: "[INSURANCE_ID]",      sensitivity: "high" },
  BANK_ACCOUNT:      { label: "Bank account",     token: "[BANK_ACCOUNT]",      sensitivity: "critical" },
  EMAIL:             { label: "Email",            token: "[EMAIL]",             sensitivity: "medium" },
  PHONE:             { label: "Phone",            token: "[PHONE]",             sensitivity: "high" },
  ADDRESS:           { label: "Address",          token: "[ADDRESS]",           sensitivity: "high" },
  DATE_OF_BIRTH:     { label: "Date of birth",    token: "[DATE_OF_BIRTH]",     sensitivity: "critical" },
  AMOUNT:            { label: "Amount",           token: "[AMOUNT]",            sensitivity: "low" },
  DATE:              { label: "Date",             token: "[DATE]",              sensitivity: "low" },
  REFERENCE_NO:      { label: "Reference no.",    token: "[REFERENCE_NO]",      sensitivity: "medium" },
};

const SEV_WEIGHT = { critical: 22, high: 12, medium: 6, low: 2 };

/* ---- Curated spans for the bundled samples (values match the .txt files
        byte-for-byte; every occurrence in the text is extracted) ---------- */
const CURATED = {
  contract: [
    ["AGR/2026/XI/0147", "REFERENCE_NO", "medium", 0.99],
    ["Dewi Anggraini", "PERSON_NAME", "high", 0.97],
    ["Rizky Pratama", "PERSON_NAME", "high", 0.98],
    ["3275011208940003", "NATIONAL_ID", "critical", 0.99],
    ["74.221.905.4-411.000", "TAX_ID", "high", 0.96],
    ["731-044-8821", "BANK_ACCOUNT", "critical", 0.95],
    ["dewi.anggraini@nusantararetail.co.id", "EMAIL", "medium", 0.99],
    ["rizky.pratama88@gmail.com", "EMAIL", "high", 0.99],
    ["+62 812-9045-2217", "PHONE", "high", 0.98],
    ["+62 857-3310-8842", "PHONE", "high", 0.98],
    ["Jl. Sudirman Kav. 52-53, Jakarta Selatan 12190", "ADDRESS", "medium", 0.9],
    ["Jl. Melati No. 8, RT 04/RW 02, Depok, Jawa Barat 16411", "ADDRESS", "high", 0.93],
    ["Rp 48.500.000", "AMOUNT", "low", 0.99],
    ["Rp 24.250.000", "AMOUNT", "low", 0.99],
    ["3 November 2026", "DATE", "low", 0.98],
    ["10 November 2026", "DATE", "low", 0.98],
    ["28 February 2027", "DATE", "low", 0.98],
  ],
  payslip: [
    ["Sari Wulandari", "PERSON_NAME", "high", 0.98],
    ["EMP-2019-0457", "EMPLOYEE_ID", "high", 0.97],
    ["3171055703910002", "NATIONAL_ID", "critical", 0.99],
    ["88.104.332.7-015.000", "TAX_ID", "high", 0.96],
    ["137-00-2219045-6", "BANK_ACCOUNT", "critical", 0.96],
    ["0002219045571", "INSURANCE_ID", "high", 0.9],
    ["19045722108", "INSURANCE_ID", "high", 0.88],
    ["Jl. Cempaka Putih Tengah No. 21, Jakarta Pusat 10510", "ADDRESS", "high", 0.93],
    ["payroll@cakratek.co.id", "EMAIL", "low", 0.99],
    ["Rp 23.690.000", "AMOUNT", "low", 0.99],
    ["Rp 21.253.000", "AMOUNT", "low", 0.99],
    ["Rp 2.437.000", "AMOUNT", "low", 0.97],
    ["31 October 2026", "DATE", "low", 0.98],
  ],
  medical: [
    ["RM/REF/2026/11882", "REFERENCE_NO", "medium", 0.99],
    ["Bambang Sutrisno", "PERSON_NAME", "high", 0.97],
    ["Maya Kusuma", "PERSON_NAME", "high", 0.95],
    ["Andi Firmansyah", "PERSON_NAME", "high", 0.95],
    ["Ratna Sutrisno", "PERSON_NAME", "high", 0.94],
    ["14 March 1968", "DATE_OF_BIRTH", "critical", 0.98],
    ["MR-2018-009314", "MEDICAL_RECORD_ID", "critical", 0.99],
    ["3374021403680001", "NATIONAL_ID", "critical", 0.99],
    ["0001093148872", "INSURANCE_ID", "high", 0.9],
    ["+62 813-2877-4109", "PHONE", "high", 0.98],
    ["+62 822-6510-9934", "PHONE", "high", 0.98],
    ["Jl. Kenanga No. 3, Semarang, Jawa Tengah 50241", "ADDRESS", "high", 0.93],
    ["5 November 2026", "DATE", "low", 0.98],
    ["28 October 2026", "DATE", "low", 0.97],
    ["12 October 2026", "DATE", "low", 0.97],
    ["20 November 2026", "DATE", "low", 0.98],
  ],
};

const SUMMARIES = {
  contract: "A freelance services agreement between a company and an individual freelancer, covering scope, fees in two instalments, a fixed term, termination, confidentiality and liability terms.",
  payslip: "A monthly payslip for one employee, listing earnings, statutory deductions and net pay for a single pay period, marked confidential by the employer.",
  medical_letter: "A hospital referral letter for one patient, covering a specialist referral, a clinical summary with diagnoses and medication, and a requested follow-up date.",
  other: "A document containing personal or sensitive data. Review each highlighted span before sharing it anywhere.",
};

/* Sample ids are file names, not schema values: the schema enum
   (data/schema.json) says "medical_letter", not "medical". The scan result
   must carry a schema-valid documentType, so sample ids are mapped here. */
const SAMPLE_DOC_TYPES = { contract: "contract", payslip: "payslip", medical: "medical_letter" };

function spansFromCurated(text, defs) {
  const out = [];
  for (const [value, type, sensitivity, confidence] of defs) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(value, from);
      if (i < 0) break;
      out.push({ value, type, sensitivity, confidence, start: i, end: i + value.length });
      from = i + value.length;
    }
  }
  return out;
}

const GENERIC = [
  { type: "EMAIL", sensitivity: "medium", confidence: 0.97, re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { type: "NATIONAL_ID", sensitivity: "critical", confidence: 0.9, re: /\b\d{16}\b/g },
  { type: "PHONE", sensitivity: "high", confidence: 0.92, re: /(\+62|0)[\s-]?\d{3,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/g },
  { type: "BANK_ACCOUNT", sensitivity: "critical", confidence: 0.8, re: /\b\d{3}-\d{2,4}-\d{3,7}(-\d)?\b/g },
  { type: "AMOUNT", sensitivity: "low", confidence: 0.95, re: /(Rp|IDR|USD|\$)\s?[\d.,]+/g },
  { type: "DATE", sensitivity: "low", confidence: 0.9, re: /\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g },
  { type: "DATE", sensitivity: "low", confidence: 0.85, re: /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/g },
];

function spansFromGeneric(text) {
  const raw = [];
  for (const g of GENERIC) {
    for (const m of text.matchAll(g.re)) {
      raw.push({ value: m[0], type: g.type, sensitivity: g.sensitivity, confidence: g.confidence, start: m.index, end: m.index + m[0].length });
    }
  }
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const s of raw) { if (s.start >= lastEnd) { out.push(s); lastEnd = s.end; } }
  return out;
}

function guessDocType(text) {
  const t = text.toLowerCase();
  if (t.includes("payslip") || t.includes("net pay")) return "payslip";
  if (t.includes("referral") || t.includes("patient")) return "medical_letter";
  if (t.includes("invoice")) return "invoice";
  if (t.includes("agreement")) return "contract";
  return "other";
}

export function sensitivityScore(entities) {
  let s = 0;
  for (const e of entities) s += SEV_WEIGHT[e.sensitivity] ?? 2;
  return Math.min(100, Math.round(s * 0.92));
}

/**
 * SIMULATED on-device scan. Returns the schema shape (data/schema.json).
 * `sampleId` selects curated spans for the bundled documents.
 */
export function simScan(text, sampleId) {
  const entities = (sampleId && CURATED[sampleId])
    ? spansFromCurated(text, CURATED[sampleId])
    : spansFromGeneric(text);
  entities.sort((a, b) => a.start - b.start);
  entities.forEach((e, i) => {
    e.id = `e${i + 1}`;
    e.redactByDefault = e.sensitivity === "critical" || e.sensitivity === "high";
  });
  const documentType = sampleId ? (SAMPLE_DOC_TYPES[sampleId] ?? guessDocType(text)) : guessDocType(text);
  return {
    documentType,
    entities,
    sensitivityScore: sensitivityScore(entities),
    localSummary: SUMMARIES[documentType] ?? SUMMARIES.other,
    simulatedLatencyMs: 380 + Math.round(text.length / 9) + entities.length * 26,
  };
}

/* ---- SIMULATED cloud analysis. Accepts ONLY a RedactedArtefact, exactly
        like the live lane in hybrid.js: { redactedText, documentType,
        entityStats }. It cannot see raw text because it is never given it. - */
const WATCH_RULES = [
  { re: /perpetuity|without limit/i, text: "Rights granted over delivered work are unlimited in time and scope. That is broader than a standard engagement and worth confirming before signing." },
  { re: /kill fee of (\d+%)/i, text: "A kill fee applies if the client ends the work early. Check the percentage against the unpaid balance it is meant to cover." },
  { re: /surcharge of ([\d.,%]+)/i, text: "A late-payment surcharge is defined. Confirm how it compounds and when it starts to apply." },
  { re: /terminate with (\d+) days/i, text: "Either side can terminate with written notice. Note the notice period; obligations inside it still run." },
  { re: /confidential for (\d+) years?/i, text: "Confidentiality survives the end of the document for a stated period. Diarise it; it outlives the engagement itself." },
  { re: /liability is capped/i, text: "Liability is capped. The cap is the maximum recoverable amount for either side if something goes wrong." },
  { re: /handle under applicable|confidential medical/i, text: "The document itself declares the contents confidential health information, so any copy shared onward inherits that handling duty." },
  { re: /medication adjustment/i, text: "A medication adjustment is requested from the specialist. The current regimen stays in force until that review happens." },
];

export function simAnalyse(redactedArtefact) {
  const { redactedText, documentType, entityStats } = redactedArtefact;
  const watchOuts = WATCH_RULES.filter((r) => r.re.test(redactedText)).map((r) => r.text);

  const obligations = [];
  for (const sentence of redactedText.split(/(?<=[.!])\s+/)) {
    if (/no later than|due|before \d|runs from|until \d|payable/i.test(sentence) && sentence.length < 240) {
      obligations.push(sentence.trim());
    }
    if (obligations.length >= 4) break;
  }

  const typeLine = {
    contract: "This agreement binds two parties to a defined scope of work for a fixed fee and a fixed term, with the redacted text preserving every commercial term while removing who the parties are.",
    payslip: "This payslip records one pay period. Earnings, deductions and net pay remain fully readable after redaction; only the employee's identity and payment destination were removed.",
    medical_letter: "This referral moves a patient from a general practitioner to a specialist. The clinical content is intact; direct identifiers were removed before the document reached the cloud.",
    invoice: "This invoice records a payment obligation. The amounts and dates remain readable after redaction; only the parties' identifying details were removed.",
    other: "The document was analysed in redacted form only.",
  }[documentType] ?? "The document was analysed in redacted form only.";

  const netMatch = redactedText.match(/NET PAY\s+(Rp [\d.]+)/);
  const grossMatch = redactedText.match(/Gross Pay\s+(Rp [\d.]+)/);
  let figures = "";
  if (netMatch && grossMatch) {
    figures = ` Gross pay of ${grossMatch[1]} results in net pay of ${netMatch[1]} after the listed deductions.`;
  }

  return {
    summary: typeLine + figures,
    watchOuts: watchOuts.length ? watchOuts : ["No clauses matching Redacta's standard watch list were found in the redacted text. That is not a legal opinion; unusual documents still deserve a human read."],
    obligations: obligations.length ? obligations : ["No dated obligations were detected in the redacted text."],
    redactionNote: `${entityStats.total} sensitive spans were removed on-device before this analysis ran (${entityStats.critical} critical, ${entityStats.high} high). The cloud model never received them.`,
    simulatedLatencyMs: 1150 + Math.round(redactedText.length / 6),
  };
}

/** Small delay helper so simulated latency reads as real in the UI. */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
