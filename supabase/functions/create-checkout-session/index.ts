import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.5.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
// Overridable without a redeploy if the price ever needs to change.
const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID") || "price_1UF1cU1KVP1gc3CC2YiKZ0KO";
// Fallback only used if a request somehow arrives with no Origin header.
const DEFAULT_ORIGIN = "https://alanmatiasavelar.github.io/together-network";

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
  if (userErr || !user || !user.email) return json({ error: "Not authenticated" }, 401);

  if (!STRIPE_SECRET_KEY) {
    return json({ error: "Payments aren't configured yet. Ask the site admin to add a STRIPE_SECRET_KEY." }, 503);
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const origin = req.headers.get("origin") || DEFAULT_ORIGIN;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: user.id,
      metadata: { user_id: user.id },
      success_url: `${origin}/premium.html?checkout=success`,
      cancel_url: `${origin}/premium.html?checkout=cancel`,
    });
    return json({ url: session.url });
  } catch (err) {
    return json({ error: `Could not start checkout: ${(err as Error).message}` }, 500);
  }
});
