"use strict";

// Express router for /api/symptoms — full CRUD over daily gut entries.

const express = require("express");
const store = require("../lib/store");

const router = express.Router();

function parseId(req, res) {
  const raw = req.params.id;
  if (!/^\d+$/.test(String(raw))) {
    res.status(400).json({ error: "invalid id" });
    return null;
  }
  return Number(raw);
}

// GET /  ?from&to -> { symptoms }
router.get("/", async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    const symptoms = await store.listSymptoms({
      from: from || undefined,
      to: to || undefined,
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
    });
    res.json({ symptoms });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// GET /:id -> { symptom } | 404
router.get("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const symptom = await store.getSymptom(id);
    if (!symptom) return res.status(404).json({ error: "not found" });
    res.json({ symptom });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// POST / -> { symptom }
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const symptom = await store.createSymptom({
      logged_for: body.logged_for !== undefined ? body.logged_for : undefined,
      bloating: body.bloating !== undefined ? body.bloating : undefined,
      bristol: body.bristol !== undefined ? body.bristol : undefined,
      gas: body.gas !== undefined ? body.gas : undefined,
      cramps: body.cramps !== undefined ? body.cramps : undefined,
      energy: body.energy !== undefined ? body.energy : undefined,
      mood: body.mood !== undefined ? body.mood : undefined,
      other_symptoms: Array.isArray(body.other_symptoms)
        ? body.other_symptoms
        : undefined,
      notes: body.notes !== undefined ? body.notes : undefined,
      source: body.source !== undefined ? body.source : undefined,
    });
    res.json({ symptom });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// PUT /:id -> { symptom } | 404
router.put("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const body = req.body || {};
    const allowed = [
      "logged_for",
      "bloating",
      "bristol",
      "gas",
      "cramps",
      "energy",
      "mood",
      "other_symptoms",
      "notes",
      "source",
    ];
    const fields = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) fields[k] = body[k];
    }
    const symptom = await store.updateSymptom(id, fields);
    if (!symptom) return res.status(404).json({ error: "not found" });
    res.json({ symptom });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// DELETE /:id -> { ok:true } | 404
router.delete("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const ok = await store.deleteSymptom(id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

module.exports = router;
