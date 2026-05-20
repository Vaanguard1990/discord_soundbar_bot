# 🎛️ Discord Soundboard v6 — Dockerized

Versione del bot pronta per esecuzione in container Docker, con porte HTTPS/HTTP configurabili.

## 🆕 Novità v6

- 🐳 **Dockerfile** incluso nel repo
- 🔧 Porte configurabili via `.env`: `HTTPS_PORT`, `HTTP_REDIRECT_PORT`
- 🏷️ `INSTANCE_NAME` mostrato come banner UI (distingue prod/test)
- 🚀 `deploy.sh` docker-aware (flag file per watcher host)
- 🎹 Mantiene tutte le feature di v5 (hotkey, upload via web, multi-server, OAuth)

## 🐳 Setup Docker (ambiente prod + test)

Per il setup completo a due ambienti, usa il pacchetto **discord-soundboard-docker.zip** che contiene:
- docker-compose.yml con servizi `soundboard-prod` e `soundboard-test`
- Script `setup-docker.sh`, `deploy-test.sh`, `promote-to-prod.sh`
- Watcher systemd per il deploy webhook
- Template `.env.example` per entrambi gli ambienti

Vedi il README del pacchetto docker per le istruzioni complete.

## 🚀 Aggiornamento dalla v5 (senza Docker)

Se per ora non vuoi Docker, puoi aggiornare la v5 come al solito:

```bash
cd ~
pm2 stop soundboard
# Upload via WinSCP
unzip -o discord-soundboard-v6.zip -d /tmp/
cp -r /tmp/discord-soundboard-v6/* ~/discord-soundboard-web/
rm -rf /tmp/discord-soundboard-v6
cd ~/discord-soundboard-web
npm install
pm2 restart soundboard
```

## 🔧 Variabili d'ambiente (nuove in v6)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `HTTPS_PORT` | `443` | Porta HTTPS del server |
| `HTTP_REDIRECT_PORT` | `80` | Porta HTTP per il redirect HTTP→HTTPS. Impostala a `off` per disabilitare. |
| `INSTANCE_NAME` | *(vuoto)* | Nome istanza. Se valorizzato, appare come banner in UI. Valori tipici: `PROD`, `TEST`. |

Esempi:

**Produzione standard:**
```
HTTPS_PORT=443
HTTP_REDIRECT_PORT=80
INSTANCE_NAME=PROD
```

**Test su porta alternativa:**
```
HTTPS_PORT=8443
HTTP_REDIRECT_PORT=off
INSTANCE_NAME=TEST
```

Il `PUBLIC_URL` deve includere la porta se non è 443:
- Prod: `https://soundbar-bot.ddns.net`
- Test: `https://soundbar-bot.ddns.net:8443`

## 🎹 Feature complete

Tutte le feature precedenti funzionano:
- ✅ Discord OAuth multi-server
- ✅ Whitelist per-server configurabile
- ✅ Pannello admin per OWNER
- ✅ Upload suoni via UI web (drag & drop)
- ✅ Rinomina/elimina suoni
- ✅ Hotkey da tastiera configurabili
- ✅ Toggle hotkey da header
- ✅ Auto-deploy via GitHub webhook
- ✅ HTTPS con Let's Encrypt
- ✅ `@discordjs/voice 1.0.0-dev` con supporto DAVE protocol
