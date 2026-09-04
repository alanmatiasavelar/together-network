/* ====================================================================
   Together — shared config
   This is the ONLY file that needs your Supabase values.
   Every page (index, login, signup, feed) loads this file, so you only
   ever edit them here — not in four different places.
   ==================================================================== */
const SUPABASE_URL = "https://pjkdnadlcmnmvoyqbtpk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_RL_-FCEJ8FWmZKb_malW5g_ZoBEVJAL";
const PAYPAL_CLIENT_ID = "YOUR_PAYPAL_CLIENT_ID";
/* ==================================================================== */

const isPaypalConfigured = !PAYPAL_CLIENT_ID.includes('YOUR_');

const isConfigured = !SUPABASE_URL.includes('YOUR_') && !SUPABASE_ANON_KEY.includes('YOUR_');

// window.supabase is the library (loaded via the jsDelivr <script> tag on each page).
// supabaseClient is OUR connected client. Kept separate on purpose so we never
// accidentally shadow the library itself.
let supabaseClient = null;

if (isConfigured) {
  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } else {
      console.error('Together: the Supabase library did not load (blocked script, offline, or ad blocker) — running in demo mode.');
    }
  } catch (err) {
    console.error('Together: could not start the Supabase client — running in demo mode.', err);
  }
}

function escapeHTML(s){
  return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function initials(name){
  return (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase();
}
const catLabel = { community:'Community', tech:'Tech', 'social-impact':'Social impact', business:'Business', creative:'Creative', other:'Other' };
const WHATSAPP_LINK_PATTERN = /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+$/;
const DRIVE_LINK_PATTERN = /^https:\/\/(www\.)?drive\.google\.com\/drive\/(u\/\d+\/)?folders\/[A-Za-z0-9_-]+(\?.*)?$/;

function extractYoutubeId(url){
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function youtubeEmbedHTML(url){
  const id = extractYoutubeId(url);
  if (!id) return '';
  return `<div class="yt-embed"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="Project video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
}

/* Small helper every page uses to show/hide the "connect your database" banner. */
function showConfigBannerIfNeeded(){
  const banner = document.getElementById('configBanner');
  if (banner && !supabaseClient) banner.hidden = false;
  const dismiss = document.getElementById('dismissBanner');
  if (dismiss) dismiss.addEventListener('click', () => { banner.hidden = true; });
}
