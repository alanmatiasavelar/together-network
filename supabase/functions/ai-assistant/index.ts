// supabase/functions/ai-assistant/index.ts
//
// Together — AI project assistant
// ------------------------------------------------------------------
// This is what makes the AI tab work without ever putting your Anthropic
// API key in browser-visible code. It runs on Supabase's servers, not in
// the user's browser.
//
// DEPLOY (one-time setup, needs the Supabase CLI — not just the SQL Editor):
//   1. npm install -g supabase        (or see supabase.com/docs/guides/cli)
//   2. supabase login
//   3. supabase link --project-ref YOUR_PROJECT_REF
//   4. supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-real-key-here
//   5. supabase functions deploy ai-assistant
//
// After that, the site calls it via supabaseClient.functions.invoke(...) —
// no URL or extra config needed on the frontend, the client library builds
// the URL from your existing SUPABASE_URL automatically.
// ------------------------------------------------------------------

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const ANTHROPIC_MODEL = 'claude-sonnet-5';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function callClaude(payload: Record<string, unknown>) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API error (${res.status})`);
  }
  return data;
}

function summarizeProject(
  project: { title?: string; pitch?: string; description?: string },
  goals: Array<{ title: string; description: string | null; progress: number }>,
  reqs: Array<{ title: string; status: string }>,
  tasks: Array<{ title: string; status: string; due_date: string | null }>,
  costs: Array<{ description: string; amount: number; category: string | null }>
) {
  const lines: string[] = [];
  lines.push(`Project: ${project.title ?? ''}`);
  if (project.pitch) lines.push(`Pitch: ${project.pitch}`);
  if (project.description) lines.push(`Description: ${project.description}`);

  lines.push('');
  lines.push(`Goals (${goals.length}):`);
  goals.forEach((g) => lines.push(`- ${g.title} (${g.progress}% complete)${g.description ? ': ' + g.description : ''}`));

  lines.push('');
  lines.push(`Requirements (${reqs.length}):`);
  reqs.forEach((r) => lines.push(`- ${r.title} [${r.status}]`));

  lines.push('');
  lines.push(`Tasks (${tasks.length}):`);
  tasks.forEach((tk) => lines.push(`- ${tk.title} [${tk.status}]${tk.due_date ? ', due ' + tk.due_date : ''}`));

  lines.push('');
  const total = costs.reduce((s, c) => s + Number(c.amount || 0), 0);
  lines.push(`Costs (${costs.length} items, total $${total.toFixed(2)}):`);
  costs.forEach((c) => lines.push(`- ${c.description}: $${Number(c.amount).toFixed(2)}${c.category ? ' (' + c.category + ')' : ''}`));

  return lines.join('\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY is not set. Run: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  // Deliberately read the caller's own API key straight off THIS request's
  // headers, rather than from Deno.env.get('SUPABASE_ANON_KEY') or
  // SUPABASE_PUBLISHABLE_KEY(S). Supabase has documented cases where those
  // auto-injected env vars lag behind a project's actual current key after
  // migrating between legacy and publishable/secret key formats — reading
  // the key the browser is already successfully using sidesteps that
  // entirely, and works the same regardless of which key format you're on.
  const apiKeyHeader = req.headers.get('apikey');
  if (!authHeader || !apiKeyHeader) {
    return json({ error: 'Missing Authorization or apikey header.' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabase = createClient(supabaseUrl, apiKeyHeader, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return json({ error: 'Not authenticated.' }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const { action, projectId } = body;
  if (!projectId) {
    return json({ error: 'projectId is required.' }, 400);
  }

  // Re-verify team membership server-side. The client only ever shows this
  // tab to team members, but a client-side check is a UI courtesy, not
  // security — this call re-checks against the database's own rules, using
  // the same is_project_team_member() function the RLS policies use.
  const { data: isTeamMember, error: teamCheckError } = await supabase.rpc('is_project_team_member', {
    p_project_id: projectId,
  });
  if (teamCheckError || !isTeamMember) {
    return json({ error: 'You are not part of this project.' }, 403);
  }

  try {
    if (action === 'chat') {
      const { messages } = body;
      if (!Array.isArray(messages) || messages.length === 0) {
        return json({ error: 'messages array is required.' }, 400);
      }

      const [{ data: project }, { data: goals }, { data: reqs }, { data: tasks }, { data: costs }] = await Promise.all([
        supabase.from('projects').select('title, pitch, description').eq('id', projectId).single(),
        supabase.from('project_goals').select('title, description, progress').eq('project_id', projectId),
        supabase.from('project_requirements').select('title, status').eq('project_id', projectId),
        supabase.from('project_tasks').select('title, status, due_date').eq('project_id', projectId),
        supabase.from('project_costs').select('description, amount, category').eq('project_id', projectId),
      ]);

      const contextSummary = summarizeProject(project || {}, goals || [], reqs || [], tasks || [], costs || []);

      const claudeData = await callClaude({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system:
          'You are the project assistant for this Together project. Use the data below to answer questions and help with decisions. Be concise. Only state facts that are actually present in this data — if something is not covered, say so rather than guessing.\n\n' +
          contextSummary,
        messages,
      });

      const reply = claudeData.content?.find((b: any) => b.type === 'text')?.text || '';
      return json({ reply });
    }

    if (action === 'scan_receipt') {
      const { imageBase64, mediaType } = body;
      if (!imageBase64 || !mediaType) {
        return json({ error: 'imageBase64 and mediaType are required.' }, 400);
      }

      const claudeData = await callClaude({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system:
          'You extract itemized cost line items from receipt or invoice images. Respond with ONLY a JSON array, no other text, no markdown fences. Each item: {"description": string, "amount": number, "date": "YYYY-MM-DD" or null, "category": string or null}. If nothing is readable, respond with [].',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
              { type: 'text', text: 'Extract the line items from this receipt or invoice.' },
            ],
          },
        ],
      });

      const text = claudeData.content?.find((b: any) => b.type === 'text')?.text || '[]';
      let items: any[] = [];
      try {
        items = JSON.parse(text.trim());
        if (!Array.isArray(items)) items = [];
      } catch {
        items = [];
      }
      return json({ items });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
