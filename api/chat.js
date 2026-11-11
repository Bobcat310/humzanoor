/**
 * POST /api/chat
 *
 * A grounded answer endpoint. The whole fact base (~3k tokens) goes into the
 * system prompt rather than being retrieved over.
 *
 * That is a deliberate call: at this corpus size, embedding search would add a
 * dependency, a failure mode and a retrieval-quality problem to solve, in
 * exchange for saving tokens that cost a fraction of a cent. Stuffing is both
 * cheaper and more reliable here. Retrieval earns its place when the corpus
 * stops fitting, not before.
 *
 * Guards, in order of how likely they are to matter:
 *   - input length cap, so nobody pastes a novel
 *   - per-IP rate limit, in-memory (see the note below)
 *   - hard max_tokens, so a single call cannot run away
 *   - no conversation history accepted from the client, so the context window
 *     cannot be inflated by a crafted request
 */

import { SYSTEM_PROMPT } from "../data/facts.js";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 400;
const MAX_INPUT_CHARS = 500;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;

/**
 * In-memory rate limiting. Honest caveat: serverless instances are ephemeral
 * and there can be several, so this is a speed bump rather than a guarantee.
 * It stops casual hammering, which is what it is for. A determined abuser needs
 * a shared store (Upstash, Vercel KV); that is the upgrade if this ever matters.
 */
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "Chat is not configured right now. Email humzanoor8@gmail.com.",
    });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    return res
      .status(429)
      .json({ error: "A few too many questions at once. Try again shortly." });
  }

  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Ask something first." });
  }
  if (question.length > MAX_INPUT_CHARS) {
    return res
      .status(400)
      .json({ error: `Keep it under ${MAX_INPUT_CHARS} characters.` });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("anthropic error", upstream.status, detail.slice(0, 500));
      return res.status(502).json({
        error: "Could not get an answer just now. Email humzanoor8@gmail.com.",
      });
    }

    const data = await upstream.json();
    const answer = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!answer) {
      return res.status(502).json({
        error: "Came back empty. Email humzanoor8@gmail.com.",
      });
    }

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ answer });
  } catch (err) {
    console.error("chat handler failed", err);
    return res.status(500).json({
      error: "Something broke on my side. Email humzanoor8@gmail.com.",
    });
  }
}
