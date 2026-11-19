export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) return handleApi(request, env, path);
    
    return new Response(HTML, { headers: { "Content-Type": "text/html" } });
  }
};

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SCRATCH CLUB</title>
<style>
body{margin:0;background:#000;color:#fff;font-family:Arial}
.header{text-align:center;padding:20px;background:#111;border-bottom:2px solid #FFD700}
.logo{color:#FFD700;font-size:28px;font-weight:bold}
.nav{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:15px}
.nav button{padding:12px 20px;background:#111;color:#FFD700;border:1px solid #FFD700;border-radius:10px;font-weight:bold}
.card{background:#111;border:1px solid #333;border-radius:15px;padding:20px;margin:15px}
.ticket{background:#0a0a0a;border:2px solid #FFD700;border-radius:15px;padding:15px;margin:10px;text-align:center}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🎟️ SCRATCH CLUB</div>
  <div id="userInfo"></div>
</div>
<div class="nav" id="nav"></div>
<div id="content"></div>
<script>
let user = null;
async function init() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) user = await res.json();
  } catch(e) {}
  if (user && user.discord_id) { renderNav(); loadBoutique(); }
  else showLogin();
}
function showLogin() {
  document.getElementById("content").innerHTML = '<div style="text-align:center;padding:80px 20px"><h1 style="color:#FFD700">Bienvenue sur SCRATCH CLUB</h1><p>Connectez-vous avec Discord</p><a href="https://discord.com/oauth2/authorize?client_id=1572922433822924830&redirect_uri=https%3A%2F%2Fticket-akihara.nhdmpnf4jr.workers.dev%2Fapi%2Fauth%2Fcallback&response_type=code&scope=identify%20guilds"><button style="padding:15px 30px;background:#5865F2;color:white;border:none;border-radius:10px">Se connecter avec Discord</button></a></div>';
}
function renderNav() {
  document.getElementById("userInfo").innerHTML = '<div style="margin-top:10px">' + user.username + ' <span style="background:#111;border:1px solid #FFD700;padding:5px 12px;border-radius:20px">' + user.tokens + ' 🪙</span> <button onclick="logout()" style="margin-left:10px;padding:6px 12px;background:#111;color:#FFD700;border:1px solid #FFD700;border-radius:8px">Déconnexion</button></div>';
  document.getElementById("nav").innerHTML = '<button onclick="loadBoutique()">Boutique</button><button onclick="loadAdmin()">Admin</button>';
}
async function loadBoutique() {
  const res = await fetch("/api/tickets");
  const tickets = await res.json();
  let html = '<h2 style="text-align:center;color:#FFD700">Boutique de Tickets</h2>';
  tickets.forEach(t => {
    html += '<div class="ticket"><h3>' + t.name + '</h3><p style="font-size:24px;color:#FFD700">' + t.price + ' 🪙</p><button style="padding:12px 25px;background:#FFD700;border:none;border-radius:10px;font-weight:bold">Acheter</button></div>';
  });
  document.getElementById("content").innerHTML = html;
}
async function loadAdmin() {
  if (user.discord_id !== "1473948546674724889") {
    document.getElementById("content").innerHTML = '<div class="card">Accès refusé</div>';
    return;
  }
  document.getElementById("content").innerHTML = '<div class="card"><h2>Panneau Admin</h2><input id="searchUser" placeholder="Rechercher un pseudo..." style="width:65%;padding:10px;border-radius:8px;border:1px solid #FFD700;background:#111;color:#fff"><button onclick="searchUsers()" style="padding:10px 15px;background:#FFD700;border:none;border-radius:8px;font-weight:bold">Rechercher</button><div id="usersList"></div></div>';
}
async function searchUsers() {
  const q = document.getElementById("searchUser").value;
  const res = await fetch("/api/admin/users?search=" + encodeURIComponent(q));
  const users = await res.json();
  let html = "";
  users.forEach(u => {
    html += '<div style="background:#0a0a0a;padding:12px;margin:8px 0;border-radius:10px;border:1px solid #333"><strong>' + u.username + '</strong> - ' + u.tokens + ' jetons<br><input type="number" id="amount-' + u.discord_id + '" placeholder="Montant" style="width:100px;padding:6px;margin:5px 0;background:#111;color:#fff;border:1px solid #FFD700;border-radius:6px"><button onclick="setTokens(\\'' + u.discord_id + '\\')" style="padding:6px 12px;background:#FFD700;border:none;border-radius:6px;font-weight:bold">Set</button></div>';
  });
  document.getElementById("usersList").innerHTML = html || "<p>Aucun résultat</p>";
}
async function setTokens(id) {
  const amount = document.getElementById("amount-" + id).value;
  if (!amount) return alert("Entre un montant");
  await fetch("/api/admin/set-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: id, amount: parseInt(amount) }) });
  alert("Mis à jour");
  searchUsers();
}
function logout() { document.cookie = "session=;Path=/;Max-Age=0"; location.reload(); }
init();
</script>
</body></html>`;

async function handleApi(request, env, path) {
  const db = env.DB;
  const url = new URL(request.url);

  if (path === "/api/auth/callback") {
    const code = url.searchParams.get("code");
    if (!code) return new Response("No code", { status: 400 });
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://ticket-akihara.nhdmpnf4jr.workers.dev/api/auth/callback"
      })
    });
    const token = await tokenRes.json();
    const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token.access_token } });
    const user = await userRes.json();
    const guildRes = await fetch("https://discord.com/api/users/@me/guilds", { headers: { Authorization: "Bearer " + token.access_token } });
    const guilds = await guildRes.json();
    if (!guilds.some(g => g.id === env.GUILD_ID)) return new Response("Not in server", { status: 403 });
    await db.prepare("INSERT INTO users (discord_id, username, avatar, tokens) VALUES (?, ?, ?, 50000) ON CONFLICT(discord_id) DO UPDATE SET username = ?, avatar = ?").bind(user.id, user.username, user.avatar, user.username, user.avatar).run();
    return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "session=" + user.id + "; Path=/; HttpOnly; Secure; SameSite=Lax" } });
  }

  const cookie = request.headers.get("Cookie") || "";
  const session = cookie.match(/session=([^;]+)/)?.[1];
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (path === "/api/me") {
    const user = await db.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
    return Response.json(user || {});
  }
  if (path === "/api/tickets") {
    const tickets = await db.prepare("SELECT * FROM ticket_configs WHERE enabled = 1").all();
    return Response.json(tickets.results);
  }
  if (path === "/api/admin/users" && session === env.ADMIN_DISCORD_ID) {
    const search = url.searchParams.get("search") || "";
    const users = await db.prepare("SELECT * FROM users WHERE username LIKE ? LIMIT
