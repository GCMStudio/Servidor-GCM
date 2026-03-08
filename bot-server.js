require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const CONFIG = {
    SECRET_KEY:  process.env.SECRET_KEY || "GCMKEY_MTQ2NTg4OTg0MjI3MjUzODg3Ng.G68e8K.arbsmle-PHsZPv44XRbgQwqM4aENDUAPZS2lTQ",
    PORT:        process.env.PORT || 3000,
    CLIENT_ID:   process.env.CLIENT_ID || "1465889842272538876",
    GUILD_ID:    process.env.GUILD_ID  || "1388295763930513478",

    CHANNELS: {
        "roblox-chat": "1480340776348291194",
        "roblox-logs": "1480340872309637203",
        "geral":       "1480340967285456896",
    },
};
const activeServers = new Map();
const messageBuffers = new Map();
const pendingCommands = new Map();
const MAX_BUFFER = 100;

function getBuffer(jobId) {
    if (!messageBuffers.has(jobId)) messageBuffers.set(jobId, []);
    return messageBuffers.get(jobId);
}

function addToBuffer(jobId, author, content) {
    const buf = getBuffer(jobId);
    buf.push({ author, content, timestamp: Math.floor(Date.now() / 1000) });
    if (buf.length > MAX_BUFFER) buf.shift();
}

function generateSpecialID(creatorId, placeId) {
    const raw = CONFIG.SECRET_KEY + String(creatorId) + String(placeId);
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        hash = (Math.imul(hash, 31) + raw.charCodeAt(i)) >>> 0;
        hash = hash % 0xFFFFFFFF;
    }
    return `${CONFIG.SECRET_KEY}-${creatorId}-${placeId}-${hash.toString(16).padStart(8, "0").toUpperCase()}`;
}

function validateSpecialID(receivedId, creatorId, placeId) {
    if (!receivedId || !creatorId || !placeId) return false;
    const expected = generateSpecialID(creatorId, placeId);
    if (receivedId.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(receivedId.toUpperCase()),
            Buffer.from(expected.toUpperCase())
        );
    } catch { return false; }
}

function authCheck(req, res, next) {
    const { specialId, creatorId, placeId } = req.body;
    if (!specialId || !creatorId || !placeId) {
        return res.status(403).json({ error: "Campos de autenticação ausentes." });
    }
    if (!validateSpecialID(specialId, creatorId, placeId)) {
        console.warn(`[Auth] Special ID inválido. Creator: ${creatorId} | Place: ${placeId}`);
        return res.status(403).json({ error: "Special ID inválido." });
    }
    next();
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once("ready", () => {
    console.log(`✅ Bot conectado como: ${client.user.tag}`);
    registerSlashCommands();
});

client.on("messageCreate", (msg) => {
    if (msg.author.bot) return;
    const isMonitored = Object.values(CONFIG.CHANNELS).includes(msg.channelId);
    if (!isMonitored) return;
    for (const [jobId, server] of activeServers.entries()) {
        if (server.running) addToBuffer(jobId, msg.author.username, msg.content);
    }
});

async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName("stop")
            .setDescription("Para o bridge de um servidor Roblox")
            .addStringOption(opt =>
                opt.setName("jobid")
                    .setDescription("JobId do servidor (use /list para ver os ativos)")
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName("run")
            .setDescription("Reativa o bridge de um servidor Roblox")
            .addStringOption(opt =>
                opt.setName("jobid")
                    .setDescription("JobId do servidor (use /list para ver os ativos)")
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName("list")
            .setDescription("Lista todos os servidores Roblox ativos com seus IDs"),
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
            { body: commands }
        );
        console.log("✅ Slash commands registrados.");
    } catch (err) {
        console.error("❌ Erro ao registrar slash commands:", err.message);
    }
}

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (commandName === "list") {
        if (activeServers.size === 0) {
            return interaction.reply({ content: "Nenhum servidor Roblox registrado no momento.", ephemeral: true });
        }
        const lines = ["**📋 Servidores Roblox Ativos:**\n"];
        for (const [jobId, server] of activeServers.entries()) {
            const status  = server.running ? "🟢 Rodando" : "🔴 Parado";
            const uptime  = Math.floor((Date.now() / 1000) - server.registeredAt);
            const minutes = Math.floor(uptime / 60);
            lines.push(
                `${status} **JobId:** \`${jobId}\`\n` +
                `　PlaceId: \`${server.placeId}\` | Players: ${server.playerCount} | Uptime: ${minutes}min\n`
            );
        }
        return interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }

    if (commandName === "stop") {
        const jobId = interaction.options.getString("jobid");
        if (!activeServers.has(jobId)) {
            return interaction.reply({ content: `❌ Servidor \`${jobId}\` não encontrado.`, ephemeral: true });
        }
        const server = activeServers.get(jobId);
        if (!server.running) {
            return interaction.reply({ content: `⚠️ Servidor \`${jobId}\` já está parado.`, ephemeral: true });
        }
        pendingCommands.set(jobId, "stop");
        server.running = false;
        return interaction.reply({ content: `⛔ Comando **/stop** enviado para \`${jobId}\`.`, ephemeral: true });
    }

    if (commandName === "run") {
        const jobId = interaction.options.getString("jobid");
        if (!activeServers.has(jobId)) {
            return interaction.reply({ content: `❌ Servidor \`${jobId}\` não encontrado.`, ephemeral: true });
        }
        const server = activeServers.get(jobId);
        if (server.running) {
            return interaction.reply({ content: `⚠️ Servidor \`${jobId}\` já está rodando.`, ephemeral: true });
        }
        pendingCommands.set(jobId, "run");
        server.running = true;
        return interaction.reply({ content: `✅ Comando **/run** enviado para \`${jobId}\`.`, ephemeral: true });
    }
});

app.post("/register", authCheck, (req, res) => {
    const { jobId, placeId, creatorId, playerCount, timestamp } = req.body;
    activeServers.set(jobId, {
        placeId,
        creatorId,
        playerCount: playerCount || 0,
        registeredAt: timestamp || Math.floor(Date.now() / 1000),
        running: true,
    });
    console.log(`[Register] JobId: ${jobId} | Place: ${placeId}`);
    res.json({ status: "ok" });
});

app.post("/unregister", authCheck, (req, res) => {
    const { jobId } = req.body;
    activeServers.delete(jobId);
    messageBuffers.delete(jobId);
    pendingCommands.delete(jobId);
    console.log(`[Unregister] JobId: ${jobId}`);
    res.json({ status: "ok" });
});

app.post("/roblox-to-discord", authCheck, async (req, res) => {
    const { channel, author, message } = req.body;
    const channelId = CONFIG.CHANNELS[channel] || CONFIG.CHANNELS["geral"];
    try {
        const discordChannel = await client.channels.fetch(channelId);
        await discordChannel.send(`**[Roblox] ${author}:** ${message}`);
        res.json({ status: "ok" });
    } catch (err) {
        console.error("[Erro Discord]", err.message);
        res.status(500).json({ status: "error", error: err.message });
    }
});

app.post("/discord-to-roblox", authCheck, (req, res) => {
    const { jobId, since } = req.body;
    const sinceTs = Number(since) || 0;
    const command = pendingCommands.get(jobId) || null;
    if (command) pendingCommands.delete(jobId);
    const buf = getBuffer(jobId);
    const newMessages = buf.filter(m => m.timestamp > sinceTs);
    res.json({ command, messages: newMessages });
});

app.get("/", (req, res) => {
    res.json({
        status:  "online",
        bot:     client.user?.tag || "conectando...",
        servers: activeServers.size,
    });
});

client.login(process.env.DISCORD_TOKEN).then(() => {
    app.listen(CONFIG.PORT, () => {
        console.log(`✅ Servidor HTTP na porta ${CONFIG.PORT}`);
    });
}).catch(err => {
    console.error("❌ Erro ao conectar bot:", err.message);
    process.exit(1);
});