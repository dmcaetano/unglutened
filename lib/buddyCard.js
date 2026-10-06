'use strict';

/**
 * lib/buddyCard.js — PURE logic for the OmniBuddy card (Buddy Contract v1).
 * No database, no network. Never fabricates: the card is built only from the
 * user's own logged meals, or it says exactly which input is missing.
 *
 * The one-tap answer: "a meal you already logged that had no irritant flagged
 * (and none of your top suspected triggers) — log it again as eaten now".
 */

const correlate = require('./correlate');

const SAFE_WINDOW_DAYS = 60;
const FRESH_MS = 15 * 60 * 1000;
const PRIMARY_ID = 'log_safe_meal';

const T = {
  en: {
    title: 'Safe meal for now',
    reason_flags: 'No irritant was flagged in this meal when you logged it.',
    reason_triggers: (xs) => `No irritant was flagged in it, and it has none of your top suspects (${xs}).`,
    action: 'Log it as eaten now',
    need_none: 'Log your first meal (photo or text) so UnGlutened can find one with no flagged irritants.',
    need_safe: 'Every logged meal has a flagged irritant. Log a meal without irritants and it will show up here.',
    need_title: 'Nothing to suggest yet',
  },
  'pt-PT': {
    title: 'Refeição segura para agora',
    reason_flags: 'Nenhum irritante foi assinalado nesta refeição quando a registaste.',
    reason_triggers: (xs) => `Não tem irritantes assinalados nem nenhum dos teus principais suspeitos (${xs}).`,
    action: 'Registar como comida agora',
    need_none: 'Regista a tua primeira refeição (foto ou texto) para o UnGlutened encontrar uma sem irritantes assinalados.',
    need_safe: 'Todas as refeições registadas têm um irritante assinalado. Regista uma refeição sem irritantes e aparece aqui.',
    need_title: 'Ainda não há nada a sugerir',
  },
};
const tr = (loc) => T[loc === 'pt-PT' ? 'pt-PT' : 'en'];

function topTriggerKeys(meals, symptoms) {
  try {
    const r = correlate.computeCorrelations({ meals, symptoms });
    if (r && r.ready && Array.isArray(r.topFindings)) {
      return r.topFindings.filter((f) => f && f.key).slice(0, 5).map((f) => ({ key: String(f.key), label: f.label || String(f.key) }));
    }
  } catch (e) { /* no correlation -> no filter */ }
  return [];
}

function mealText(m) {
  const ing = Array.isArray(m.ingredients) ? m.ingredients.map((i) => (i && i.name) || '').join(' ') : '';
  return `${m.title || ''} ${ing}`.toLowerCase().replace(/_/g, ' ');
}

/** Best safe meal from the list, or { meal:null, reason:'none'|'all_flagged' }. */
function pickSafeMeal(meals, symptoms, now) {
  const list = Array.isArray(meals) ? meals : [];
  if (!list.length) return { meal: null, why: 'none', triggers: [] };
  const triggers = topTriggerKeys(list, symptoms || []);
  const cutoff = now.getTime() - SAFE_WINDOW_DAYS * 86400000;
  const candidates = list
    .filter((m) => m && m.title && String(m.title).trim())
    .filter((m) => Array.isArray(m.ingredients) && m.ingredients.length > 0)
    .filter((m) => !(Array.isArray(m.irritant_flags) && m.irritant_flags.length))
    .filter((m) => m.source !== 'omnibuddy')
    .filter((m) => new Date(m.eaten_at).getTime() >= cutoff)
    .filter((m) => {
      const txt = mealText(m);
      return !triggers.some((t) => txt.includes(String(t.label).toLowerCase()) || txt.includes(t.key.replace(/_/g, ' ')));
    })
    .sort((a, b) => new Date(b.eaten_at) - new Date(a.eaten_at));
  if (!candidates.length) return { meal: null, why: 'all_flagged', triggers };
  return { meal: candidates[0], why: 'ok', triggers };
}

/** Build the Contract v1 card. */
function buildCard({ meals, symptoms, locale, now = new Date(), deeplink }) {
  const t = tr(locale);
  const pick = pickSafeMeal(meals, symptoms, now);
  if (!pick.meal) {
    return {
      state: 'needs_data',
      title: t.need_title,
      body: pick.why === 'none' ? t.need_none : t.need_safe,
      deeplink,
      freshUntil: new Date(now.getTime() + FRESH_MS).toISOString(),
    };
  }
  const trigText = pick.triggers.map((x) => x.label).join(', ');
  return {
    state: 'ready',
    title: t.title,
    body: String(pick.meal.title).slice(0, 120),
    reason: pick.triggers.length ? t.reason_triggers(trigText) : t.reason_flags,
    primaryAction: { id: PRIMARY_ID, label: t.action },
    deeplink,
    freshUntil: new Date(now.getTime() + FRESH_MS).toISOString(),
    _mealId: pick.meal.id, // internal; stripped before sending
  };
}

/** Memory items for the hub: health hypotheses, app_only. Never facts, never shared by default. */
function buildMemoryItems(meals, symptoms) {
  const out = [];
  for (const t of topTriggerKeys(meals, symptoms)) {
    out.push({
      origin_item_id: 'trigger:' + t.key,
      kind: 'hypothesis',
      status: 'hypothesis',
      source: 'inferred',
      sensitivity: 'health',
      visibility: 'app_only',
      text: `In my UnGlutened logs, digestion tends to be worse on days I eat ${t.label}.`,
    });
  }
  return out;
}

module.exports = { buildCard, buildMemoryItems, pickSafeMeal, PRIMARY_ID };
