// supabase.js
// Lightweight client + helpers for model choice and feedback capture

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** ======= YOUR PROJECT (already filled) ======= */
export const SUPABASE_URL =
    "https://dorwbvdfcqhysybleytx.supabase.co";
export const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRvcndidmRmY3FoeXN5YmxleXR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIxODUwNTksImV4cCI6MjA3Nzc2MTA1OX0.1IlqlQCVDgXzH6bQoNSYkdYETmKv_3HyGm9WduwaqnM";
/** ============================================ */

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Table names (keep consistent with SQL below) */
export const TABLE_TOKEN_STATS = "token_stats"; // token PK, score_realism, score_anime, updated_at
export const TABLE_FEEDBACK = "feedback";     // id, prompt, model, seed, up, created_at

/** --- Tiny tokenizer --- */
function tokenizePrompt(p) {
    return (p || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((x) => x && x.length > 2)
        .slice(0, 40);
}

/** --- Heuristic fallback (when DB has no signal yet) --- */
function heuristicModel(prompt) {
    const p = (prompt || "").toLowerCase();
    const has = (arr) => arr.some((t) => p.includes(t));

    if (has(["anime", "manga", "chibi", "illustration", "vector", "logo", "icon", "pixel", "isometric", "cartoon", "comic"]))
        return "sdv1";

    if (has(["photo", "photoreal", "dslr", "bokeh", "macro", "lens", "hdr", "cinematic", "street photography"]))
        return "flux";

    if (has(["architecture", "interior", "exterior", "product render", "studio light", "packshot"]))
        return "flux";

    if (has(["oil painting", "watercolor", "gouache", "digital painting", "concept art", "fantasy"]))
        return "sdv1";

    return "flux";
}

/**
 * Choose a model using aggregated token stats, falling back to heuristic.
 * Returns one of: "flux" | "sdv1" (extend as you add models).
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
    if (!data || !data.length) return heuristicModel(prompt);

    let realism = 0, anime = 0;
    for (const r of data) {
        realism += Number(r.score_realism || 0);
        anime += Number(r.score_anime || 0);
    }
    // small inertia so we don’t flip hard with tiny signals
    realism += 0.5;
    anime += 0.5;

    return realism >= anime ? "flux" : "sdv1";
}

/**
 * Record a single thumbs-up / thumbs-down from your UI.
 * Safe to call from the browser with anon key (RLS limits to insert-only).
 */
export async function recordVoteGlobal({ prompt, model, seed, up }) {
    const payload = {
        prompt: String(prompt || "").slice(0, 1000),
        model: String(model || "").slice(0, 64),
        seed: Number.isFinite(seed) ? seed : null,
        up: !!up
    };

    const { error } = await supabase.from(TABLE_FEEDBACK).insert(payload);
    if (error) {
        console.warn("[feedback] insert failed:", error);
        return false;
    }
    return true;
}

/**
 * (Optional) Read-only helper to inspect top tokens (for dashboards).
 * Requires SELECT on token_stats (granted in RLS below).
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
    return data;
}
