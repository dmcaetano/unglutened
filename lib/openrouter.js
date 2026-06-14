'use strict';

/**
 * Thin OpenRouter chat-completions client.
 *
 * Uses the built-in global `fetch` (Node 24). No extra HTTP deps.
 *
 * Contract:
 *   module.exports = { chat, VISION_MODEL, CHAT_MODEL }
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Cheap, vision-capable model used by lib/vision.js for photo → ingredients.
const VISION_MODEL =
  process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash-lite';

// Cheap, tool-calling-capable (text-only) model used by the chatbot.
const CHAT_MODEL =
  process.env.OPENROUTER_CHAT_MODEL || 'deepseek/deepseek-v4-flash';

/**
 * Call the OpenRouter chat-completions endpoint and return the assistant
 * message object (`choices[0].message`). That object may contain `.content`
 * and/or `.tool_calls` depending on the response.
 *
 * @param {Object}   opts
 * @param {Array}    opts.messages         - chat messages (required)
 * @param {string}   [opts.model]          - model id (defaults to CHAT_MODEL)
 * @param {Array}    [opts.tools]          - function-tool definitions
 * @param {*}        [opts.tool_choice]    - tool-choice directive
 * @param {number}   [opts.temperature]    - sampling temperature (default 0.3)
 * @param {number}   [opts.max_tokens]     - max completion tokens (default 1500)
 * @param {Object}   [opts.response_format]- e.g. { type: 'json_object' }
 * @returns {Promise<Object>} choices[0].message
 */
async function chat({
  messages,
  model = CHAT_MODEL,
  tools,
  tool_choice,
  temperature = 0.3,
  max_tokens = 1500,
  response_format,
} = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  if (!Array.isArray(messages)) {
    throw new Error('chat(): messages must be an array');
  }

  const body = { model, messages, temperature, max_tokens };
  if (tools !== undefined) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (response_format !== undefined) body.response_format = response_format;

  const referer = process.env.PUBLIC_URL || 'http://localhost';

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
  const message =
    data && data.choices && data.choices[0] && data.choices[0].message;
  if (!message) {
    throw new Error(
      `OpenRouter returned no message: ${JSON.stringify(data).slice(0, 500)}`
    );
  }
  return message;
}

module.exports = { chat, VISION_MODEL, CHAT_MODEL };
