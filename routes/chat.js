'use strict';

/**
 * Chat routes — mounted at /api/chat by server.js.
 *
 *   POST   /api/chat           { message, history? } -> { reply, actions, history }
 *   GET    /api/chat/history                          -> { history }
 *   DELETE /api/chat/history                          -> { ok: true }
 */

const express = require('express');
const chatAgent = require('../lib/chatAgent');
const store = require('../lib/store');

const router = express.Router();

// POST /api/chat — send a message, run the agent, return reply + actions + history.
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const message = body.message;
    if (message == null || String(message).trim() === '') {
      return res.status(400).json({ error: 'message is required' });
    }
    const history = Array.isArray(body.history) ? body.history : [];

    const result = await chatAgent.runChat({ userId: req.userId, message: String(message), history });
    return res.json({
      reply: result.reply,
      actions: result.actions,
      history: result.history,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: (err && err.message) || 'chat failed' });
  }
});

// GET /api/chat/history — chronological persisted chat history.
router.get('/history', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    const history = await store.getChatHistory(req.userId, limit);
    return res.json({ history });
  } catch (err) {
    return res
      .status(500)
      .json({ error: (err && err.message) || 'failed to load history' });
  }
});

// DELETE /api/chat/history — clear persisted chat history.
router.delete('/history', async (req, res) => {
  try {
    await store.clearChat(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    return res
      .status(500)
      .json({ error: (err && err.message) || 'failed to clear history' });
  }
});

module.exports = router;
