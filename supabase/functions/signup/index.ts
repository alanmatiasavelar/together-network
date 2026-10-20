import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sign-up with a grace period for the email-confirmation limit.
//
// Not JWT-protected (the caller has no account yet). It first tries the normal
// Supabase sign-up. ONLY if Supabase reports that the hourly email limit is
// exhausted does it create the account anyway (usable immediately) and record
// it in email_confirmation_backlog with a 7-day deadline. See
// supabase/migrations/email_confirmation_backlog.sql for the full design and
// its security trade-offs.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const MAX_GRACE_PER_HOUR = 20;
const MAX_PENDING_TOTAL = 300;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ mode: "error", message: "Method not allowed" }, 405);

  let input: { email?: string; password?: string; display_name?: string };
  try { input = await req.json(); } catch { return json({ mode: "error", message: "Invalid request" }, 400); }

  const email = String(input.email ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const displayName = String(input.display_name ?? "").trim().slice(0, 80) || email.split("@")[0];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ mode: "error", message: "Please enter a valid email address." });
  if (password.length < 6 || password.length > 72) return json({ mode: "error", message: "Password must be between 6 and 72 characters." });

  // 1) Normal sign-up (sends the confirmation email).
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, data: { display_name: displayName } }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    if (body.access_token) return json({ mode: "session", access_token: body.access_token, refresh_token: body.refresh_token });
    return json({ mode: "confirm" });
  }
  const emailLimitHit = res.status === 429 && body.error_code === "over_email_send_rate_limit";
  if (!emailLimitHit) return json({ mode: "error", message: body.msg || body.error_description || body.message || "Sign-up failed.", code: body.error_code });

  // 2) Email limit exhausted -> grace-period account, with caps against abuse.
  const since = new Date(Date.now() - 3600_000).toISOString();
  const [{ count: recent }, { count: pending }] = await Promise.all([
    admin.from("email_confirmation_backlog").select("user_id", { count: "exact", head: true }).gte("created_at", since),
    admin.from("email_confirmation_backlog").select("user_id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  if ((recent ?? 0) >= MAX_GRACE_PER_HOUR || (pending ?? 0) >= MAX_PENDING_TOTAL) return json({ mode: "busy" });

  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: displayName },
  });
  if (error || !data?.user) {
    if (error && (error.status === 422 || /already|exists|registered/i.test(error.message))) return json({ mode: "exists" });
    return json({ mode: "error", message: error?.message || "Sign-up failed." });
  }
  // The account is confirmed in Supabase terms, so it MUST have a backlog row (that's what makes it expire).
  const { error: insertError } = await admin.from("email_confirmation_backlog").insert({ user_id: data.user.id, email });
  if (insertError) {
    await admin.auth.admin.deleteUser(data.user.id);
    return json({ mode: "error", message: "Sign-up failed. Please try again." });
  }
  return json({ mode: "grace" });
});
