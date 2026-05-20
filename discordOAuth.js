// Discord OAuth2 flow (senza librerie esterne: solo fetch built-in di Node 18+)

const DISCORD_API = "https://discord.com/api/v10";

class DiscordOAuth {
  constructor({ clientId, clientSecret, redirectUri }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  // URL a cui mandare l'utente per iniziare il flow
  getAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "identify guilds",
      state,
      prompt: "none", // se ha già autorizzato, passa liscio
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  // Scambia il code ricevuto da Discord per un access token
  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });

    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth exchange fallito: ${res.status} ${text}`);
    }
    return res.json();
  }

  async getUser(accessToken) {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`getUser fallito: ${res.status}`);
    return res.json();
  }

  // Ritorna array di guild { id, name, icon, owner, permissions } dell'utente
  async getUserGuilds(accessToken) {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`getUserGuilds fallito: ${res.status}`);
    return res.json();
  }
}

module.exports = DiscordOAuth;
