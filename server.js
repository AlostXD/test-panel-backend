// backend/server.js
//
// EBS (Extension Backend Service) simples para o painel "Equipe Twitch".
//
// O que ele faz:
// 1. Pega e guarda em cache um App Access Token da Twitch (Client Credentials)
// 2. Consulta o time (Twitch Team) pra saber quem são os membros
// 3. Consulta quais desses membros estão AO VIVO agora
// 4. Expõe tudo isso numa rota simples que o painel (frontend) chama
//
// Variáveis de ambiente necessárias (ver .env.example):
//   TWITCH_CLIENT_ID
//   TWITCH_CLIENT_SECRET
//   TEAM_NAME          -> o "slug" do time, ex: no link twitch.tv/team/meutimeaqui
//                          o valor é "meutimeaqui"
//   PORT               -> opcional, padrão 3000

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TEAM_NAME,
  PORT = 3000,
} = process.env;

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.error(
    "Faltou configurar TWITCH_CLIENT_ID e/ou TWITCH_CLIENT_SECRET no .env"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. App Access Token (client credentials) com cache em memória
// ---------------------------------------------------------------------------

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAppAccessToken() {
  const now = Date.now();

  // Reusa o token enquanto ele ainda for válido (com 60s de folga)
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  const resp = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, {
    method: "POST",
  });

  if (!resp.ok) {
    throw new Error(`Falha ao gerar App Access Token: ${resp.status}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;

  return cachedToken;
}

// Wrapper pra chamar qualquer endpoint da Helix já com os headers certos
async function helixFetch(path) {
  const token = await getAppAccessToken();

  const resp = await fetch(`https://api.twitch.tv/helix${path}`, {
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Helix ${path} -> ${resp.status}: ${body}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// 2. Buscar membros do time
// ---------------------------------------------------------------------------
//
// GET /helix/teams?name=<team_name>
// Retorna, entre outras coisas, um array `users` com cada membro do time
// (id, login, display_name).

async function getTeamMembers(teamName) {
  const data = await helixFetch(
    `/teams?name=${encodeURIComponent(teamName)}`
  );

  const team = data.data?.[0];
  if (!team) {
    throw new Error(`Time "${teamName}" não encontrado`);
  }

  return team.users.map((u) => ({
    id: u.user_id,
    login: u.user_login,
    displayName: u.user_name,
  }));
}

// ---------------------------------------------------------------------------
// 3. Ver quem está ao vivo agora, dentre uma lista de logins
// ---------------------------------------------------------------------------
//
// GET /helix/streams?user_login=a&user_login=b&user_login=c
// Retorna só quem está ONLINE. A API aceita até 100 logins por chamada.

async function getLiveStatus(logins) {
  if (logins.length === 0) return new Map();

  const params = logins
    .map((login) => `user_login=${encodeURIComponent(login)}`)
    .join("&");

  const data = await helixFetch(`/streams?${params}&first=100`);

  const liveMap = new Map();
  for (const stream of data.data) {
    liveMap.set(stream.user_login.toLowerCase(), {
      title: stream.title,
      game: stream.game_name,
      viewers: stream.viewer_count,
      thumbnailUrl: stream.thumbnail_url,
      startedAt: stream.started_at,
    });
  }
  return liveMap;
}

// ---------------------------------------------------------------------------
// 4. Rota consumida pelo painel
// ---------------------------------------------------------------------------

// Cache curto pra não estourar rate limit se vários viewers abrirem o painel
// ao mesmo tempo (todos batem no mesmo cache, não na API da Twitch direto).
let statusCache = null;
let statusCacheAt = 0;
const STATUS_CACHE_MS = 30_000; // 30s

app.get("/api/team-status", async (req, res) => {
  const team = req.query.team || TEAM_NAME;

  if (!team) {
    return res.status(400).json({ error: "Parâmetro 'team' não informado" });
  }

  try {
    const now = Date.now();
    if (statusCache && now - statusCacheAt < STATUS_CACHE_MS) {
      return res.json(statusCache);
    }

    const members = await getTeamMembers(team);
    const liveMap = await getLiveStatus(members.map((m) => m.login));

    const result = {
      team,
      updatedAt: new Date().toISOString(),
      members: members
        .map((m) => {
          const live = liveMap.get(m.login.toLowerCase());
          return {
            ...m,
            isLive: Boolean(live),
            stream: live || null,
          };
        })
        // ao vivo primeiro, depois por nome
        .sort((a, b) => {
          if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
          return a.displayName.localeCompare(b.displayName);
        }),
    };

    statusCache = result;
    statusCacheAt = now;

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`EBS rodando em http://localhost:${PORT}`);
});
