'use strict';

/**
 * Meal-photo vision analysis.
 *
 * Sends a meal image (data URL) to the cheap vision model via OpenRouter and
 * extracts a structured ingredient list, flagging common digestive irritants.
 *
 * Contract:
 *   module.exports = { analyzeMeal, IRRITANT_TYPES }
 *   async analyzeMeal({imageDataUrl, title, description}) ->
 *     { title, summary, ingredients:[{name,category,irritant,irritant_type,confidence}], irritant_flags:[...] }
 *
 * NEVER throws. On any failure returns a safe fallback object with `.error`.
 */

const openrouter = require('./openrouter');
const { VISION_MODEL } = openrouter;

const IRRITANT_TYPES = [
  'gluten',
  'dairy',
  'lactose',
  'fructan_onion_garlic',
  'legumes',
  'high_fodmap',
  'spicy',
  'caffeine',
  'alcohol',
  'artificial_sweetener',
  'fried_fatty',
  'egg',
  'soy',
  'histamine',
  'other',
];

const CATEGORIES = [
  'grain',
  'dairy',
  'protein',
  'vegetable',
  'fruit',
  'fat',
  'sauce',
  'beverage',
  'sweet',
  'additive',
  'other',
];

const SYSTEM_PROMPT = [
  'You are a nutrition-aware vision assistant for a food / gut-health tracker.',
  'Look carefully at the meal photo and identify each visible food or ingredient.',
  'For every ingredient provide:',
  `- "name": short common name of the food/ingredient.`,
  `- "category": one of ${CATEGORIES.join(', ')}.`,
  `- "irritant": boolean — true for common digestive irritants (gluten, dairy/lactose, onion/garlic fructans, legumes, other high-FODMAP foods, spicy foods, caffeine, alcohol, artificial sweeteners, fried/fatty foods, egg, soy, histamine-rich foods).`,
  `- "irritant_type": when irritant is true, one of ${IRRITANT_TYPES.join(', ')}; otherwise null.`,
  `- "confidence": a number from 0 to 1 for how sure you are this ingredient is present.`,
  'Also provide a short "title" (a concise meal name) and a one-sentence "summary" describing the meal.',
  'Return STRICT JSON only — no prose, no markdown fences — shaped exactly as:',
  '{"title": string, "summary": string, "ingredients": [{"name": string, "category": string, "irritant": boolean, "irritant_type": string|null, "confidence": number}]}',
].join('\n');

/**
 * Robustly parse a model text response into an object.
 * Strips ``` fences and falls back to the first {...} block.
 * Returns null if nothing parseable is found.
 */
function parseModelJson(text) {
  if (text == null) return null;
  let s = String(text).trim();

  // Strip fenced code blocks: ```json ... ``` or ``` ... ```
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '').trim();
  }

  // First attempt: parse the whole (cleaned) string.
  try {
    return JSON.parse(s);
  } catch (_) {
    // fall through to brace extraction
  }

  // Fall back: extract the first {...} block (greedy to last brace).
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = s.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // give up
    }
  }
  return null;
}

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeIngredients(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name =
      item.name != null ? String(item.name).trim() : '';
    if (!name) continue;

    let category =
      item.category != null ? String(item.category).trim().toLowerCase() : 'other';
    if (!CATEGORIES.includes(category)) category = 'other';

    const irritant = item.irritant === true;

    let irritant_type = null;
    if (irritant) {
      const t =
        item.irritant_type != null
          ? String(item.irritant_type).trim().toLowerCase()
          : '';
      irritant_type = IRRITANT_TYPES.includes(t) ? t : 'other';
    }

    out.push({
      name,
      category,
      irritant,
      irritant_type,
      confidence: clampConfidence(item.confidence),
    });
  }
  return out;
}

/**
 * Derive unique irritant_type values for ingredients flagged as irritant.
 */
function deriveIrritantFlags(ingredients) {
  const seen = new Set();
  const flags = [];
  for (const ing of ingredients) {
    if (ing.irritant === true && ing.irritant_type) {
      if (!seen.has(ing.irritant_type)) {
        seen.add(ing.irritant_type);
        flags.push(ing.irritant_type);
      }
    }
  }
  return flags;
}

/**
 * Analyze a meal photo. Never throws.
 *
 * @param {Object} opts
 * @param {string} [opts.imageDataUrl] - base64 data URL of the meal image
 * @param {string} [opts.title]        - optional title hint from the user
 * @param {string} [opts.description]  - optional description hint from the user
 * @returns {Promise<Object>} { title, summary, ingredients, irritant_flags, [error] }
 */
async function analyzeMeal({ imageDataUrl, title, description } = {}) {
  const fallbackTitle = (title && String(title).trim()) || 'Meal';

  try {
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
      return {
        title: fallbackTitle,
        summary: '',
        ingredients: [],
        irritant_flags: [],
        error: 'No image provided',
      };
    }

    const hints = [];
    if (title && String(title).trim()) {
      hints.push(`Title hint: ${String(title).trim()}`);
    }
    if (description && String(description).trim()) {
      hints.push(`Description hint: ${String(description).trim()}`);
    }
    const textPart =
      (hints.length
        ? hints.join('\n') + '\n\n'
        : '') +
      'Analyze this meal photo and return strict JSON as specified.';

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: textPart },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ];

    const message = await openrouter.chat({
      messages,
      model: VISION_MODEL,
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    });

    const parsed = parseModelJson(message && message.content);
    if (!parsed || typeof parsed !== 'object') {
      return {
        title: fallbackTitle,
        summary: '',
        ingredients: [],
        irritant_flags: [],
        error: 'Could not parse vision model response',
      };
    }

    const ingredients = normalizeIngredients(parsed.ingredients);
    const irritant_flags = deriveIrritantFlags(ingredients);

    const resultTitle =
      (parsed.title && String(parsed.title).trim()) || fallbackTitle;
    const summary =
      parsed.summary != null ? String(parsed.summary).trim() : '';

    return {
      title: resultTitle,
      summary,
      ingredients,
      irritant_flags,
    };
  } catch (err) {
    return {
      title: fallbackTitle,
      summary: '',
      ingredients: [],
      irritant_flags: [],
      error: (err && err.message) || String(err),
    };
  }
}

module.exports = { analyzeMeal, IRRITANT_TYPES };
