// supabase.js
// Lightweight Supabase client + model-choosing + feedback capture.
// Safe for browser use with anon key (RLS must be configured as described).

import { chooseModelSmart, recordVoteGlobal, updateTokenStatsViaEdge, getTopTokens } from './supabase.js';

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** ======= YOUR PROJECT (already filled) ======= */
export const SUPABASE_URL =
  "https://dorwbvdfcqhysybleytx.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvcndidmRmY3FoeXN5YmxleXR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIxODUwNTksImV4cCI6MjA3Nzc2MTA1OX0.1IlqlQCVDgXzH6bQoNSYkdYETmKv_3HyGm9WduwaqnM";
/** ============================================ */

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Table names (keep consistent with your SQL) */
export const TABLE_TOKEN_STATS = "token_stats"; // token PK, score_realism, score_anime, updated_at
export const TABLE_FEEDBACK    = "feedback";    // id, prompt, model, seed, up, created_at

/** ----- Tokenizer (fast + conservative) ----- */
const STOP = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","at","by","from",
  "this","that","these","those","as","is","are","be","it","its","into","over",
  "under","through","about","your","my","our","their","his","her"
]);

function tokenizePrompt(p) {
  return (p || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t && t.length > 2 && !STOP.has(t))
    .slice(0, 40);
}

/** ----- Heuristic fallback (when DB has no signal yet) ----- */
function heuristicModel(prompt) {
  const p = (prompt || "").toLowerCase();
  const has = (arr) => arr.some((t) => p.includes(t));

  // Vector/anime/illustration logos etc.
  if (has(["anime","manga","chibi","illustration","vector","flat","logo","icon","pixel","isometric","cartoon","comic","cel","toon"]))
    return "sdv1";

  // Photoreal/architecture/product shots
  if (has(["photo","photoreal","realistic","dslr","bokeh","macro","lens","hdr","cinematic","street photography","film","portrait","studio","packshot"]))
    return "flux";

  // Fine art / painterly
  if (has(["oil painting","watercolor","gouache","digital painting","concept art","fantasy","matte painting"]))
    return "sdv1";

  // Default bias to photoreal
  return "flux";
}

/**
 * Choose a model using aggregated token stats, falling back to heuristic.
 * Returns: "flux" | "sdv1"
 *
 * Rationale:
 * - Fetch scores for all tokens in this prompt.
 * - Sum realism vs anime buckets with a tiny inertia so it’s not flip-floppy.
 * - If nothing is found (cold start), fall back to heuristicModel().
 */
export async function chooseModelSmart(prompt) {
  const tokens = tokenizePrompt(prompt);
  if (!tokens.length) return heuristicModel(prompt);

  const { data, error } = await supabase
    .from(TABLE_TOKEN_STATS)
    .select("token, score_realism, score_anime")
    .in("token", tokens);

  if (error) {
    console.warn("[token_stats] select failed:", error);
    return heuristicModel(prompt);
  }
  if (!data || data.length === 0) return heuristicModel(prompt);

  let realism = 0, anime = 0;
  for (const r of data) {
    realism += Number(r.score_realism || 0);
    anime   += Number(r.score_anime   || 0);
  }
  // inertia to avoid hard flips on tiny signals
  realism += 0.5;
  anime   += 0.5;

  return realism >= anime ? "flux" : "sdv1";
}

/**
 * Record a thumbs-up / thumbs-down to `feedback`.
 * Safe with anon key IF you enabled strict RLS insert policy only.
 *
 * @param {{prompt:string, model:'flux'|'sdv1'|string, seed?:number|null, up:boolean}} param0
 * @returns {Promise<boolean>} success
 */
export async function recordVoteGlobal({ prompt, model, seed, up }) {
  const payload = {
    prompt: String(prompt || "").slice(0, 1000),
    model : String(model  || "").slice(0,   64),
    seed  : Number.isFinite(seed) ? seed : null,
    up    : !!up
  };

  const { error } = await supabase.from(TABLE_FEEDBACK).insert(payload);
  if (error) {
    console.warn("[feedback] insert failed:", error);
    return false;
  }
  return true;
}

/**
 * Optional: Ping your Edge Function to update token_stats.
 * This lets your public site learn globally without exposing the service key.
 *
 * Supabase Edge Function: /functions/v1/upsert-token-stats
 * Body: { prompt, model, up }
 *
 * Call this AFTER recordVoteGlobal(...) succeeds.
 *
 * @param {{prompt:string, model:'flux'|'sdv1'|string, up:boolean, edgePath?:string}} args
 * @returns {Promise<boolean>}
 */
export async function updateTokenStatsViaEdge({ prompt, model, up, edgePath = "/functions/v1/upsert-token-stats" }) {
  try {
    const res = await fetch(edgePath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, model, up })
    });
    if (!res.ok) {
      console.warn("[edge] upsert-token-stats failed:", res.status, await safeText(res));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[edge] call error:", e);
    return false;
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

/**
 * (Optional) Read-only helper to inspect top tokens (for dashboards).
 * Requires SELECT on token_stats (granted in RLS policy).
 */
export async function getTopTokens(limit = 50) {
  const { data, error } = await supabase
    .from(TABLE_TOKEN_STATS)
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (error) {
    console.warn("[token_stats] getTopTokens failed:", error);
    return [];
  }
  return data || [];
}

/**
 * Convenience: decide + record pattern.
 * - choose model via DB
 * - return chosen model
 * You can use this before image generation.
 */
export async function pickModelForPrompt(prompt) {
  try {
    return await chooseModelSmart(prompt);
  } catch {
    return heuristicModel(prompt);
  }
}

/**
 * Small utility: classify which bucket a model maps to.
 * Useful if you later add more models (e.g., 'sdv2', 'flux-realism', etc.)
 */
export function modelBucket(model) {
  const m = (model || "").toLowerCase();
  if (m.startsWith("flux")) return "realism";
  if (m.startsWith("sdv"))  return "anime";
  // default: treat unknowns as realism
  return "realism";
}
