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
async function getTeamMembers(teamName) {
  const data = await helixFetch(`/teams?name=${encodeURIComponent(teamName)}`);
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
// NOVA FUNÇÃO: Buscar fotos de perfil do endpoint /users (Até 100 por chamada)
// ---------------------------------------------------------------------------
async function getUsersAvatars(logins) {
  if (logins.length === 0) return new Map();

  const params = logins
    .map((login) => `login=${encodeURIComponent(login)}`)
    .join("&");

  const data = await helixFetch(`/users?${params}`);
  const avatarMap = new Map();

  for (const user of data.data) {
    avatarMap.set(user.login.toLowerCase(), user.profile_image_url);
  }
  return avatarMap;
}

// ---------------------------------------------------------------------------
// 3. Ver quem está ao vivo agora
// ---------------------------------------------------------------------------
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

const TEAMS_CONFIG = [
  { id: "osguerreiros", displayName: "Equipe Principal", slug: "equipeprincipal" },
  { id: "academiaosg", displayName: "Equipe Academia", slug: "equipeacademia" }
];



app.get("/api/team-status", async (req, res) => {
  // Pega o ID da equipe enviado pelo frontend ou usa o primeiro por padrão
  const selectedTeamId = req.query.team || "osguerreiros";
  
  // Encontra a configuração correspondente
  const teamConfig = TEAMS_CONFIG.find(t => t.id === selectedTeamId) || TEAMS_CONFIG[0];
  const twitchSlug = teamConfig.slug;

  try {
    // IMPORTANTE: Agora usamos o 'twitchSlug' para buscar na API da Twitch
    const members = await getTeamMembers(twitchSlug);
    const logins = members.map((m) => m.login);

    const [liveMap, avatarMap] = await Promise.all([
      getLiveStatus(logins),
      getUsersAvatars(logins)
    ]);

    const result = {
      activeTeamId: teamConfig.id, // Informa ao front qual ID está ativo
      teams: TEAMS_CONFIG,         // Envia a lista de equipes para o front montar o menu
      members: members
        .map((m) => {
          const mLoginLower = m.login.toLowerCase();
          const live = liveMap.get(mLoginLower);
          const avatar = avatarMap.get(mLoginLower) || "";
          
          return {
            ...m,
            profilePicture: avatar,
            isLive: Boolean(live),
            stream: live || null,
          };
        })
        .sort((a, b) => {
          if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
          return a.displayName.localeCompare(b.displayName);
        }),
    };

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
