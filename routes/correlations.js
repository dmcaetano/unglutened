"use strict";

// Express router mounted at /api by server.js, so internal paths are
// "/correlations" and "/report".

const express = require("express");
const store = require("../lib/store");
const correlate = require("../lib/correlate");
const report = require("../lib/report");

const router = express.Router();

// Pull meals + symptoms over a generous range so correlation has data to work
// with. We don't filter by date here (the engine aligns by calendar date),
// just cap volume with generous limits.
async function loadData(userId) {
  const [meals, symptoms] = await Promise.all([
    store.listMeals(userId, { limit: 5000 }),
    store.listSymptoms(userId, { limit: 2000 }),
  ]);
  return { meals, symptoms };
}

// GET /api/correlations?window&minOccur -> correlation result (with generatedAt stamped)
router.get("/correlations", async (req, res) => {
  try {
    const { window, minOccur } = req.query;
    const { meals, symptoms } = await loadData(req.userId);

    const result = correlate.computeCorrelations({
      meals,
      symptoms,
      window: window !== undefined ? parseInt(window, 10) : undefined,
      minOccur: minOccur !== undefined ? parseInt(minOccur, 10) : undefined,
    });

    result.generatedAt = new Date().toISOString();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// GET /api/report?format=md -> { markdown } (or text/markdown body when format=md)
router.get("/report", async (req, res) => {
  try {
    const { window, minOccur, format } = req.query;
    const { meals, symptoms } = await loadData(req.userId);

    const correlations = correlate.computeCorrelations({
      meals,
      symptoms,
      window: window !== undefined ? parseInt(window, 10) : undefined,
      minOccur: minOccur !== undefined ? parseInt(minOccur, 10) : undefined,
    });
    const generatedAt = new Date().toISOString();
    correlations.generatedAt = generatedAt;

    const markdown = report.buildReport({
      meals,
      symptoms,
      correlations,
      generatedAt,
    });

    if (format === "md") {
      res.type("text/markdown").send(markdown);
      return;
    }
    res.json({ markdown });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

module.exports = router;
