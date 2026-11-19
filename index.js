export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/test-discord") {
      try {
        const res = await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
          method: "POST",
          headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "✅ Test depuis AKIHARA" })
        });
        const data = await res.json();
        return Response.json({ status: res.status, data });
      } catch (e) {
        return Response.json({ error: e.message });
      }
    }
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
            body: JSON.stringify({ content: "🎉 <@" + session + "> a gagné **" + win + "** jetons sur **AKIHARA** !" })
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
            body: JSON.stringify({ content: "🎁 <@" + session + "> a gagné **" + win + "** jetons avec le ticket gratuit !" })
          });
        }
      }
      return Response.json({ win, newBalance: user.balance + win });
    }
    if (url.pathname === "/api/roulette" && request.method === "POST") {
      const cookie = request.headers.get("Cookie") || "";
      const session = cookie.match(/session=([^;]+)/)?.[1];
      if (!session) return new Response("Unauthorized", { status: 401 });
      const user = await env.DB.prepare("SELECT * FROM users WHERE discord_id = ?").bind(session).first();
      const now = Math.floor(Date.now() / 1000);
      if (user.last_roulette && now - user.last_roulette < 86400) {
        return Response.json({ error: "Roulette disponible dans " + Math.ceil((86400 - (now - user.last_roulette)) / 3600) + "h" }, { status: 400 });
      }
      await env.DB.prepare("UPDATE users SET last_roulette = ? WHERE discord_id = ?").bind(now, session).run();
      const win = Math.floor(Math.random() * 49500) + 500;
      await env.DB.prepare("UPDATE users SET balance = balance + ?, total_won = total_won + ? WHERE discord_id = ?").bind(win, win, session).run();
      if (env.DISCORD_BOT_TOKEN) {
        await fetch("https://discord.com/api/v10/channels/1572952017846927452/messages", {
          method: "POST",
          headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json" },
          body: JSON.stringify({ content: "🎰 <@" + session + "> a gagné **" + win + "** jetons à la roulette quotidienne !" })
        });
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
body{margin:0;background:#0f0b1e;color:#fff;font-family:system-ui,Arial}
.header{text-align:center;padding:20px 15px;background:#0f0b1e;border-bottom:1px solid #2a2040}
.logo{color:#a78bfa;font-size:28px;font-weight:bold}
.nav{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;padding:15px}
.nav button{padding:12px 22px;background:#1a1430;color:#c4b5fd;border:1px solid #3b2f5e;border-radius:10px;font-weight:600}
.container{width:100%;padding:15px;box-sizing:border-box}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:15px;margin-top:15px}
.card{background:#16122a;border:1px solid #2a2040;border-radius:16px;padding:15px;text-align:center}
.card img{width:100%;border-radius:12px;margin-bottom:10px}
.price{font-size:18px;color:#c4b5fd;margin:8px 0;font-weight:bold}
.btn{padding:10px 20px;background:#7c3aed;color:#fff;border:none;border-radius:10px;font-weight:bold;cursor:pointer}
.scratch-area{width:280px;height:180px;margin:20px auto;background:#1a1430;border-radius:16px;position:relative;overflow:hidden;touch-action:none}
canvas{position:absolute;inset:0;width:100%;height:100%;cursor:pointer;z-index:2}
.scratch-result{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:bold;color:#c4b5fd;z-index:1}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🎟️ AKIHARA</div>
  <div id="userInfo"></div>
</div>
<div class="nav" id="nav"></div>
<div class="container" id="content"></div>
<script>
let user = null;
const images = {
  free: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966832120406046/IMG_2823.png?ex=6b004b05&is=6afef985&hm=4ffd3ecead972644f8e6b4e68c4a3f1a667c6738a516bf06930edd337724505a&",
  bronze: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966264299585566/IMG_2819.png?ex=6b004a7d&is=6afef8fd&hm=49cece172187d1aeaa715771dada4d43531a022784af6deaee2c0b05dec8b0ee&",
  silver: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966456185061518/IMG_2820.png?ex=6b004aab&is=6afef92b&hm=f70b7d4c70d0628834d0903df906261f7782ba85d5459b1d17a3c064bf050087&",
  gold: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966585101058178/IMG_2821.png?ex=6b004aca&is=6afef94a&hm=061d249def798ff2b0e2d4792ec2c9e50c5af8fb60565a18ae2b8db8023cac50&",
  diamond: "https://cdn.discordapp.com/attachments/1571623648303783942/1572966713069412513/IMG_2822.png?ex=6b004ae8&is=6afef968&hm=ebf7dd60b3ec05e63204dd3204ee2ac7184e9f137917a0fb79eb167d83437289&"
};
async function init() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) user = await res.json();
  } catch(e) {}
  if (user && user.discord_id) { renderNav(); loadBoutique(); }
  else showLogin();
}
function showLogin() {
  document.getElementById("content").innerHTML = '<div style="text-align:center;padding:80px 20px"><h1 style="color:#a78bfa;font-size:32px">Bienvenue sur AKIHARA</h1><p style="color:#9ca3af">Connectez-vous avec Discord</p><a
