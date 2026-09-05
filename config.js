/* ====================================================================
   Together — shared config
   This is the ONLY file that needs your Supabase values.
   Every page (index, login, signup, feed) loads this file, so you only
   ever edit them here — not in four different places.
   ==================================================================== */
const SUPABASE_URL = "https://pjkdnadlcmnmvoyqbtpk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_RL_-FCEJ8FWmZKb_malW5g_ZoBEVJAL";
/* ==================================================================== */

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

/* ====================================================================
   Image compression — shrinks photos client-side before upload (max 1600px
   on the long edge, re-encoded as JPEG) to save storage and load faster.
   Fails open: any error, unsupported browser, or file that's already small
   just returns the original file untouched, so uploads never break because
   of this. Don't use this on QR codes — lossy re-encoding can blur the fine
   modules enough to make them unscannable.
   ==================================================================== */
async function compressImage(file, { maxDim = 1600, quality = 0.82 } = {}){
  if (!file || !file.type || !file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  if (file.size < 350 * 1024) return file; // already small; not worth re-encoding
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const targetW = Math.max(1, Math.round(bitmap.width * scale));
    const targetH = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file; // compression didn't actually help
    const newName = (file.name || 'image').replace(/\.[a-zA-Z0-9]+$/, '') + '.jpg';
    return new File([blob], newName, { type: 'image/jpeg' });
  } catch (err) {
    console.warn('Together: image compression skipped, uploading original.', err);
    return file;
  }
}

/* Small helper every page uses to show/hide the "connect your database" banner. */
function showConfigBannerIfNeeded(){
  const banner = document.getElementById('configBanner');
  if (banner && !supabaseClient) banner.hidden = false;
  const dismiss = document.getElementById('dismissBanner');
  if (dismiss) dismiss.addEventListener('click', () => { banner.hidden = true; });
}

/* ====================================================================
   Notifications — shared bell icon + dropdown, used by every page that
   has a logged-in nav state. Call initNotifications(user) once you know
   who's signed in (or null to tear it down on sign-out).
   ==================================================================== */
let notifChannel = null;

async function fetchNotifications(userId){
  const [{ count }, { data: items }] = await Promise.all([
    supabaseClient.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('read', false),
    supabaseClient.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(15)
  ]);
  return { count: count || 0, items: items || [] };
}

function notifItemHTML(n){
  return `
    <a class="notif-item ${n.read ? '' : 'unread'}" href="${escapeHTML(n.link || '#')}" data-notif-id="${n.id}">
      <div class="notif-item-title">${escapeHTML(n.title)}</div>
      ${n.body ? `<div class="notif-item-body">${escapeHTML(n.body)}</div>` : ''}
    </a>
  `;
}

async function refreshNotifBell(userId){
  const { count, items } = await fetchNotifications(userId);
  const badge = document.getElementById('notifBadge');
  if (badge){
    if (count > 0){ badge.hidden = false; badge.textContent = count > 9 ? '9+' : String(count); }
    else badge.hidden = true;
  }
  const list = document.getElementById('notifList');
  if (list){
    list.innerHTML = items.length ? items.map(notifItemHTML).join('') : `<p class="notif-empty">${t('notif.empty')}</p>`;
  }
}

function teardownNotifications(){
  const slot = document.getElementById('notifSlot');
  if (slot) slot.innerHTML = '';
  if (notifChannel && supabaseClient){ supabaseClient.removeChannel(notifChannel); notifChannel = null; }
}

async function initNotifications(user){
  const slot = document.getElementById('notifSlot');
  if (!slot) return;
  if (!supabaseClient || !user){ teardownNotifications(); return; }

  slot.innerHTML = `
    <div class="notif-wrap">
      <button class="notif-bell" id="notifBellBtn" aria-label="Notifications" type="button">
        🔔<span class="notif-badge" id="notifBadge" hidden>0</span>
      </button>
      <div class="notif-dropdown" id="notifDropdown" hidden>
        <div class="notif-dropdown-head">
          <span>${t('notif.heading')}</span>
          <button class="icon-btn" id="notifMarkAllBtn" type="button">${t('notif.mark_all_read')}</button>
        </div>
        <div id="notifList"><p class="notif-empty">${t('common.loading')}</p></div>
      </div>
    </div>
  `;

  await refreshNotifBell(user.id);

  const bellBtn = document.getElementById('notifBellBtn');
  const dropdown = document.getElementById('notifDropdown');
  bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.hidden && !dropdown.contains(e.target) && e.target !== bellBtn) dropdown.hidden = true;
  });
  document.getElementById('notifList').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-notif-id]');
    if (!item) return;
    await supabaseClient.from('notifications').update({ read: true }).eq('id', item.dataset.notifId);
    refreshNotifBell(user.id);
  });
  document.getElementById('notifMarkAllBtn').addEventListener('click', async () => {
    await supabaseClient.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
    refreshNotifBell(user.id);
  });

  if (notifChannel) supabaseClient.removeChannel(notifChannel);
  notifChannel = supabaseClient
    .channel(`notifications-${user.id}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}`
    }, () => refreshNotifBell(user.id))
    .subscribe();
}
