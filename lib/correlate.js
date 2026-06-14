"use strict";

// PURE correlation engine for UnGlutened. NO database access here.
//
// Goal: given logged meals and daily gut-symptom entries, estimate which
// foods/irritants are associated with worse (or better) digestion — WITHOUT
// ever fabricating numbers when there is too little data.
//
// METRICS semantics:
//   bloating, gas, cramps  -> higher = worse  (0..5)
//   bristol                -> deviation from 4 = worse (1..7 Bristol Stool Scale; 4 is ideal)
//   energy, mood           -> lower = worse  (0..5, higher = better)

const METRICS = {
  bloating: { dir: "worse-high", range: 5 }, // 0..5, higher worse
  gas: { dir: "worse-high", range: 5 },
  cramps: { dir: "worse-high", range: 5 },
  bristol: { dir: "deviation-from-4" }, // 1..7, |x-4| worse
  energy: { dir: "worse-low", range: 5 }, // 0..5, lower worse
  mood: { dir: "worse-low", range: 5 }, // 0..5, lower worse
};

// ---------------------------------------------------------------------------
// Date helpers (operate on calendar dates as "YYYY-MM-DD" UTC strings)
// ---------------------------------------------------------------------------

function dateKey(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Strings like "2026-06-14", "2026-06-14T08:00:00Z", or Date-parsable.
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Add `n` days to a "YYYY-MM-DD" key, returning a new "YYYY-MM-DD" key.
function addDays(key, n) {
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Badness index
// ---------------------------------------------------------------------------
//
// Composite "badness" score in the range 0..10, higher = worse digestion.
// Built from whichever of the six metrics are present on a given symptom-day,
// then averaged across the metrics that were actually recorded and rescaled
// so a fully-bad day ≈ 10 and a fully-good day ≈ 0.
//
// Per-metric badness, each normalized to 0..1:
//   bloating : value / 5                 (0 good .. 5 worst)
//   gas      : value / 5
//   cramps   : value / 5
//   bristol  : |value - 4| / 3           (4 ideal; 1 or 7 are the extremes, distance 3)
//   energy   : (5 - value) / 5           (5 best -> 0 badness ; 0 worst -> 1)
//   mood     : (5 - value) / 5
//
// We average the available per-metric badness fractions (ignoring nulls) and
// multiply by 10 to land on a 0..10 scale. Averaging (rather than summing)
// keeps the scale stable even when some metrics weren't logged that day.
function badnessForDay(sym) {
  const parts = [];

  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  if (sym.bloating !== null && sym.bloating !== undefined) {
    parts.push(clamp01(sym.bloating / 5));
  }
  if (sym.gas !== null && sym.gas !== undefined) {
    parts.push(clamp01(sym.gas / 5));
  }
  if (sym.cramps !== null && sym.cramps !== undefined) {
    parts.push(clamp01(sym.cramps / 5));
  }
  if (sym.bristol !== null && sym.bristol !== undefined) {
    parts.push(clamp01(Math.abs(sym.bristol - 4) / 3));
  }
  if (sym.energy !== null && sym.energy !== undefined) {
    parts.push(clamp01((5 - sym.energy) / 5));
  }
  if (sym.mood !== null && sym.mood !== undefined) {
    parts.push(clamp01((5 - sym.mood) / 5));
  }

  if (parts.length === 0) return null; // no usable metrics that day
  const avgFraction = parts.reduce((a, b) => a + b, 0) / parts.length;
  return avgFraction * 10; // 0..10
}

// ---------------------------------------------------------------------------
// Per-metric mean over a set of symptom-days (ignoring nulls)
// ---------------------------------------------------------------------------

function metricMeans(days) {
  const keys = ["bloating", "gas", "cramps", "bristol", "energy", "mood"];
  const out = {};
  for (const k of keys) {
    let sum = 0;
    let n = 0;
    for (const d of days) {
      const v = d[k];
      if (v !== null && v !== undefined && !Number.isNaN(Number(v))) {
        sum += Number(v);
        n++;
      }
    }
    out[k] = n > 0 ? sum / n : null;
  }
  return out;
}

function badnessMean(days) {
  let sum = 0;
  let n = 0;
  for (const d of days) {
    const b = badnessForDay(d);
    if (b !== null) {
      sum += b;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

function round(v, p = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const f = Math.pow(10, p);
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function computeCorrelations(input = {}) {
  const {
    meals = [],
    symptoms = [],
    window = 1,
    minOccur = 3,
    minSymptomDays = 4,
  } = input;

  const win = Math.max(0, parseInt(window, 10) || 0);
  const minOcc = Math.max(1, parseInt(minOccur, 10) || 3);
  const minDays = Math.max(1, parseInt(minSymptomDays, 10) || 4);

  // Collapse symptoms to one entry per logged_for date (the most complete /
  // latest one wins; symptoms are typically one-per-day but we guard anyway).
  const symByDate = new Map();
  for (const s of symptoms) {
    const key = dateKey(s.logged_for);
    if (!key) continue;
    // Prefer the entry with the highest id (latest edit) if duplicates exist.
    const existing = symByDate.get(key);
    if (!existing || Number(s.id) >= Number(existing.id)) {
      symByDate.set(key, s);
    }
  }

  const symptomDays = Array.from(symByDate.entries())
    .map(([date, s]) => ({ date, sym: s }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const nSymptomDays = symptomDays.length;
  const nMeals = meals.length;

  // Index meal exposures by calendar date: date -> Set of exposure tokens.
  // A token is either an irritant flag (lowercased) or an ingredient name
  // (lowercased). We also remember, per token, whether it came from an
  // irritant flag so we can label its kind.
  const mealsByDate = new Map();
  const irritantTokens = new Set(); // tokens known to be irritant flags

  function tokenSetForMeal(meal) {
    const tokens = new Set();
    const flags = Array.isArray(meal.irritant_flags) ? meal.irritant_flags : [];
    for (const f of flags) {
      if (f === null || f === undefined) continue;
      const t = String(f).trim().toLowerCase();
      if (t) {
        tokens.add(t);
        irritantTokens.add(t);
      }
    }
    const ings = Array.isArray(meal.ingredients) ? meal.ingredients : [];
    for (const ing of ings) {
      const name = ing && ing.name !== undefined ? ing.name : null;
      if (name === null || name === undefined) continue;
      const t = String(name).trim().toLowerCase();
      if (t) tokens.add(t);
    }
    return tokens;
  }

  for (const meal of meals) {
    const key = dateKey(meal.eaten_at);
    if (!key) continue;
    const set = tokenSetForMeal(meal);
    if (!mealsByDate.has(key)) mealsByDate.set(key, new Set());
    const dayTokens = mealsByDate.get(key);
    for (const t of set) dayTokens.add(t);
  }

  // For each symptom-day, build its EXPOSURE SET = union of meal tokens from
  // meals eaten on any date in [D - window, D].
  const exposureByDay = new Map(); // symptom date -> Set(tokens)
  for (const { date } of symptomDays) {
    const exposure = new Set();
    for (let k = 0; k <= win; k++) {
      const d = addDays(date, -k);
      const dayTokens = mealsByDate.get(d);
      if (dayTokens) for (const t of dayTokens) exposure.add(t);
    }
    exposureByDay.set(date, exposure);
  }

  // Count how many exposure-sets each candidate token appears in.
  const occurrence = new Map(); // token -> count of symptom-days exposed
  for (const { date } of symptomDays) {
    const exposure = exposureByDay.get(date);
    for (const t of exposure) {
      occurrence.set(t, (occurrence.get(t) || 0) + 1);
    }
  }

  // Candidates = tokens appearing in >= minOccur exposure sets.
  const candidates = [];
  for (const [token, count] of occurrence.entries()) {
    if (count >= minOcc) candidates.push(token);
  }

  // Guardrail: not enough gut data at all -> never fabricate.
  if (nSymptomDays < minDays) {
    return {
      ready: false,
      reason: `Log at least ${minDays} days of gut entries and ${minOcc}+ meals containing an item to see correlations.`,
      window: win,
      minOccur: minOcc,
      nMeals,
      nSymptomDays,
      results: [],
      topFindings: [],
      generatedAt: null,
    };
  }

  const results = [];

  for (const token of candidates) {
    const withDays = [];
    const withoutDays = [];
    for (const { date, sym } of symptomDays) {
      const exposure = exposureByDay.get(date);
      if (exposure.has(token)) withDays.push(sym);
      else withoutDays.push(sym);
    }

    const daysWith = withDays.length;
    const daysWithout = withoutDays.length;

    // Require enough on both sides of the split to make any comparison.
    if (daysWith < 2 || daysWithout < 2) continue;

    const avgWith = metricMeans(withDays);
    const avgWithout = metricMeans(withoutDays);

    const badnessWith = badnessMean(withDays);
    const badnessWithout = badnessMean(withoutDays);
    if (badnessWith === null || badnessWithout === null) continue;

    const badnessDelta = badnessWith - badnessWithout; // >0 => worse when exposed

    // delta: a single headline metric delta is ambiguous across six metrics,
    // so we expose the badness delta as the primary `delta` too (worse-positive),
    // keeping the contract field present and meaningful.
    const delta = badnessDelta;

    // score: scaled from badnessDelta. badness is 0..10, so a full swing is
    // +/-10. We scale to roughly -100..100 for readable ranking while keeping
    // sign (positive = associated with worse digestion).
    const score = badnessDelta * 10;

    // severity thresholds on the badness delta (0..10 scale):
    //   >= 2.0  high (clearly worse)
    //   >= 1.0  medium
    //   >  0.3  low
    //   <= -1.0 protective (clearly better when exposed)
    // values between -1.0 and 0.3 are treated as low / negligible-positive.
    let severity;
    if (badnessDelta >= 2.0) severity = "high";
    else if (badnessDelta >= 1.0) severity = "medium";
    else if (badnessDelta > 0.3) severity = "low";
    else if (badnessDelta <= -1.0) severity = "protective";
    else severity = "low";

    // confidence: grows with sample size on the smaller arm and with the
    // magnitude of the effect, capped at 1. Purely heuristic, 0..1.
    const minArm = Math.min(daysWith, daysWithout);
    const sizeConf = Math.min(1, minArm / 8); // ~8 days each arm -> full size confidence
    const effectConf = Math.min(1, Math.abs(badnessDelta) / 3); // ~3pt swing -> full effect confidence
    const confidence = round(Math.min(1, 0.4 * sizeConf + 0.6 * effectConf), 2);

    const label =
      token.charAt(0).toUpperCase() + token.slice(1).replace(/_/g, " ");

    results.push({
      key: token,
      label,
      kind: irritantTokens.has(token) ? "irritant" : "ingredient",
      occurrences: occurrence.get(token) || daysWith,
      daysWith,
      daysWithout,
      avgWith: {
        bloating: round(avgWith.bloating),
        gas: round(avgWith.gas),
        cramps: round(avgWith.cramps),
        bristol: round(avgWith.bristol),
        energy: round(avgWith.energy),
        mood: round(avgWith.mood),
      },
      avgWithout: {
        bloating: round(avgWithout.bloating),
        gas: round(avgWithout.gas),
        cramps: round(avgWithout.cramps),
        bristol: round(avgWithout.bristol),
        energy: round(avgWithout.energy),
        mood: round(avgWithout.mood),
      },
      delta: round(delta),
      badnessWith: round(badnessWith),
      badnessWithout: round(badnessWithout),
      badnessDelta: round(badnessDelta),
      score: round(score),
      severity,
      confidence,
    });
  }

  // No candidate qualified -> friendly empty state, never fabricate.
  if (results.length === 0) {
    return {
      ready: false,
      reason: `Not enough overlapping data yet. Log at least ${minDays} days of gut entries and ${minOcc}+ meals containing the same item (on both exposed and non-exposed days) to see correlations.`,
      window: win,
      minOccur: minOcc,
      nMeals,
      nSymptomDays,
      results: [],
      topFindings: [],
      generatedAt: null,
    };
  }

  // Sort by score descending (most strongly associated with worse digestion first).
  results.sort((a, b) => (b.score || 0) - (a.score || 0));

  const topFindings = results.slice(0, 5);

  return {
    ready: true,
    window: win,
    minOccur: minOcc,
    nMeals,
    nSymptomDays,
    results,
    topFindings,
    generatedAt: null,
  };
}

module.exports = { computeCorrelations, METRICS };
