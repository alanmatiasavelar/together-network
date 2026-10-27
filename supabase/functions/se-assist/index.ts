import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildPrompt, parseResult, TASKS, type Ctx, type Task } from "./logic.ts";

// AI help for the Systems Engineering tabs: suggests requirements, rewrites one, reviews the set,
// proposes a first architecture, or drafts a use case. It only ever RETURNS proposals; nothing is
// written to the project here, the browser applies a proposal only when the user clicks.
//
// Not a general chat: the model is asked for one strict JSON shape per task, and logic.ts validates it.
// Project content reaches the model as clearly delimited data, and users can only trigger it for
// projects they belong to (membership is re-checked here, not trusted from the browser).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash";
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 12;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

const code = (n: number) => "REQ-" + String(n).padStart(3, "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json({ error: "Not authenticated" }, 401);

  let body: { project_id?: string; task?: string; lang?: string; payload?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const projectId = body.project_id;
  const task = body.task as Task;
  if (!projectId || !(TASKS as readonly string[]).includes(task)) return json({ error: "project_id and a valid task are required" }, 400);
  const lang = ["en", "es", "fr", "pt"].includes(String(body.lang)) ? String(body.lang) : "en";
  const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

  const { data: isMember, error: memberErr } = await userClient.rpc("is_project_team_member", { p_project_id: projectId });
  if (memberErr || !isMember) return json({ error: "You're not a member of this project" }, 403);

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count: recent } = await db.from("ai_assist_log").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since);
  if ((recent || 0) >= RATE_MAX) return json({ error: "You're using the AI help too fast. Please wait a few minutes and try again." }, 429);

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) return json({ error: "The AI assistant isn't configured yet. Ask the site admin to add a GEMINI_API_KEY." }, 503);

  // ---- Gather the project context from the database (never from the browser's copy) ----
  const [{ data: project }, { data: reqRows }, { data: diagrams }] = await Promise.all([
    db.from("projects").select("title, pitch, description, category").eq("id", projectId).single(),
    db.from("project_requirements").select("id, req_number, title, description, status, links").eq("project_id", projectId).order("req_number"),
    db.from("project_diagrams").select("type, data").eq("project_id", projectId).in("type", ["usecases", "architecture"]),
  ]);
  if (!project) return json({ error: "Project not found" }, 404);
  const nodesOf = (type: string, kind: string) =>
    ((diagrams || []).find((d) => d.type === type)?.data?.nodes || []).filter((n: { kind: string }) => n.kind === kind);
  const ucNodes = nodesOf("usecases", "usecase"), blockNodes = nodesOf("architecture", "block");
  const nameById = new Map<string, string>([...ucNodes, ...blockNodes].map((n: { id: string; label: string }) => [n.id, n.label]));

  const ctx: Ctx = {
    project: { title: project.title, pitch: project.pitch || "", description: project.description || "", category: project.category || "" },
    requirements: (reqRows || []).map((r) => {
      const links = Array.isArray(r.links) ? r.links : [];
      const names = (t: string) => links.filter((l: { t: string }) => l.t === t).map((l: { id: string }) => nameById.get(l.id)).filter(Boolean) as string[];
      return { code: code(r.req_number), title: r.title, description: r.description || "", status: r.status, useCases: names("usecases"), blocks: names("architecture") };
    }),
    useCases: ucNodes.map((n: { label: string; detail?: { desc?: string; steps?: string } }) => ({
      name: n.label, description: n.detail?.desc || "", steps: String(n.detail?.steps || "").split("\n").map((s) => s.trim()).filter(Boolean),
    })),
    blocks: blockNodes.map((n: { label: string; sublabel?: string }) => ({ name: n.label, description: n.sublabel || "" })),
  };

  // ---- Task-specific target ----
  let target: Parameters<typeof buildPrompt>[3];
  if (task === "improve_requirement") {
    const r = (reqRows || []).find((x) => x.id === payload.requirement_id);
    if (!r) return json({ error: "Requirement not found" }, 404);
    target = { code: code(r.req_number), title: r.title, description: r.description || "" };
  } else if (task === "draft_use_case") {
    const name = String(payload.name || "").slice(0, 100);
    if (!name) return json({ error: "A use case name is required" }, 400);
    target = { name, description: String(payload.description || "").slice(0, 400) };
  }

  await db.from("ai_assist_log").insert({ project_id: projectId, user_id: user.id, task });

  const prompt = buildPrompt(task, ctx, lang, target);
  let replyText = "";
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.4 } }),
    });
    const g = await resp.json();
    if (!resp.ok) return json({ error: `The AI service had a problem: ${g?.error?.message || resp.statusText}` }, 502);
    replyText = g?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
  } catch (err) {
    return json({ error: `The AI service is unreachable right now (${(err as Error).message}).` }, 502);
  }

  const result = parseResult(task, replyText);
  if (!result) return json({ error: "The AI reply couldn't be understood. Please try again." }, 502);
  return json({ task, result });
});
