'use strict';

/**
 * Chatbot agent for UnGlutened.
 *
 * Uses the cheap tool-calling chat model (DeepSeek V4 Flash) via OpenRouter to
 * answer questions about the user's logged meals & gut symptoms and to
 * add / update / delete entries ("change my memory") through function tools.
 *
 * Contract:
 *   module.exports = { runChat, TOOLS }
 *   async runChat({userId, message, history=[]}) -> { reply, actions, history }
 */

const openrouter = require('./openrouter');
const store = require('./store');
const correlate = require('./correlate');

const { CHAT_MODEL } = openrouter;

const MAX_TOOL_ITERATIONS = 6;

/* ------------------------------------------------------------------ *
 * Tool definitions (OpenAI / OpenRouter function-tool schema)
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_today',
      description: "Get today's date (ISO yyyy-mm-dd, UTC) and current ISO timestamp.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stats',
      description:
        'Get high-level stats: total meal count, total symptom-log count, and the first/last logged dates.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_meals',
      description:
        'List logged meals, most recent first. Optionally filter by date range and/or an ingredient/irritant substring.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Inclusive start date or timestamp (ISO).' },
          to: { type: 'string', description: 'Inclusive end date or timestamp (ISO).' },
          limit: { type: 'integer', description: 'Max rows to return (default 200).' },
          contains: {
            type: 'string',
            description: 'Case-insensitive substring matched against ingredient names / irritant flags.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_symptoms',
      description: 'List daily gut-health (symptom) logs, most recent first. Optionally filter by date range.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Inclusive start date (ISO yyyy-mm-dd).' },
          to: { type: 'string', description: 'Inclusive end date (ISO yyyy-mm-dd).' },
          limit: { type: 'integer', description: 'Max rows to return (default 365).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_meal',
      description:
        'Add a meal to the log. Use for "log that I ate ..." requests. eaten_at defaults to now if omitted. Provide ingredients when the user named foods.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short meal name.' },
          description: { type: 'string', description: 'Free-text description.' },
          eaten_at: { type: 'string', description: 'When it was eaten (ISO timestamp). Defaults to now.' },
          summary: { type: 'string', description: 'One-line summary of the meal.' },
          ingredients: {
            type: 'array',
            description: 'Ingredients in the meal.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                irritant: { type: 'boolean' },
                irritant_type: { type: ['string', 'null'] },
                confidence: { type: 'number' },
              },
              required: ['name'],
            },
          },
          irritant_flags: {
            type: 'array',
            description: 'Irritant flags present (e.g. "gluten", "dairy").',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_symptom',
      description:
        'Add a daily gut-health log. Use for "log that I felt ..." requests. logged_for defaults to today. Scales: bloating/gas/cramps 0-5 (higher worse), bristol 1-7 (Bristol stool scale), energy/mood 0-5 (higher better).',
      parameters: {
        type: 'object',
        properties: {
          logged_for: { type: 'string', description: 'Date this log is for (ISO yyyy-mm-dd). Defaults to today.' },
          bloating: { type: 'integer', description: '0-5, higher = worse.' },
          bristol: { type: 'integer', description: '1-7 Bristol stool scale.' },
          gas: { type: 'integer', description: '0-5, higher = worse.' },
          cramps: { type: 'integer', description: '0-5, higher = worse.' },
          energy: { type: 'integer', description: '0-5, higher = better.' },
          mood: { type: 'integer', description: '0-5, higher = better.' },
          other_symptoms: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_meal',
      description: 'Update fields of an existing meal by id. Only the provided fields are changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Meal id to update.' },
          title: { type: 'string' },
          description: { type: 'string' },
          eaten_at: { type: 'string' },
          summary: { type: 'string' },
          ingredients: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                irritant: { type: 'boolean' },
                irritant_type: { type: ['string', 'null'] },
                confidence: { type: 'number' },
              },
              required: ['name'],
            },
          },
          irritant_flags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_symptom',
      description: 'Update fields of an existing gut-health log by id. Only the provided fields are changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Symptom log id to update.' },
          logged_for: { type: 'string' },
          bloating: { type: 'integer' },
          bristol: { type: 'integer' },
          gas: { type: 'integer' },
          cramps: { type: 'integer' },
          energy: { type: 'integer' },
          mood: { type: 'integer' },
          other_symptoms: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_meal',
      description: 'Delete a meal by id. Use for "delete my last meal" after finding the id via list_meals.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Meal id to delete.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_symptom',
      description: 'Delete a gut-health log by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Symptom log id to delete.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_correlations',
      description:
        'Compute correlations between logged foods/irritants and gut symptoms. Returns ready=false with a reason if there is not enough data yet.',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'integer', description: 'Look-back window in days (1 or 2). Default 1.' },
          minOccur: { type: 'integer', description: 'Minimum exposure occurrences to consider a candidate (default 3).' },
        },
        additionalProperties: false,
      },
    },
  },
];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function mealSummary(meal) {
  if (!meal) return '';
  const title = meal.title || meal.summary || 'meal';
  const when = meal.eaten_at ? String(meal.eaten_at) : '';
  const flags =
    Array.isArray(meal.irritant_flags) && meal.irritant_flags.length
      ? ` [${meal.irritant_flags.join(', ')}]`
      : '';
  return `${title}${when ? ' @ ' + when : ''}${flags}`.trim();
}

function symptomSummary(s) {
  if (!s) return '';
  const parts = [];
  if (s.logged_for != null) parts.push(String(s.logged_for));
  const metrics = [];
  for (const k of ['bloating', 'bristol', 'gas', 'cramps', 'energy', 'mood']) {
    if (s[k] != null) metrics.push(`${k}=${s[k]}`);
  }
  if (metrics.length) parts.push(metrics.join(' '));
  return parts.join(' ');
}

/**
 * Parse a tool-call's JSON arguments robustly.
 * Returns { ok:true, args } or { ok:false, error }.
 */
function parseToolArgs(rawArgs) {
  if (rawArgs == null || rawArgs === '') return { ok: true, args: {} };
  if (typeof rawArgs === 'object') return { ok: true, args: rawArgs };
  try {
    const parsed = JSON.parse(rawArgs);
    return { ok: true, args: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch (err) {
    return { ok: false, error: `Invalid tool arguments JSON: ${(err && err.message) || err}` };
  }
}

/**
 * Execute one tool by name with parsed args.
 * Returns { result, action } where `result` is the JS value to stringify back
 * to the model and `action` (optional) records a successful mutation.
 * Throws on internal failure (caller catches).
 *
 * Every store call is scoped to `userId` so the agent can only read/mutate the
 * calling user's own meals, symptoms, and stats.
 */
async function executeTool(userId, name, args, actions) {
  switch (name) {
    case 'get_today': {
      const now = new Date();
      return {
        result: { date: todayISODate(), now: now.toISOString() },
      };
    }

    case 'get_stats': {
      const s = await store.stats(userId);
      return { result: s };
    }

    case 'list_meals': {
      const opts = {};
      if (args.from != null) opts.from = args.from;
      if (args.to != null) opts.to = args.to;
      if (args.limit != null) opts.limit = args.limit;
      if (args.contains != null) opts.contains = args.contains;
      const meals = await store.listMeals(userId, opts);
      return { result: { count: meals.length, meals } };
    }

    case 'list_symptoms': {
      const opts = {};
      if (args.from != null) opts.from = args.from;
      if (args.to != null) opts.to = args.to;
      if (args.limit != null) opts.limit = args.limit;
      const symptoms = await store.listSymptoms(userId, opts);
      return { result: { count: symptoms.length, symptoms } };
    }

    case 'add_meal': {
      const meal = await store.createMeal(userId, {
        eaten_at: args.eaten_at,
        title: args.title,
        description: args.description,
        ingredients: args.ingredients,
        irritant_flags: args.irritant_flags,
        summary: args.summary,
        source: 'chat',
      });
      const action = {
        type: 'add_meal',
        id: meal.id,
        summary: `Logged meal: ${mealSummary(meal)}`,
      };
      actions.push(action);
      return { result: { ok: true, meal }, action };
    }

    case 'add_symptom': {
      const symptom = await store.createSymptom(userId, {
        logged_for: args.logged_for,
        bloating: args.bloating,
        bristol: args.bristol,
        gas: args.gas,
        cramps: args.cramps,
        energy: args.energy,
        mood: args.mood,
        other_symptoms: args.other_symptoms,
        notes: args.notes,
        source: 'chat',
      });
      const action = {
        type: 'add_symptom',
        id: symptom.id,
        summary: `Logged gut entry: ${symptomSummary(symptom)}`,
      };
      actions.push(action);
      return { result: { ok: true, symptom }, action };
    }

    case 'update_meal': {
      if (args.id == null) {
        return { result: { ok: false, error: 'update_meal requires an id' } };
      }
      const fields = {};
      for (const k of ['title', 'description', 'eaten_at', 'summary', 'ingredients', 'irritant_flags']) {
        if (args[k] !== undefined) fields[k] = args[k];
      }
      const meal = await store.updateMeal(userId, args.id, fields);
      if (!meal) {
        return { result: { ok: false, error: `No meal with id ${args.id}` } };
      }
      const action = {
        type: 'update_meal',
        id: meal.id,
        summary: `Updated meal #${meal.id}: ${mealSummary(meal)}`,
      };
      actions.push(action);
      return { result: { ok: true, meal }, action };
    }

    case 'update_symptom': {
      if (args.id == null) {
        return { result: { ok: false, error: 'update_symptom requires an id' } };
      }
      const fields = {};
      for (const k of ['logged_for', 'bloating', 'bristol', 'gas', 'cramps', 'energy', 'mood', 'other_symptoms', 'notes']) {
        if (args[k] !== undefined) fields[k] = args[k];
      }
      const symptom = await store.updateSymptom(userId, args.id, fields);
      if (!symptom) {
        return { result: { ok: false, error: `No gut entry with id ${args.id}` } };
      }
      const action = {
        type: 'update_symptom',
        id: symptom.id,
        summary: `Updated gut entry #${symptom.id}: ${symptomSummary(symptom)}`,
      };
      actions.push(action);
      return { result: { ok: true, symptom }, action };
    }

    case 'delete_meal': {
      if (args.id == null) {
        return { result: { ok: false, error: 'delete_meal requires an id' } };
      }
      const ok = await store.deleteMeal(userId, args.id);
      if (!ok) {
        return { result: { ok: false, error: `No meal with id ${args.id}` } };
      }
      const action = {
        type: 'delete_meal',
        id: args.id,
        summary: `Deleted meal #${args.id}`,
      };
      actions.push(action);
      return { result: { ok: true, id: args.id }, action };
    }

    case 'delete_symptom': {
      if (args.id == null) {
        return { result: { ok: false, error: 'delete_symptom requires an id' } };
      }
      const ok = await store.deleteSymptom(userId, args.id);
      if (!ok) {
        return { result: { ok: false, error: `No gut entry with id ${args.id}` } };
      }
      const action = {
        type: 'delete_symptom',
        id: args.id,
        summary: `Deleted gut entry #${args.id}`,
      };
      actions.push(action);
      return { result: { ok: true, id: args.id }, action };
    }

    case 'get_correlations': {
      const meals = await store.listMeals(userId, { limit: 1000 });
      const symptoms = await store.listSymptoms(userId, { limit: 1000 });
      const cOpts = { meals, symptoms };
      if (args.window != null) cOpts.window = args.window;
      if (args.minOccur != null) cOpts.minOccur = args.minOccur;
      const correlations = correlate.computeCorrelations(cOpts);
      return { result: correlations };
    }

    default:
      return { result: { ok: false, error: `Unknown tool: ${name}` } };
  }
}

function buildSystemPrompt() {
  return [
    'You are the helpful in-app assistant for UnGlutened, a personal food <-> gut-health tracker.',
    'You can answer questions about the user\'s logged meals and gut symptoms, and you can add, update, or delete entries on request ("change my memory") using the provided tools.',
    `Today's date is ${todayISODate()} (UTC).`,
    'Guidelines:',
    '- Be concise and friendly.',
    '- Never invent data. If you do not know something about the user\'s logs, call a tool to look it up.',
    '- For "delete my last X" style requests, first list the relevant entries to find the correct id, then delete it.',
    '- After any add/update/delete, confirm to the user with the entity id and a one-line summary of what changed.',
    '- Scales: bloating/gas/cramps are 0-5 (higher = worse); bristol is the 1-7 Bristol stool scale; energy/mood are 0-5 (higher = better).',
    '- You are not a doctor; do not give medical diagnoses. You may summarize patterns and suggest discussing them with a clinician.',
  ].join('\n');
}

/**
 * Run one chat turn with tool-calling.
 *
 * @param {Object} opts
 * @param {number} opts.userId             - the authenticated user's id (scopes all store access)
 * @param {string} opts.message            - the new user message
 * @param {Array}  [opts.history]          - prior [{role, content}] turns
 * @returns {Promise<{reply:string, actions:Array, history:Array}>}
 */
async function runChat({ userId, message, history = [] } = {}) {
  const userMessage = message == null ? '' : String(message);
  const priorHistory = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content != null)
        .map((m) => ({ role: m.role, content: String(m.content) }))
    : [];

  const actions = [];

  // Working message list sent to the model (includes system + tool messages).
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...priorHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let reply = '';

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const assistantMsg = await openrouter.chat({
        messages,
        model: CHAT_MODEL,
        tools: TOOLS,
        temperature: 0.3,
        max_tokens: 1500,
      });

      const toolCalls =
        assistantMsg && Array.isArray(assistantMsg.tool_calls)
          ? assistantMsg.tool_calls
          : null;

      if (toolCalls && toolCalls.length) {
        // Push the assistant message that requested the tools (must precede tool results).
        messages.push({
          role: 'assistant',
          content: assistantMsg.content || '',
          tool_calls: toolCalls,
        });

        // Execute every requested tool, appending a role:'tool' result for each.
        for (const call of toolCalls) {
          const callId = call && call.id ? call.id : `call_${i}`;
          const fn = (call && call.function) || {};
          const name = fn.name || '';

          let resultPayload;
          const parsed = parseToolArgs(fn.arguments);
          if (!parsed.ok) {
            // Malformed args from the model: feed the error back as the tool result.
            resultPayload = { ok: false, error: parsed.error };
          } else {
            try {
              const out = await executeTool(userId, name, parsed.args, actions);
              resultPayload = out.result;
            } catch (err) {
              resultPayload = {
                ok: false,
                error: `Tool "${name}" failed: ${(err && err.message) || String(err)}`,
              };
            }
          }

          messages.push({
            role: 'tool',
            tool_call_id: callId,
            content:
              typeof resultPayload === 'string'
                ? resultPayload
                : JSON.stringify(resultPayload),
          });
        }
        // Continue the loop: let the model react to the tool results.
        continue;
      }

      // No tool calls -> this is the final answer.
      reply =
        assistantMsg && assistantMsg.content != null
          ? String(assistantMsg.content)
          : '';
      break;
    }

    if (!reply) {
      // Loop exhausted without a final text answer, or model returned empty content.
      reply =
        actions.length > 0
          ? "Done. I've updated your log."
          : "I'm sorry, I couldn't complete that request. Could you rephrase?";
    }
  } catch (err) {
    reply = `Sorry, something went wrong handling that: ${(err && err.message) || String(err)}`;
  }

  // Persist the user message and assistant reply. Never let persistence crash the request.
  try {
    await store.saveChat(userId, 'user', userMessage);
    await store.saveChat(userId, 'assistant', reply);
  } catch (_) {
    // ignore persistence errors — the reply is still returned
  }

  const updatedHistory = [
    ...priorHistory,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ];

  return { reply, actions, history: updatedHistory };
}

module.exports = { runChat, TOOLS };
