// functions/_lib/openrouter.js — thin OpenRouter chat-completions client, ported
// from ../../lib/openrouter.js. The key comes ONLY from env.OPENROUTER_API_KEY
// (a Pages secret) — there is no filesystem to read the shared vault file from
// on Workers, unlike the Express app's fallback chain.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function loadOpenRouterKey(env) {
  const k = (env.OPENROUTER_API_KEY || '').trim();
  return k || '';
}

export function getModels(env) {
  const VISION_MODEL = env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash-lite';
  const CHAT_MODEL = env.OPENROUTER_CHAT_MODEL || 'deepseek/deepseek-v4-flash';
  return { VISION_MODEL, CHAT_MODEL };
}

/**
 * chat(env, {messages, model, tools, tool_choice, temperature=0.3, max_tokens=1500, response_format})
 * -> choices[0].message (object; may have .content and/or .tool_calls).
 * Throws Error(status + body) on non-200, matching the Express app's contract.
 */
export async function chat(env, { messages, model, tools, tool_choice, temperature = 0.3, max_tokens = 1500, response_format } = {}) {
  const apiKey = loadOpenRouterKey(env);
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  if (!Array.isArray(messages)) throw new Error('chat(): messages must be an array');

  const { CHAT_MODEL } = getModels(env);
  const body = { model: model || CHAT_MODEL, messages, temperature, max_tokens };
  if (tools !== undefined) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (response_format !== undefined) body.response_format = response_format;

  const referer = env.PUBLIC_URL || 'https://unglutened.pages.dev';

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer,
      'X-Title': 'UnGlutened',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch (_) {
      text = '<unreadable body>';
    }
    throw new Error(`OpenRouter ${res.status}: ${text}`);
  }

  const data = await res.json();
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!message) throw new Error(`OpenRouter returned no message: ${JSON.stringify(data).slice(0, 500)}`);
  return message;
}
