import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_MODEL = "gemini-2.0-flash";
const MAX_MESSAGE_LEN = 2000;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const HISTORY_LIMIT = 20;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);

  let body: { project_id?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const projectId = body.project_id;
  const message = (body.message || "").trim();
  if (!projectId || !message) return json({ error: "project_id and message are required" }, 400);
  if (message.length > MAX_MESSAGE_LEN) return json({ error: `Message too long (max ${MAX_MESSAGE_LEN} characters)` }, 400);

  // Re-verify team membership server-side, independent of anything the client claims.
  const { data: isMember, error: memberErr } = await userClient.rpc("is_project_team_member", { p_project_id: projectId });
  if (memberErr || !isMember) return json({ error: "You're not a member of this project" }, 403);

  // All writes go through the service-role client from here on — clients have no
  // insert policy on project_ai_messages, only this function does.
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count: recentCount } = await serviceClient
    .from("project_ai_messages")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("role", "user")
    .gte("created_at", since);
  if ((recentCount || 0) >= RATE_LIMIT_MAX) {
    return json({ error: "You're sending messages too fast — please wait a few minutes and try again." }, 429);
  }

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) {
    return json({ error: "The AI assistant isn't configured yet. Ask the site admin to add a GEMINI_API_KEY." }, 503);
  }

  const { data: history } = await serviceClient
    .from("project_ai_messages")
    .select("role, content")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(HISTORY_LIMIT);

  const { error: insertUserErr } = await serviceClient.from("project_ai_messages").insert({
    project_id: projectId, user_id: user.id, role: "user", content: message,
  });
  if (insertUserErr) return json({ error: insertUserErr.message }, 500);

  const contents = [
    ...(history || []).map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] })),
    { role: "user", parts: [{ text: message }] },
  ];

  let replyText: string;
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({ contents }),
      },
    );
    const geminiJson = await resp.json();
    if (!resp.ok) {
      replyText = `Sorry, the AI assistant had a problem: ${geminiJson?.error?.message || resp.statusText}`;
    } else {
      replyText = geminiJson?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "Sorry, I couldn't generate a response.";
    }
  } catch (err) {
    replyText = `Sorry, the AI assistant is unreachable right now (${(err as Error).message}).`;
  }

  const { error: insertAiErr } = await serviceClient.from("project_ai_messages").insert({
    project_id: projectId, user_id: user.id, role: "assistant", content: replyText,
  });
  if (insertAiErr) return json({ error: insertAiErr.message }, 500);

  return json({ reply: replyText });
});
