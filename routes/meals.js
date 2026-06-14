"use strict";

// Express router for /api/meals — full CRUD + photo analysis + reanalyze.

const express = require("express");
const store = require("../lib/store");
const vision = require("../lib/vision");

const router = express.Router();

// Validate that an :id param is a positive integer; respond 400 otherwise.
function parseId(req, res) {
  const raw = req.params.id;
  if (!/^\d+$/.test(String(raw))) {
    res.status(400).json({ error: "invalid id" });
    return null;
  }
  return Number(raw);
}

// GET /  ?from&to&limit&contains  -> { meals }
router.get("/", async (req, res) => {
  try {
    const { from, to, limit, contains } = req.query;
    const meals = await store.listMeals(req.userId, {
      from: from || undefined,
      to: to || undefined,
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
      contains: contains || undefined,
    });
    res.json({ meals });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// GET /:id -> { meal } | 404
router.get("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const meal = await store.getMeal(req.userId, id);
    if (!meal) return res.status(404).json({ error: "not found" });
    res.json({ meal });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// POST /  { image?, thumb?, title?, description?, eaten_at? } -> { meal }
// If `image` present: run vision.analyzeMeal then create merging AI result
// (source "photo", thumb = body.thumb || body.image). Else manual create.
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const { image, thumb, title, description, eaten_at } = body;

    if (image) {
      const ai = await vision.analyzeMeal({
        imageDataUrl: image,
        title,
        description,
      });

      const meal = await store.createMeal(req.userId, {
        eaten_at: eaten_at || undefined,
        title: ai.title || title || "Meal",
        description: description !== undefined ? description : null,
        ingredients: Array.isArray(ai.ingredients) ? ai.ingredients : [],
        irritant_flags: Array.isArray(ai.irritant_flags) ? ai.irritant_flags : [],
        summary: ai.summary || "",
        thumb: thumb || image,
        ai_raw: ai,
        source: "photo",
      });
      return res.json({ meal });
    }

    // Manual create (no photo).
    // If the caller supplied neither ingredients nor irritant_flags (e.g. a
    // plain text-logged meal, NOT the chatbot), but there is a title or
    // description, infer ingredients + flags from the text via the AI helper.
    const hasIngredients = Array.isArray(body.ingredients);
    const hasFlags = Array.isArray(body.irritant_flags);
    const hasText =
      (title !== undefined && title !== null && String(title).trim() !== "") ||
      (description !== undefined &&
        description !== null &&
        String(description).trim() !== "");

    if (!hasIngredients && !hasFlags && hasText) {
      const ai = await vision.analyzeMealText({ title, description });
      const aiIngredients = Array.isArray(ai.ingredients) ? ai.ingredients : [];
      const aiFlags = Array.isArray(ai.irritant_flags) ? ai.irritant_flags : [];

      // Use AI result only if it succeeded and produced something useful.
      if (!ai.error && (aiIngredients.length || aiFlags.length)) {
        const meal = await store.createMeal(req.userId, {
          eaten_at: eaten_at || undefined,
          title: ai.title || title || "Meal",
          description: description !== undefined ? description : null,
          ingredients: aiIngredients,
          irritant_flags: aiFlags,
          summary: ai.summary || "",
          thumb: thumb !== undefined ? thumb : null,
          ai_raw: ai,
          source: "manual",
        });
        return res.json({ meal });
      }
      // else: fall through to the plain manual create below.
    }

    const meal = await store.createMeal(req.userId, {
      eaten_at: eaten_at || undefined,
      title: title !== undefined ? title : null,
      description: description !== undefined ? description : null,
      ingredients: Array.isArray(body.ingredients) ? body.ingredients : [],
      irritant_flags: Array.isArray(body.irritant_flags)
        ? body.irritant_flags
        : [],
      summary: body.summary !== undefined ? body.summary : null,
      thumb: thumb !== undefined ? thumb : null,
      ai_raw: null,
      source: "manual",
    });
    res.json({ meal });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// PUT /:id -> { meal } | 404
router.put("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const body = req.body || {};
    // Only forward known, updatable fields.
    const allowed = [
      "eaten_at",
      "title",
      "description",
      "ingredients",
      "irritant_flags",
      "summary",
      "thumb",
      "ai_raw",
      "source",
    ];
    const fields = {};
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, k)) fields[k] = body[k];
    }
    const meal = await store.updateMeal(req.userId, id, fields);
    if (!meal) return res.status(404).json({ error: "not found" });
    res.json({ meal });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// POST /:id/reanalyze -> re-run vision on stored thumb -> { meal }
router.post("/:id/reanalyze", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const existing = await store.getMeal(req.userId, id);
    if (!existing) return res.status(404).json({ error: "not found" });
    if (!existing.thumb) {
      return res
        .status(400)
        .json({ error: "no stored image to reanalyze" });
    }

    const ai = await vision.analyzeMeal({
      imageDataUrl: existing.thumb,
      title: existing.title,
      description: existing.description,
    });

    const meal = await store.updateMeal(req.userId, id, {
      title: ai.title || existing.title || "Meal",
      ingredients: Array.isArray(ai.ingredients) ? ai.ingredients : [],
      irritant_flags: Array.isArray(ai.irritant_flags) ? ai.irritant_flags : [],
      summary: ai.summary || existing.summary || "",
      ai_raw: ai,
      source: "photo",
    });
    if (!meal) return res.status(404).json({ error: "not found" });
    res.json({ meal });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// DELETE /:id -> { ok:true } | 404
router.delete("/:id", async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const ok = await store.deleteMeal(req.userId, id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

module.exports = router;
