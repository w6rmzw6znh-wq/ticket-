export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/callback") {
      try {
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
        if (token.error) return new Response("Token error: " + JSON.stringify(token), { status: 400 });
        const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token.access_token } });
        const user = await userRes.json();
        const guildRes = await fetch("https://discord.com/api/users/@me/guilds", { headers: { Authorization: "Bearer " + token.access_token } });
        const guilds = await guildRes.json();
        if (!Array.isArray(guilds)) return new Response("Guilds error: " + JSON.stringify(guilds), { status: 400 });
        if (!guilds.some(g => g.id === env.GUILD_ID)) return new Response("Not in server", { status: 403 });
        await env.DB.prepare("INSERT INTO users (discord_id, username, avatar, balance) VALUES (?, ?, ?, 50000) ON CONFLICT(discord_id) DO UPDATE SET username = ?, avatar = ?").bind(user.id, user.username, user.avatar, user.username, user.avatar).run();
        return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": "session=" + user.id + "; Path=/; HttpOnly; Secure; SameSite=Lax" } });
      } catch (e) {
        return new Response("Callback error: " + e.message, { status: 500 });
      }
    }
    if (url.pathname === "/api/me") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      return Response.json(user || {});
    }
    if (url.pathname === "/api/tickets") {
      const tickets = await env.DB.prepare("SELECT * FROM ticket_configs WHERE enabled = 1").all();
      return Response.json(tickets.results);
    }
    if (url.pathname === "/api/leaderboard") {
      const leaders = await env.DB.prepare("SELECT username, balance, total_won FROM users ORDER BY total_won DESC LIMIT 10").all();
      return Response.json(leaders.results);
    }
    if (url.pathname === "/api/buy" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const body = await request.json();
      const ticket = await env.DB.prepare("SELECT * FROM ticket_configs WHERE type = ?").bind(body.type).first();
      if (!ticket) return Response.json({ error: "Ticket introuvable" }, { status: 404 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      if (user.balance < ticket.price) return Response.json({ error: "Pas assez de jetons" }, { status: 400 });
      await env.DB.prepare("UPDATE users SET balance = balance - ? WHERE discord_id = ?").bind(ticket.price, session).run();
      const probs = JSON.parse(ticket.probabilities || "[]");
      let rand = Math.random() * 100;
      let win = 0;
      for (const p of probs) {
        rand -= p.chance;
        if (rand <= 0) { win = p.amount || 0; break; }
      }
      if (win > 0) {
        await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(win, win, session).run();
        if (env.DISCORD_BOT_TOKEN) {
          await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
            method: "POST",
            headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ content: "🎉 **" + user.username + "** a gagné **" + win + "** jetons sur **AKIHARA** !" })
          });
        }
      }
      await env.DB.prepare("UPDATE users SET tickets_scratched = tickets_scratched + 1 WHERE discord_id = ?").bind(session).run();
      return Response.json({ win, newBalance: user.balance - ticket.price + win, ticketName: ticket.name });
    }
    if (url.pathname === "/api/free" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      const now = Math.floor(Date.now() / 1000);
      if (user.last_free_ticket && now - user.last_free_ticket < 86400) {
        return Response.json({ error: "Ticket gratuit disponible dans " + Math.ceil((86400 - (now - user.last_free_ticket)) / 3600) + "h" }, { status: 400 });
      }
      await env.DB.prepare("UPDATE users SET last_free_ticket = ? WHERE discord_id = ?").bind(now, session).run();
      const win = Math.random() < 0.5 ? Math.floor(Math.random() * 500) + 100 : 0;
      if (win > 0) {
        await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(win, win, session).run();
        if (env.DISCORD_BOT_TOKEN) {
          await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
            method: "POST",
            headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ content: "🎁 **" + user.username + "** a gagné **" + win + "** jetons avec le ticket gratuit !" })
          });
        }
      }
      return Response.json({ win, newBalance: user.balance + win });
    }
    if (url.pathname === "/api/admin/set-tokens" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (session !== env.ADMIN_DISCORD_ID) return new Response("Forbidden", { status: 403 });
      const body = await request.json();
      await env.DB.prepare("UPDATE users SET balance = balance + ? WHERE discord_id = ?").bind(body.amount, body.userId).run();
      return Response.json({ success: true });
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html" } });
  }
};

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AKIHARA</title>
<style>
body{margin:0;background:#000;color:#fff;font-family:Arial}
.header{text-align:center;padding:20px;background:#111;border-bottom:2px solid #FFD700}
.logo{color:#FFD700;font-size:28px;font-weight:bold}
.nav{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:15px}
.nav button{padding:12px 20px;background:#111;color:#FFD700;border:1px solid #FFD700;border-radius:10px;font-weight:bold}
.card{background:#111;border:1px solid #333;border-radius:15px;padding:20px;margin:15px}
.scratch-area{width:280px;height:180px;margin:20px auto;background:#333;border-radius:15px;position:relative;overflow:hidden;cursor:pointer}
.scratch-cover{position:absolute;inset:0;background:linear-gradient(45deg,#FFD700,#B8860B);display:flex;align-items:center;justify-content:center;font-weight:bold;color:#000;font-size:18px}
.scratch-result{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:bold;color:#FFD700}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🎟️ AKIHARA</div>
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
  document.getElementById("content").innerHTML = '<div style="text-align:center;padding:80px 20px"><h1 style="color:#FFD700">Bienvenue sur AKIHARA</h1><p>Connectez-vous avec Discord</p><a href="https://discord.com/oauth2/authorize?client_id=1572922433822924830&redirect_uri=https%3A%2F%2Fticket-akihara.nhdmpnf4jr.workers.dev%2Fapi%2Fauth%2Fcallback&response_type=code&scope=identify%20guilds"><button style="padding:15px 30px;background:#5865F2;color:white;border:none;border-radius:10px">Se connecter avec Discord</button></a></div>';
}
function renderNav() {
  document.getElementById("userInfo").innerHTML = '<div style="margin-top:10px">' + user.username + ' <span style="background:#111;border:1px solid #FFD700;padding:5px 12px;border-radius:20px">' + user.balance + ' 🪙</span> <button onclick="logout()" style="margin-left:10px;padding:6px 12px;background:#111;color:#FFD700;border:1px solid #FFD700;border-radius:8px">Déconnexion</button></div>';
  document.getElementById("nav").innerHTML = '<button onclick="loadBoutique()">Boutique</button><button onclick="loadLeaderboard()">Classement</button><button onclick="loadAdmin()">Admin</button>';
}
async function loadBoutique() {
  const res = await fetch("/api/tickets");
  const tickets = await res.json();
  let html = '<h2 style="text-align:center;color:#FFD700">Boutique de Tickets</h2><div class="card" style="text-align:center"><h3>Ticket Gratuit (24h)</h3><button onclick="claimFree()" style="padding:12px 25px;background:#FFD700;border:none;border-radius:10px;font-weight:bold">Récupérer</button></div>';
  tickets.forEach(t => {
    html += '<div class="card" style="text-align:center"><h3>' + t.name + '</h3><p style="font-size:24px;color:#FFD700">' + t.price + ' 🪙</p><button onclick="buyTicket(\\'' + t.type + '\\')" style="padding:12px 25px;background:#FFD700;border:none;border-radius:10px;font-weight:bold">Acheter</button></div>';
  });
  document.getElementById("content").innerHTML = html;
}
async function claimFree() {
  const res = await fetch("/api/free", { method: "POST" });
  const data = await res.json();
  if (data.error) return alert(data.error);
  user.balance = data.newBalance;
  renderNav();
  alert(data.win > 0 ? "Tu as gagné " + data.win + " jetons !" : "Perdu !");
}
async function buyTicket(type) {
  const res = await fetch("/api/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }) });
  const data = await res.json();
  if (data.error) return alert(data.error);
  user.balance = data.newBalance;
  renderNav();
  showScratch(data.win, data.ticketName);
}
function showScratch(win, ticketName) {
  const resultText = win > 0 ? win + " 🪙" : "Perdu";
  document.getElementById("content").innerHTML = '<div class="card" style="text-align:center"><h2>' + ticketName + '</h2><div class="scratch-area" onclick="reveal()"><div class="scratch-cover" id="cover">Gratte ici</div><div class="scratch-result" id="result" style="display:none">' + resultText + '</div></div><button onclick="loadBoutique()" style="margin-top:15px;padding:10px 20px;background:#111;color:#FFD700;border:1px solid #FFD700;border-radius:10px">Retour boutique</button></div>';
}
function reveal() {
  document.getElementById("cover").style.display = "none";
  document.getElementById("result").style.display = "flex";
}
async function loadLeaderboard() {
  const res = await fetch("/api/leaderboard");
  const leaders = await res.json();
  let html = '<h2 style="text-align:center;color:#FFD700">Classement</h2>';
  leaders.forEach((u, i) => {
    html += '<div class="card">' + (i+1) + '. <strong>' + u.username + '</strong> - ' + u.total_won + ' gagnés</div>';
  });
  document.getElementById("content").innerHTML = html;
}
function loadAdmin() {
  if (user.discord_id !== "1473948546674724889") {
    document.getElementById("content").innerHTML = '<div class="card">Accès refusé</div>';
    return;
  }
  document.getElementById("content").innerHTML = '<div class="card"><h2>Panneau Admin</h2><p>ID Discord du membre :</p><input id="targetId" placeholder="Discord ID" style="width:100%;padding:10px;margin:5px 0;background:#111;color:#fff;border:1px solid #FFD700;border-radius:8px"><p>Montant à ajouter :</p><input id="amount" type="number" placeholder="Montant" style="width:100%;padding:10px;margin:5px 0;background:#111;color:#fff;border:1px solid #FFD700;border-radius:8px"><br><button onclick="setTokens()" style="padding:12px 25px;background:#FFD700;border:none;border-radius:10px;font-weight:bold;margin-top:10px">Ajouter</button></div>';
}
async function setTokens() {
  const userId = document.getElementById("targetId").value;
  const amount = document.getElementById("amount").value;
  if (!userId || !amount) return alert("Remplis les deux champs");
  await fetch("/api/admin/set-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, amount: parseInt(amount) }) });
  alert("Jetons ajoutés");
}
function logout() { document.cookie = "session=;Path=/;Max-Age=0"; location.reload(); }
init();
</script>
</body></html>`;
