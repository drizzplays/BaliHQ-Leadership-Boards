const path = require('node:path');
require('dotenv').config();

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(value).trim();
}

const dataFile = process.env.DATA_FILE || './data/balihq-leaderboard.json';

const config = {
  token: requireEnv('DISCORD_TOKEN'),
  clientId: requireEnv('CLIENT_ID'),
  guildId: requireEnv('GUILD_ID'),

  trackChannelIds: csv(process.env.TRACK_CHANNEL_IDS),

  // BaliHQ custom emoji IDs.
  // Win/loss board uses only these IDs by default.
  winEmojis: csv(process.env.WIN_EMOJIS || '1445504770164133990'),
  lossEmojis: csv(process.env.LOSS_EMOJIS || '1445505106505109555'),

  // Reactors board: users get 1 point per tracked message when they use this emoji.
  reactorPointEmojis: csv(process.env.REACTOR_POINT_EMOJIS || '1445874577010851880'),

  // If true, normal webhook messages are tracked. If BaliBot posts as a bot/app message instead of a true webhook,
  // ALLOW_BOT_PLAY_ALERTS lets those messages count too.
  requireWebhook: bool(process.env.REQUIRE_WEBHOOK, false),
  allowBotPlayAlerts: bool(process.env.ALLOW_BOT_PLAY_ALERTS, true),
  allowHumanPlayAlerts: bool(process.env.ALLOW_HUMAN_PLAY_ALERTS, false),
  trackWebhookIds: csv(process.env.TRACK_WEBHOOK_IDS),
  trackAuthorIds: csv(process.env.TRACK_AUTHOR_IDS),

  trackAfterIso: String(process.env.TRACK_AFTER_ISO || '').trim(),
  autoSyncOnReady: bool(process.env.AUTO_SYNC_ON_READY, true),
  syncLimit: Number(process.env.SYNC_LIMIT || 100),
  autoSyncIntervalSeconds: Number(process.env.AUTO_SYNC_INTERVAL_SECONDS || 300),

  embedTitleIncludes: String(process.env.EMBED_TITLE_INCLUDES || '').trim().toLowerCase(),
  messageContains: String(process.env.MESSAGE_CONTAINS || '').trim().toLowerCase(),

  removeOppositeReaction: bool(process.env.REMOVE_OPPOSITE_REACTION, true),

  dataFile: path.resolve(process.cwd(), dataFile)
};

if (config.trackChannelIds.length === 0) {
  throw new Error('TRACK_CHANNEL_IDS is required. Add at least one BaliHQ play channel ID.');
}

if (config.winEmojis.length === 0 || config.lossEmojis.length === 0) {
  throw new Error('WIN_EMOJIS and LOSS_EMOJIS must each include at least one emoji.');
}

if (config.reactorPointEmojis.length === 0) {
  throw new Error('REACTOR_POINT_EMOJIS must include at least one emoji ID/name.');
}

module.exports = { config, csv, bool };
