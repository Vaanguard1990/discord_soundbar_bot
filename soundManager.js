const fs = require("fs");
const path = require("path");
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  StreamType,
  generateDependencyReport,
} = require("@discordjs/voice");

const SOUNDS_BASE = path.join(__dirname, "sounds");
const SUPPORTED_EXT = [".mp3", ".wav", ".ogg", ".flac"];

// Un'istanza di SoundManager per ciascun guildId
class SoundManager {
  constructor(guildId) {
    this.guildId = guildId;
    this.dir = path.join(SOUNDS_BASE, guildId);
    this.sounds = new Map();
    this.player = createAudioPlayer();
    this.connection = null;
    this.currentChannel = null;
    this.lastPlayed = null;

    this.player.on(AudioPlayerStatus.Idle, () => { this.lastPlayed = null; });
    this.player.on("error", (err) => {
      console.error(`[${guildId}] Player error:`, err.message);
      this.lastPlayed = null;
    });

    this.loadSounds();
  }

  loadSounds() {
    this.sounds.clear();
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    const files = fs.readdirSync(this.dir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (SUPPORTED_EXT.includes(ext)) {
        this.sounds.set(path.basename(file, ext), path.join(this.dir, file));
      }
    }
    return this.sounds.size;
  }

  getSoundNames() {
    return [...this.sounds.keys()].sort((a, b) =>
      a.localeCompare(b, "it", { sensitivity: "base" })
    );
  }

  async join(voiceChannel) {
    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
      this.currentChannel = null;
    }

    const perms = voiceChannel.permissionsFor(voiceChannel.guild.members.me);
    if (!perms?.has("Connect")) throw new Error("Permesso 'Collegarsi' mancante.");
    if (!perms?.has("Speak")) throw new Error("Permesso 'Parlare' mancante.");

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
      this.connection.subscribe(this.player);
      this.currentChannel = { id: voiceChannel.id, name: voiceChannel.name };
      console.log(`✅ [${this.guildId}] Connesso a: #${voiceChannel.name}`);
    } catch {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
      this.currentChannel = null;
      throw new Error("Connessione vocale fallita.");
    }
  }

  async play(name) {
    const filepath = this.sounds.get(name);
    if (!filepath) throw new Error(`Suono "${name}" non trovato.`);
    if (!this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error("Bot non connesso a un canale vocale.");
    }
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop();

    const resource = createAudioResource(filepath, { inputType: StreamType.Arbitrary });
    this.player.play(resource);
    this.lastPlayed = name;
  }

  stop() { this.player.stop(); this.lastPlayed = null; }

  disconnect() {
    this.stop();
    if (this.connection) {
      try { this.connection.destroy(); } catch {}
      this.connection = null;
    }
    this.currentChannel = null;
  }

  isPlaying() { return this.player.state.status === AudioPlayerStatus.Playing; }

  getStatus() {
    const connected = !!this.connection &&
      this.connection.state.status === VoiceConnectionStatus.Ready;
    return {
      connected,
      currentChannel: connected ? this.currentChannel : null,
      playing: this.isPlaying(),
      lastPlayed: this.lastPlayed,
      soundCount: this.sounds.size,
    };
  }
}

// Registry: un SoundManager per guildId, creato on-demand
class SoundManagerRegistry {
  constructor() {
    this.managers = new Map();
    console.log(generateDependencyReport());
  }

  get(guildId) {
    if (!this.managers.has(guildId)) {
      this.managers.set(guildId, new SoundManager(guildId));
    }
    return this.managers.get(guildId);
  }

  disconnectAll() {
    for (const m of this.managers.values()) m.disconnect();
  }
}

module.exports = { SoundManager, SoundManagerRegistry, SOUNDS_BASE };
