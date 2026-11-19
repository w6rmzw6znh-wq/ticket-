// Scratch Club - Cloudflare Worker
// Full stack: Discord OAuth, Wallet, Scratch tickets, Admin

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS for safety
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // Serve frontend
    if (path === '/' || path === '/index.html') {
      return new Response(getFrontendHTML(env), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', ...corsHeaders }
      });
    }

    // API routes
    if (path.startsWith('/api/')) {
      return handleAPI(request, env, path, corsHeaders);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }
};

async function handleAPI(request, env, path, corsHeaders) {
  const method = request.method;
  const url = new URL(request.url);

  try {
    // Auth
    if (path === '/api/auth/login') {
      const redirectUri = `${url.origin}/api/auth/callback`;
      const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20guilds`;
      return Response.redirect(authUrl, 302);
    }

    if (path === '/api/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('No code', { status: 400 });

      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${url.origin}/api/auth/callback`
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return new Response('Auth failed', { status: 400 });

      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const user = await userRes.json();

      // Check guild membership
      const guildsRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const guilds = await guildsRes.json();
      const inGuild = guilds.some(g => g.id === env.GUILD_ID);
      if (!inGuild) return new Response('Vous devez être membre du serveur Discord.', { status: 403 });

      // Upsert user
      await env.DB.prepare(`
        INSERT INTO users (discord_id, username, avatar, balance)
        VALUES (?, ?, ?, 50000)
        ON CONFLICT(discord_id) DO UPDATE SET username = ?, avatar = ?
      `).bind(user.id, user.username, user.avatar, user.username, user.avatar).run();

      // Simple session cookie (in production use signed JWT)
      const session = btoa(JSON.stringify({ id: user.id, exp: Date.now() + 86400000 }));
      return new Response(null, {
        status: 302,
        headers: {
          'Set-Cookie': `session=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
          Location: '/'
        }
      });
    }

    if (path === '/api/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { 'Set-Cookie': 'session=; Path=/; Max-Age=0', Location: '/' }
      });
    }

    // Get current user from cookie
    const cookie = request.headers.get('Cookie') || '';
    const sessionMatch = cookie.match(/session=([^;]+)/);
    if (!sessionMatch) return json({ error: 'Non connecté' }, 401, corsHeaders);
    let session;
    try { session = JSON.parse(atob(sessionMatch[1])); } catch { return json({ error: 'Session invalide' }, 401, corsHeaders); }
    if (session.exp < Date.now()) return json({ error: 'Session expirée' }, 401, corsHeaders);

    const userId = session.id;
    const isAdmin = userId === env.ADMIN_DISCORD_ID;

    // User info
    if (path === '/api/me' && method === 'GET') {
      const user = await env.DB.prepare('SELECT * FROM users WHERE discord_id = ?').bind(userId).first();
      if (!user || user.is_banned) return json({ error: 'Compte suspendu ou inexistant' }, 403, corsHeaders);
      const freeLeft = Math.max(0, (user.last_free_ticket + 86400) - Math.floor(Date.now()/1000));
      return json({ ...user, free_cooldown: freeLeft, is_admin: isAdmin }, 200, corsHeaders);
    }

    // Tickets configs
    if (path === '/api/tickets' && method === 'GET') {
      const configs = await env.DB.prepare('SELECT type, price, enabled, name, color, free_cooldown FROM ticket_configs WHERE enabled = 1').all();
      return json(configs.results, 200, corsHeaders);
    }

    // Buy ticket
    if (path === '/api/buy' && method === 'POST') {
      const body = await request.json();
      const type = body.type;
      const config = await env.DB.prepare('SELECT * FROM ticket_configs WHERE type = ? AND enabled = 1').bind(type).first();
      if (!config) return json({ error: 'Ticket indisponible' }, 400, corsHeaders);

      const user = await env.DB.prepare('SELECT * FROM users WHERE discord_id = ?').bind(userId).first();
      if (user.is_banned) return json({ error: 'Compte suspendu' }, 403, corsHeaders);

      // Free ticket check
      if (type === 'free') {
        const now = Math.floor(Date.now()/1000);
        if (user.last_free_ticket + config.free_cooldown > now) {
          return json({ error: 'Ticket gratuit pas encore disponible', cooldown: user.last_free_ticket + config.free_cooldown - now }, 400, corsHeaders);
        }
      }

      if (user.balance < config.price) return json({ error: 'Jetons insuffisants' }, 400, corsHeaders);

      // Generate result server-side with crypto
      const probs = JSON.parse(config.probabilities);
      const prize = generatePrize(probs);

      // Atomic transaction
      const tx = await env.DB.batch([
        env.DB.prepare('UPDATE users SET balance = balance - ? WHERE discord_id = ? AND balance >= ?').bind(config.price, userId, config.price),
        env.DB.prepare('INSERT INTO tickets (user_id, type, price, prize_amount, prize_type, prize_data) VALUES (?, ?, ?, ?, ?, ?)').bind(userId, type, config.price, prize.amount, prize.type, prize.data || null),
        env.DB.prepare('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').bind(userId, -config.price, 'purchase', `Achat ${config.name}`),
        type === 'free' ? env.DB.prepare('UPDATE users SET last_free_ticket = ? WHERE discord_id = ?').bind(Math.floor(Date.now()/1000), userId) : env.DB.prepare('SELECT 1')
      ]);

      if (tx[0].meta.changes === 0) return json({ error: 'Transaction échouée (solde)' }, 400, corsHeaders);

      const ticketId = tx[1].meta.last_row_id;
      return json({ success: true, ticket_id: ticketId, prize_hidden: true }, 200, corsHeaders);
    }

    // Get ticket for scratching (return prize only after? No, client gets after scratch complete, but we can return masked)
    if (path.startsWith('/api/ticket/') && method === 'GET') {
      const id = path.split('/')[3];
      const ticket = await env.DB.prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ?').bind(id, userId).first();
      if (!ticket) return json({ error: 'Ticket non trouvé' }, 404, corsHeaders);
      // Don't reveal prize until scratched
      const safe = { ...ticket, prize_amount: ticket.is_scratched ? ticket.prize_amount : null, prize_type: ticket.is_scratched ? ticket.prize_type : null };
      return json(safe, 200, corsHeaders);
    }

    // Claim / complete scratch
    if (path === '/api/scratch' && method === 'POST') {
      const body = await request.json();
      const ticketId = body.ticket_id;
      const ticket = await env.DB.prepare('SELECT * FROM tickets WHERE id = ? AND user_id = ? AND is_scratched = 0').bind(ticketId, userId).first();
      if (!ticket) return json({ error: 'Ticket déjà gratté ou invalide' }, 400, corsHeaders);

      // Mark scratched and credit if win
      const updates = [
        env.DB.prepare('UPDATE tickets SET is_scratched = 1, scratched_at = ? WHERE id = ?').bind(Math.floor(Date.now()/1000), ticketId),
        env.DB.prepare('UPDATE users SET tickets_scratched = tickets_scratched + 1 WHERE discord_id = ?').bind(userId)
      ];

      if (ticket.prize_amount > 0 && ticket.prize_type === 'tokens') {
        updates.push(
          env.DB.prepare('UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?').bind(ticket.prize_amount, ticket.prize_amount, userId),
          env.DB.prepare('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').bind(userId, ticket.prize_amount, 'win', `Gain ticket ${ticket.type}`)
        );
      }

      // Special role
      if (ticket.prize_type === 'special' || ticket.prize_type === 'role') {
        // Assign role via bot (async, log error if fail)
        assignDiscordRole(env, userId, ticket.prize_data || env.SPECIAL_ROLE_ID || 'ROLE_SPECIAL').catch(console.error);
        updates.push(
          env.DB.prepare('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').bind(userId, 0, 'role', `Rôle spécial attribué`)
        );
      }

      await env.DB.batch(updates);

      return json({ success: true, prize: { type: ticket.prize_type, amount: ticket.prize_amount, data: ticket.prize_data } }, 200, corsHeaders);
    }

    // History
    if (path === '/api/history' && method === 'GET') {
      const tickets = await env.DB.prepare('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all();
      const txs = await env.DB.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').bind(userId).all();
      return json({ tickets: tickets.results, transactions: txs.results }, 200, corsHeaders);
    }

    // Leaderboard
    if (path === '/api/leaderboard' && method === 'GET') {
      const leaders = await env.DB.prepare('SELECT username, avatar, total_won, tickets_scratched FROM users WHERE is_banned = 0 ORDER BY total_won DESC LIMIT 20').all();
      return json(leaders.results, 200, corsHeaders);
    }

    // Admin routes
    if (path.startsWith('/api/admin/') && !isAdmin) return json({ error: 'Accès refusé' }, 403, corsHeaders);

    if (path === '/api/admin/users' && method === 'GET') {
      const users = await env.DB.prepare('SELECT discord_id, username, balance, is_banned, total_won, tickets_scratched FROM users ORDER BY created_at DESC LIMIT 100').all();
      return json(users.results, 200, corsHeaders);
    }

    if (path === '/api/admin/adjust' && method === 'POST') {
      const body = await request.json();
      const { target_id, amount, reason } = body;
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET balance = balance + ? WHERE discord_id = ?').bind(amount, target_id),
        env.DB.prepare('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)').bind(target_id, amount, 'admin', reason || 'Ajustement admin'),
        env.DB.prepare('INSERT INTO admin_logs (admin_id, action, details) VALUES (?, ?, ?)').bind(userId, 'adjust_balance', JSON.stringify({ target_id, amount, reason }))
      ]);
      return json({ success: true }, 200, corsHeaders);
    }

    // More admin endpoints can be added similarly (ban, config edit, etc.)

    return json({ error: 'Route inconnue' }, 404, corsHeaders);
  } catch (e) {
    console.error(e);
    return json({ error: 'Erreur serveur' }, 500, corsHeaders);
  }
}

function generatePrize(probs) {
  const rand = crypto.getRandomValues(new Uint32Array(1))[0] / 0xFFFFFFFF * 100;
  let cum = 0;
  for (const p of probs) {
    cum += p.chance;
    if (rand < cum) {
      return { type: p.type, amount: p.amount || 0, data: p.data || null };
    }
  }
  return { type: 'none', amount: 0 };
}

async function assignDiscordRole(env, userId, roleId) {
  if (!env.DISCORD_BOT_TOKEN || !env.GUILD_ID) return;
  try {
    await fetch(`https://discord.com/api/guilds/${env.GUILD_ID}/members/${userId}/roles/${roleId}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
    });
  } catch (e) {
    console.error('Role assign failed', e);
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function getFrontendHTML(env) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SCRATCH CLUB 🎟️</title>
<style>
:root { --gold: #FFD700; --dark: #0a0a0a; --card: #1a1a1a; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--dark); color: #fff; font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }
.header { background: linear-gradient(90deg, #000, #1a1a1a); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--gold); }
.logo { font-size: 1.8rem; font-weight: bold; color: var(--gold); text-shadow: 0 0 10px var(--gold); }
.user-info { display: flex; align-items: center; gap: 1rem; }
.avatar { width: 40px; height: 40px; border-radius: 50%; border: 2px solid var(--gold); }
.balance { background: #222; padding: 0.5rem 1rem; border-radius: 20px; border: 1px solid var(--gold); }
.nav { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 1rem; }
.btn { background: linear-gradient(45deg, #222, #333); color: var(--gold); border: 1px solid var(--gold); padding: 0.8rem 1.5rem; border-radius: 8px; cursor: pointer; transition: all 0.3s; font-weight: bold; }
.btn:hover { background: var(--gold); color: #000; transform: translateY(-2px); box-shadow: 0 5px 15px rgba(255,215,0,0.4); }
.container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
.tickets-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin: 2rem 0; }
.ticket-card { background: var(--card); border-radius: 15px; padding: 1.5rem; text-align: center; border: 2px solid #333; transition: all 0.3s; position: relative; overflow: hidden; }
.ticket-card:hover { border-color: var(--gold); transform: translateY(-5px); box-shadow: 0 10px 30px rgba(255,215,0,0.2); }
.ticket-card h3 { color: var(--gold); margin-bottom: 0.5rem; }
.price { font-size: 1.5rem; font-weight: bold; margin: 1rem 0; }
.scratch-container { position: relative; width: 100%; max-width: 400px; margin: 2rem auto; background: #111; border-radius: 15px; overflow: hidden; border: 3px solid var(--gold); }
canvas { display: block; width: 100%; height: auto; cursor: crosshair; touch-action: none; }
.result-overlay { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; font-size: 2rem; font-weight: bold; color: var(--gold); text-shadow: 0 0 20px var(--gold); pointer-events: none; opacity: 0; transition: opacity 0.5s; }
.modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 100; justify-content: center; align-items: center; }
.modal.active { display: flex; }
.login-btn { background: #5865F2; color: white; padding: 1rem 2rem; border-radius: 8px; font-size: 1.2rem; border: none; cursor: pointer; }
.stats, .history, .leaderboard, .admin { background: var(--card); padding: 1.5rem; border-radius: 15px; margin: 1rem 0; }
@media (max-width: 600px) { .header { flex-direction: column; gap: 1rem; } .nav { justify-content: center; } }
</style>
</head>
<body>
<div id="app">
  <div class="header">
    <div class="logo">🎟️ SCRATCH CLUB</div>
    <div id="user-area"></div>
  </div>
  <div class="nav" id="nav"></div>
  <div class="container" id="content"></div>
</div>
<div id="scratch-modal" class="modal">
  <div class="scratch-container">
    <div id="result-text" class="result-overlay"></div>
    <canvas id="scratch-canvas"></canvas>
  </div>
  <button class="btn" id="finish-scratch" style="margin-top:1rem;">Terminer le grattage</button>
  <button class="btn" onclick="closeScratch()">Fermer</button>
</div>
<script>
let currentUser = null;
let currentTicketId = null;
let scratchedPercent = 0;
const canvas = document.getElementById('scratch-canvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', ...options });
  if (res.status === 401) { showLogin(); return null; }
  return res.json();
}

async function loadUser() {
  currentUser = await api('/api/me');
  if (currentUser) renderHeader();
  else showLogin();
}

function showLogin() {
  document.getElementById('content').innerHTML = '<div style="text-align:center;margin-top:5rem;"><h1 style="color:var(--gold);">Bienvenue sur SCRATCH CLUB</h1><p>Connectez-vous avec Discord pour jouer</p><br><button class="login-btn" onclick="location.href=\\'/api/auth/login\\'">Se connecter avec Discord</button></div>';
  document.getElementById('nav').innerHTML = '';
  document.getElementById('user-area').innerHTML = '';
}

function renderHeader() {
  const avatar = currentUser.avatar ? \`https://cdn.discordapp.com/avatars/\${currentUser.discord_id}/\${currentUser.avatar}.png\` : 'https://cdn.discordapp.com/embed/avatars/0.png';
  document.getElementById('user-area').innerHTML = \`
    <img class="avatar" src="\${avatar}" alt="avatar">
    <span>\${currentUser.username}</span>
    <span class="balance">\${currentUser.balance.toLocaleString()} 🪙</span>
    <button class="btn" onclick="location.href='/api/auth/logout'">Déconnexion</button>
  \`;
  document.getElementById('nav').innerHTML = \`
    <button class="btn" onclick="showShop()">Boutique</button>
    <button class="btn" onclick="showPlay()">Jouer</button>
    <button class="btn" onclick="showHistory()">Historique</button>
    <button class="btn" onclick="showLeaderboard()">Classement</button>
    <button class="btn" onclick="showRules()">Règlement</button>
    \${currentUser.is_admin ? '<button class="btn" onclick="showAdmin()">Admin</button>' : ''}
  \`;
  showShop();
}

async function showShop() {
  const tickets = await api('/api/tickets');
  if (!tickets) return;
  let html = '<h2 style="color:var(--gold);text-align:center;margin:1rem 0;">Boutique de Tickets</h2><div class="tickets-grid">';
  for (const t of tickets) {
    html += \`
      <div class="ticket-card" style="border-color:\${t.color || '#FFD700'}">
        <h3>\${t.name}</h3>
        <div class="price">\${t.price === 0 ? 'GRATUIT' : t.price.toLocaleString() + ' 🪙'}</div>
        <p>Chance spéciale : 0.01%</p>
        \${t.type === 'free' && currentUser.free_cooldown > 0 ? \`<p>Prochain dans \${Math.ceil(currentUser.free_cooldown/3600)}h</p>\` : ''}
        <button class="btn" onclick="buyTicket('\${t.type}')" \${t.type === 'free' && currentUser.free_cooldown > 0 ? 'disabled' : ''}>Acheter / Gratter</button>
      </div>
    \`;
  }
  html += '</div>';
  document.getElementById('content').innerHTML = html;
}

async function buyTicket(type) {
  const res = await api('/api/buy', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({type}) });
  if (res && res.success) {
    currentTicketId = res.ticket_id;
    openScratch();
    loadUser(); // refresh balance
  } else if (res) alert(res.error || 'Erreur');
}

function openScratch() {
  document.getElementById('scratch-modal').classList.add('active');
  initCanvas();
}

function initCanvas() {
  canvas.width = 400;
  canvas.height = 250;
  // Metallic layer
  const grad = ctx.createLinearGradient(0,0,400,250);
  grad.addColorStop(0, '#888');
  grad.addColorStop(0.5, '#ccc');
  grad.addColorStop(1, '#666');
  ctx.fillStyle = grad;
  ctx.fillRect(0,0,400,250);
  // Texture
  for (let i=0; i<3000; i++) {
    ctx.fillStyle = \`rgba(255,255,255,\${Math.random()*0.3})\`;
    ctx.fillRect(Math.random()*400, Math.random()*250, 1, 1);
  }
  ctx.globalCompositeOperation = 'destination-out';
  scratchedPercent = 0;
  document.getElementById('result-text').style.opacity = 0;
}

function scratch(x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 25, 0, Math.PI*2);
  ctx.fill();
  // Approximate percent (simple)
  scratchedPercent += 0.5;
  if (scratchedPercent > 60) revealResult();
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

canvas.addEventListener('mousedown', e => { isDrawing = true; const p = getPos(e); scratch(p.x, p.y); });
canvas.addEventListener('mousemove', e => { if (isDrawing) { const p = getPos(e); scratch(p.x, p.y); } });
canvas.addEventListener('mouseup', () => isDrawing = false);
canvas.addEventListener('mouseleave', () => isDrawing = false);
canvas.addEventListener('touchstart', e => { e.preventDefault(); isDrawing = true; const p = getPos(e); scratch(p.x, p.y); }, {passive:false});
canvas.addEventListener('touchmove', e => { e.preventDefault(); if (isDrawing) { const p = getPos(e); scratch(p.x, p.y); } }, {passive:false});
canvas.addEventListener('touchend', () => isDrawing = false);

document.getElementById('finish-scratch').onclick = revealResult;

async function revealResult() {
  if (!currentTicketId) return;
  const res = await api('/api/scratch', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ticket_id: currentTicketId}) });
  if (res && res.prize) {
    const txt = document.getElementById('result-text');
    if (res.prize.amount > 0) {
      txt.innerHTML = \`🎉 GAGNÉ !<br>\${res.prize.amount.toLocaleString()} 🪙\`;
      txt.style.color = '#00ff00';
    } else if (res.prize.type === 'special') {
      txt.innerHTML = '💎 LOT SPÉCIAL !';
      txt.style.color = '#ff00ff';
    } else {
      txt.innerHTML = '😔 Perdu';
      txt.style.color = '#ff4444';
    }
    txt.style.opacity = 1;
    // Full clear
    ctx.clearRect(0,0,400,250);
    loadUser();
  }
  currentTicketId = null;
}

function closeScratch() {
  document.getElementById('scratch-modal').classList.remove('active');
}

async function showHistory() {
  const data = await api('/api/history');
  if (!data) return;
  let html = '<div class="history"><h2>Historique</h2><h3>Tickets</h3><ul>';
  for (const t of data.tickets) {
    html += \`<li>\${t.type} - \${t.price} 🪙 - \${t.is_scratched ? (t.prize_amount > 0 ? 'Gagné ' + t.prize_amount : 'Perdu') : 'Non gratté'} - \${new Date(t.created_at*1000).toLocaleString()}</li>\`;
  }
  html += '</ul><h3>Transactions</h3><ul>';
  for (const tx of data.transactions) {
    html += \`<li>\${tx.type}: \${tx.amount > 0 ? '+' : ''}\${tx.amount} - \${tx.description} - \${new Date(tx.created_at*1000).toLocaleString()}</li>\`;
  }
  html += '</ul></div>';
  document.getElementById('content').innerHTML = html;
}

async function showLeaderboard() {
  const leaders = await api('/api/leaderboard');
  if (!leaders) return;
  let html = '<div class="leaderboard"><h2>Classement</h2><ol>';
  leaders.forEach((l, i) => {
    html += \`<li>\${l.username} - \${l.total_won.toLocaleString()} 🪙 gagnés (\${l.tickets_scratched} tickets)</li>\`;
  });
  html += '</ol></div>';
  document.getElementById('content').innerHTML = html;
}

function showRules() {
  document.getElementById('content').innerHTML = \`
    <div class="stats">
      <h2>Règlement</h2>
      <ul>
        <li>1 ticket gratuit toutes les 24h.</li>
        <li>Les résultats sont déterminés côté serveur.</li>
        <li>Chaque ticket a 0.01% de chance de lot spécial.</li>
        <li>Jetons virtuels de test pour le moment.</li>
        <li>Jouez responsablement.</li>
      </ul>
    </div>
  \`;
}

function showAdmin() {
  document.getElementById('content').innerHTML = '<div class="admin"><h2>Panneau Admin</h2><p>Fonctionnalités de base disponibles via API. Ajustements manuels possibles.</p><button class="btn" onclick="loadAdminUsers()">Voir membres</button><div id="admin-users"></div></div>';
}

async function loadAdminUsers() {
  const users = await api('/api/admin/users');
  if (!users) return;
  let html = '<ul>';
  for (const u of users) {
    html += \`<li>\${u.username} - Solde: \${u.balance} - <button onclick="adjust('\${u.discord_id}', 10000)">+10k</button> <button onclick="adjust('\${u.discord_id}', -10000)">-10k</button></li>\`;
  }
  html += '</ul>';
  document.getElementById('admin-users').innerHTML = html;
}

async function adjust(id, amount) {
  const res = await api('/api/admin/adjust', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({target_id: id, amount, reason: 'Ajustement manuel'}) });
  if (res && res.success) { alert('Fait'); loadAdminUsers(); }
}

// Init
loadUser();
</script>
</body>
</html>`;
}
