"use strict";

// Builds a doctor-friendly markdown report from meals, symptoms and the
// precomputed correlations object (from lib/correlate.computeCorrelations).
// PURE: no DB access. Never fabricates correlation numbers — if correlations
// are not ready, it says so plainly.

const DISCLAIMER =
  "This is a self-tracking summary, not medical advice. Share with your clinician.";

function dateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return String(v);
}

function fmtDelta(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}`;
}

function buildReport(input = {}) {
  const {
    meals = [],
    symptoms = [],
    correlations = null,
    generatedAt = null,
  } = input;

  const lines = [];

  // Title + generated date.
  lines.push("# UnGlutened — Gut Health Report");
  lines.push("");
  const gen = generatedAt ? new Date(generatedAt) : new Date();
  const genStr = isNaN(gen.getTime())
    ? new Date().toISOString().slice(0, 10)
    : gen.toISOString().slice(0, 10);
  lines.push(`*Generated: ${genStr}*`);
  lines.push("");

  // Date range across meals + symptoms.
  const allDates = [];
  for (const m of meals) {
    const k = dateKey(m.eaten_at);
    if (k) allDates.push(k);
  }
  for (const s of symptoms) {
    const k = dateKey(s.logged_for);
    if (k) allDates.push(k);
  }
  allDates.sort();
  const rangeFrom = allDates.length ? allDates[0] : null;
  const rangeTo = allDates.length ? allDates[allDates.length - 1] : null;

  lines.push("## Overview");
  lines.push("");
  if (rangeFrom && rangeTo) {
    lines.push(`- **Date range:** ${rangeFrom} → ${rangeTo}`);
  } else {
    lines.push(`- **Date range:** no data logged yet`);
  }
  lines.push(`- **Meals logged:** ${meals.length}`);
  lines.push(`- **Gut entries logged:** ${symptoms.length}`);
  lines.push("");

  // Top correlations table.
  lines.push("## Top correlations");
  lines.push("");
  if (correlations && correlations.ready && Array.isArray(correlations.topFindings) && correlations.topFindings.length) {
    const win = correlations.window;
    lines.push(
      `Exposure window: same day plus the prior ${win} day(s). "Exposed avg" and "Not-exposed avg" are mean composite badness (0–10, higher = worse digestion). A positive delta means worse digestion on exposed days.`
    );
    lines.push("");
    lines.push(
      "| Item | Type | Exposed avg | Not-exposed avg | Delta | Severity | Days (with/without) |"
    );
    lines.push(
      "|---|---|---|---|---|---|---|"
    );
    for (const f of correlations.topFindings) {
      lines.push(
        `| ${f.label} | ${f.kind} | ${fmtNum(f.badnessWith)} | ${fmtNum(
          f.badnessWithout
        )} | ${fmtDelta(f.badnessDelta)} | ${f.severity} | ${f.daysWith}/${f.daysWithout} |`
      );
    }
    lines.push("");
    // Plain-language highlights.
    const worse = correlations.topFindings.filter(
      (f) => f.severity === "high" || f.severity === "medium"
    );
    const better = correlations.topFindings.filter(
      (f) => f.severity === "protective"
    );
    if (worse.length) {
      lines.push(
        `**Associated with worse digestion:** ${worse
          .map((f) => f.label)
          .join(", ")}.`
      );
    }
    if (better.length) {
      lines.push(
        `**Associated with better digestion:** ${better
          .map((f) => f.label)
          .join(", ")}.`
      );
    }
    if (worse.length || better.length) lines.push("");
  } else {
    const reason =
      correlations && correlations.reason
        ? correlations.reason
        : "Not enough data yet to compute reliable correlations.";
    lines.push(`_${reason}_`);
    lines.push("");
  }

  // Irritant-exposure frequency (how often each irritant flag appeared across meals).
  lines.push("## Irritant exposure frequency");
  lines.push("");
  const irritantCounts = new Map();
  for (const m of meals) {
    const flags = Array.isArray(m.irritant_flags) ? m.irritant_flags : [];
    const seen = new Set();
    for (const f of flags) {
      if (f === null || f === undefined) continue;
      const t = String(f).trim().toLowerCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      irritantCounts.set(t, (irritantCounts.get(t) || 0) + 1);
    }
  }
  if (irritantCounts.size) {
    const sorted = Array.from(irritantCounts.entries()).sort(
      (a, b) => b[1] - a[1]
    );
    lines.push("| Irritant | Meals containing it |");
    lines.push("|---|---|");
    for (const [name, count] of sorted) {
      const label = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");
      lines.push(`| ${label} | ${count} |`);
    }
    lines.push("");
  } else {
    lines.push("_No irritant flags recorded across logged meals._");
    lines.push("");
  }

  // Recent symptom trend — last ~14 days of gut entries.
  lines.push("## Recent symptom trend (last 14 days)");
  lines.push("");
  const sortedSymptoms = symptoms
    .map((s) => ({ ...s, _key: dateKey(s.logged_for) }))
    .filter((s) => s._key)
    .sort((a, b) => (a._key < b._key ? 1 : a._key > b._key ? -1 : 0)) // desc
    .slice(0, 14)
    .sort((a, b) => (a._key < b._key ? -1 : a._key > b._key ? 1 : 0)); // back to asc

  if (sortedSymptoms.length) {
    lines.push(
      "| Date | Bloating | Bristol | Gas | Cramps | Energy | Mood |"
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const s of sortedSymptoms) {
      lines.push(
        `| ${s._key} | ${fmtNum(s.bloating)} | ${fmtNum(s.bristol)} | ${fmtNum(
          s.gas
        )} | ${fmtNum(s.cramps)} | ${fmtNum(s.energy)} | ${fmtNum(s.mood)} |`
      );
    }
    lines.push("");
    lines.push(
      "_Scale: bloating/gas/cramps 0–5 (higher = worse); Bristol 1–7 (4 = ideal); energy/mood 0–5 (higher = better)._"
    );
    lines.push("");
  } else {
    lines.push("_No gut entries logged yet._");
    lines.push("");
  }

  // Disclaimer.
  lines.push("---");
  lines.push("");
  lines.push(`> ${DISCLAIMER}`);
  lines.push("");

  return lines.join("\n");
}

module.exports = { buildReport };
