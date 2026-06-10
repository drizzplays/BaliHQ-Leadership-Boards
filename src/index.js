const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits
} = require('discord.js');
const { config } = require('./config');
const { Store } = require('./store');

const store = new Store(config.dataFile);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.User
  ]
});

function lower(value) {
  return String(value || '').toLowerCase();
}

function normalizeEmojiInput(value) {
  const raw = String(value || '').trim();
  if (/^\d{15,25}$/.test(raw)) return raw;

  // Handles <:name:id> and <a:name:id>.
  const fullCustomMatch = raw.match(/^<a?:[\w-]+:(\d{15,25})>$/);
  if (fullCustomMatch && fullCustomMatch[1]) return fullCustomMatch[1];

  // Handles copied strings that end with an emoji ID.
  const looseIdMatch = raw.match(/(\d{15,25})$/);
  if (looseIdMatch && looseIdMatch[1]) return looseIdMatch[1];

  return raw;
}

const winEmojiSet = new Set(config.winEmojis.map(normalizeEmojiInput));
const lossEmojiSet = new Set(config.lossEmojis.map(normalizeEmojiInput));
const reactorPointEmojiSet = new Set(config.reactorPointEmojis.map(normalizeEmojiInput));

function emojiKey(emoji) {
  return emoji?.id || emoji?.name || String(emoji || '');
}

function emojiMatchesSet(emoji, set) {
  const key = emojiKey(emoji);
  return set.has(key) || set.has(emoji?.name) || set.has(emoji?.id);
}

function reactionResult(emoji) {
  if (emojiMatchesSet(emoji, winEmojiSet)) return 'win';
  if (emojiMatchesSet(emoji, lossEmojiSet)) return 'loss';
  return null;
}

function isReactorPointEmoji(emoji) {
  return emojiMatchesSet(emoji, reactorPointEmojiSet);
}

function oppositeResult(result) {
  if (result === 'win') return 'loss';
  if (result === 'loss') return 'win';
  return null;
}

function resultEmojiSet(result) {
  return result === 'win' ? winEmojiSet : lossEmojiSet;
}

function messageCreatedAtIso(message) {
  return message.createdAt ? message.createdAt.toISOString() : new Date(Number(message.createdTimestamp)).toISOString();
}

function isAfterStart(message) {
  const startIso = store.getStartIso(config.trackAfterIso);
  return new Date(messageCreatedAtIso(message)).getTime() >= new Date(startIso).getTime();
}

function summarizePlayMessage(message) {
  const firstEmbed = message.embeds?.[0];
  const title = firstEmbed?.title || '';
  const description = firstEmbed?.description || '';
  const fields = firstEmbed?.fields || [];
  const fieldSummary = fields
    .slice(0, 5)
    .map((field) => `${field.name}: ${field.value}`)
    .join(' | ');

  return {
    title,
    description: description.slice(0, 500),
    fieldSummary: fieldSummary.slice(0, 700)
  };
}

function messageTextBlob(message) {
  const embedText = (message.embeds || [])
    .map((embed) => [
      embed.title,
      embed.description,
      ...(embed.fields || []).flatMap((field) => [field.name, field.value])
    ].join(' '))
    .join(' ');

  return lower([message.content, embedText].join(' '));
}

function passesPlayTextFilters(message) {
  const textBlob = messageTextBlob(message);

  if (config.embedTitleIncludes) {
    const titles = (message.embeds || []).map((embed) => lower(embed.title)).join(' ');
    if (!titles.includes(config.embedTitleIncludes)) return false;
  }

  if (config.messageContains) {
    if (!textBlob.includes(config.messageContains)) return false;
  }

  return true;
}

async function shouldTrackMessage(message) {
  if (!message || !message.id || !message.guildId) return false;
  if (!config.trackChannelIds.includes(message.channelId)) return false;
  if (!isAfterStart(message)) return false;

  // Never track this leaderboard bot's own command responses.
  if (client.user?.id && message.author?.id === client.user.id) return false;

  if (config.trackWebhookIds.length > 0 && !config.trackWebhookIds.includes(message.webhookId)) {
    return false;
  }

  if (config.trackAuthorIds.length > 0 && !config.trackAuthorIds.includes(message.author?.id)) {
    return false;
  }

  if (!passesPlayTextFilters(message)) return false;

  // BaliBot may post as a real webhook OR as a Discord app/bot message.
  // Do not count random human chatter in tracked channels unless explicitly enabled.
  const isWebhookPost = Boolean(message.webhookId);
  const isBotOrAppPost = Boolean(message.author?.bot || message.applicationId);

  if (config.requireWebhook && !isWebhookPost) {
    if (!config.allowBotPlayAlerts || !isBotOrAppPost) return false;
  }

  if (!isWebhookPost && !isBotOrAppPost && !config.allowHumanPlayAlerts) {
    return false;
  }

  return true;
}

function trackMessage(message) {
  const summary = summarizePlayMessage(message);
  return store.upsertPlay({
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author?.id || null,
    authorTag: message.author?.tag || message.author?.username || null,
    webhookId: message.webhookId || null,
    createdAtIso: messageCreatedAtIso(message),
    jumpUrl: message.url,
    title: summary.title,
    description: summary.description,
    fieldSummary: summary.fieldSummary
  });
}

async function ensureTrackedMessage(message) {
  if (store.getPlay(message.id)) return true;
  if (!(await shouldTrackMessage(message))) return false;
  trackMessage(message);
  return true;
}

async function hydrateReaction(reaction) {
  if (reaction.partial) await reaction.fetch();
  if (reaction.message?.partial) await reaction.message.fetch();
  return reaction;
}

async function fetchUsersForReaction(reaction) {
  const userIds = [];
  let after;

  while (true) {
    const users = await reaction.users.fetch({ limit: 100, after });
    if (users.size === 0) break;

    for (const user of users.values()) {
      if (!user.bot) userIds.push(user.id);
    }

    if (users.size < 100) break;
    after = users.last().id;
  }

  return userIds;
}

async function syncMessageReactions(message) {
  if (!store.getPlay(message.id)) return { wins: 0, losses: 0, points: 0, ambiguous: 0 };

  const freshMessage = await message.channel.messages.fetch(message.id);
  const winUsers = new Set();
  const lossUsers = new Set();
  const pointUsers = new Set();

  for (const reaction of freshMessage.reactions.cache.values()) {
    const result = reactionResult(reaction.emoji);
    const isPoint = isReactorPointEmoji(reaction.emoji);
    if (!result && !isPoint) continue;

    const ids = await fetchUsersForReaction(reaction);
    for (const id of ids) {
      if (result === 'win') winUsers.add(id);
      if (result === 'loss') lossUsers.add(id);
      if (isPoint) pointUsers.add(id);
    }
  }

  const resultByUserId = {};
  let ambiguous = 0;

  for (const userId of winUsers) {
    if (lossUsers.has(userId)) {
      ambiguous += 1;
      continue;
    }
    resultByUserId[userId] = 'win';
  }

  for (const userId of lossUsers) {
    if (winUsers.has(userId)) {
      ambiguous += 1;
      continue;
    }
    resultByUserId[userId] = 'loss';
  }

  store.replaceMessageResults(message.id, resultByUserId);
  store.replaceMessagePoints(message.id, Array.from(pointUsers));

  return {
    wins: Object.values(resultByUserId).filter((result) => result === 'win').length,
    losses: Object.values(resultByUserId).filter((result) => result === 'loss').length,
    points: pointUsers.size,
    ambiguous
  };
}

async function syncSingleUserResult(message, userId) {
  if (!store.getPlay(message.id)) return;
  const freshMessage = await message.channel.messages.fetch(message.id);

  let hasWin = false;
  let hasLoss = false;

  for (const reaction of freshMessage.reactions.cache.values()) {
    const result = reactionResult(reaction.emoji);
    if (!result) continue;

    const users = await fetchUsersForReaction(reaction);
    if (users.includes(userId)) {
      if (result === 'win') hasWin = true;
      if (result === 'loss') hasLoss = true;
    }
  }

  if (hasWin && !hasLoss) store.setUserResult(message.id, userId, 'win');
  else if (hasLoss && !hasWin) store.setUserResult(message.id, userId, 'loss');
  else store.removeUserResult(message.id, userId);
}

async function syncSingleUserPoint(message, userId) {
  if (!store.getPlay(message.id)) return;
  const freshMessage = await message.channel.messages.fetch(message.id);

  let hasPoint = false;

  for (const reaction of freshMessage.reactions.cache.values()) {
    if (!isReactorPointEmoji(reaction.emoji)) continue;

    const users = await fetchUsersForReaction(reaction);
    if (users.includes(userId)) {
      hasPoint = true;
      break;
    }
  }

  if (hasPoint) store.setUserPoint(message.id, userId);
  else store.removeUserPoint(message.id, userId);
}

async function removeOppositeUserReaction(message, user, chosenResult) {
  if (!config.removeOppositeReaction) return;
  if (!message.guild?.members?.me) return;

  const permissions = message.channel.permissionsFor(message.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ManageMessages)) return;

  const opposite = oppositeResult(chosenResult);
  const oppositeSet = resultEmojiSet(opposite);

  const freshMessage = await message.channel.messages.fetch(message.id);
  for (const reaction of freshMessage.reactions.cache.values()) {
    if (!emojiMatchesSet(reaction.emoji, oppositeSet)) continue;

    try {
      await reaction.users.remove(user.id);
    } catch (error) {
      console.warn(`Could not remove opposite reaction from ${user.id}: ${error.message}`);
    }
  }
}

async function syncRecent(limit = config.syncLimit) {
  let scanned = 0;
  let tracked = 0;
  let reactionWins = 0;
  let reactionLosses = 0;
  let reactorPoints = 0;
  let ambiguous = 0;

  for (const channelId of config.trackChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    const messages = await channel.messages.fetch({ limit: Math.min(Number(limit) || 100, 100) });
    const sortedMessages = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const message of sortedMessages) {
      scanned += 1;
      if (!(await shouldTrackMessage(message))) continue;
      trackMessage(message);
      tracked += 1;
      const result = await syncMessageReactions(message);
      reactionWins += result.wins;
      reactionLosses += result.losses;
      reactorPoints += result.points;
      ambiguous += result.ambiguous;
    }
  }

  store.setLastSyncNow();
  return { scanned, tracked, reactionWins, reactionLosses, reactorPoints, ambiguous };
}

let syncInProgress = false;
let lastSyncResult = null;

async function runRecentSync(reason = 'auto') {
  if (syncInProgress) {
    console.log(`Skipping ${reason} sync because another sync is already running.`);
    return null;
  }

  syncInProgress = true;
  try {
    const result = await syncRecent(config.syncLimit);
    lastSyncResult = { reason, atIso: new Date().toISOString(), ...result };
    console.log(`${reason} sync complete:`, result);
    return result;
  } catch (error) {
    console.error(`${reason} sync failed:`, error);
    return null;
  } finally {
    syncInProgress = false;
  }
}

function winLossLeaderboardEmbed(limit) {
  const rows = store.getWinLossLeaderboard(limit);
  return new EmbedBuilder()
    .setTitle('🏝️ BaliHQ Win/Loss Leaderboard')
    .setDescription(rows.length ? rows.map((row, index) => {
      return `**${index + 1}.** <@${row.userId}> — **${row.wins}-${row.losses}** | **${row.winPct}%** | ${row.total} graded`;
    }).join('\n') : 'No win/loss reactions yet.')
    .setTimestamp(new Date());
}

function reactorsLeaderboardEmbed(limit) {
  const rows = store.getReactorsLeaderboard(limit);
  return new EmbedBuilder()
    .setTitle('🏝️ BaliHQ Reactors Leaderboard')
    .setDescription(rows.length ? rows.map((row, index) => {
      return `**${index + 1}.** <@${row.userId}> — **${row.points}** pts`;
    }).join('\n') : 'No reactor points yet.')
    .setTimestamp(new Date());
}

function leaderboardEmbed(type, limit) {
  if (type === 'reactors') return reactorsLeaderboardEmbed(limit);
  return winLossLeaderboardEmbed(limit);
}

function recordEmbed(userId) {
  const row = store.getUserRecord(userId);
  const points = store.getUserPoints(userId);
  return new EmbedBuilder()
    .setTitle('🏝️ BaliHQ User Record')
    .setDescription([
      `<@${row.userId}>`,
      `Win/Loss: **${row.wins}-${row.losses}** | **${row.winPct}%** | ${row.total} graded`,
      `Reactors: **${points.points}** pts`
    ].join('\n'))
    .setTimestamp(new Date());
}

client.once('ready', async () => {
  console.log(`BaliHQ tracker online as ${client.user.tag}`);
  console.log(`Tracking channels: ${config.trackChannelIds.join(', ')}`);
  console.log(`Tracking after: ${store.getStartIso(config.trackAfterIso)}`);
  console.log(`Win emojis: ${config.winEmojis.join(', ')}`);
  console.log(`Loss emojis: ${config.lossEmojis.join(', ')}`);
  console.log(`Reactor point emojis: ${config.reactorPointEmojis.join(', ')}`);

  if (config.autoSyncOnReady) {
    await runRecentSync('startup');
  }

  if (config.autoSyncIntervalSeconds > 0) {
    const intervalMs = Math.max(config.autoSyncIntervalSeconds, 30) * 1000;
    const timer = setInterval(() => {
      runRecentSync('scheduled');
    }, intervalMs);

    if (typeof timer.unref === 'function') timer.unref();
    console.log(`Scheduled recent sync every ${Math.round(intervalMs / 1000)} seconds.`);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (!(await shouldTrackMessage(message))) return;
    trackMessage(message);
    console.log(`Tracked BaliHQ play alert: ${message.id}`);
  } catch (error) {
    console.error('messageCreate handler failed:', error);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    await hydrateReaction(reaction);

    const result = reactionResult(reaction.emoji);
    const isPoint = isReactorPointEmoji(reaction.emoji);
    if (!result && !isPoint) return;

    const message = reaction.message;
    if (!(await ensureTrackedMessage(message))) return;

    if (result) {
      store.setUserResult(message.id, user.id, result);
      await removeOppositeUserReaction(message, user, result);
      console.log(`${user.tag || user.id} marked ${message.id} as ${result}.`);
    }

    if (isPoint) {
      store.setUserPoint(message.id, user.id);
      console.log(`${user.tag || user.id} earned a reactor point on ${message.id}.`);
    }
  } catch (error) {
    console.error('messageReactionAdd handler failed:', error);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    await hydrateReaction(reaction);

    const result = reactionResult(reaction.emoji);
    const isPoint = isReactorPointEmoji(reaction.emoji);
    if (!result && !isPoint) return;

    const message = reaction.message;
    if (!store.getPlay(message.id)) return;

    if (result) {
      await syncSingleUserResult(message, user.id);
      console.log(`${user.tag || user.id} removed ${result} from ${message.id}.`);
    }

    if (isPoint) {
      await syncSingleUserPoint(message, user.id);
      console.log(`${user.tag || user.id} removed reactor point from ${message.id}.`);
    }
  } catch (error) {
    console.error('messageReactionRemove handler failed:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'leaderboard') {
      const type = interaction.options.getString('type') || 'win_loss';
      const limit = interaction.options.getInteger('limit') || 10;
      await interaction.deferReply();
      await runRecentSync('leaderboard-command');
      await interaction.editReply({ embeds: [leaderboardEmbed(type, limit)] });
      return;
    }

    if (interaction.commandName === 'record') {
      const user = interaction.options.getUser('user') || interaction.user;
      await interaction.deferReply({ ephemeral: true });
      await runRecentSync('record-command');
      await interaction.editReply({ embeds: [recordEmbed(user.id)] });
      return;
    }


    if (interaction.commandName === 'botstatus') {
      await interaction.deferReply({ ephemeral: true });
      await runRecentSync('botstatus-command');
      const stats = store.stats();
      const syncLine = lastSyncResult
        ? `Latest sync: scanned **${lastSyncResult.scanned}** messages, tracked **${lastSyncResult.tracked}** play alerts, found **${lastSyncResult.reactionWins + lastSyncResult.reactionLosses}** win/loss reactions and **${lastSyncResult.reactorPoints}** reactor points.`
        : 'Latest sync: not available yet.';

      const embed = new EmbedBuilder()
        .setTitle('🏝️ BaliHQ Tracker Status')
        .setDescription([
          `Online as: <@${client.user.id}>`,
          `Tracking channels: ${config.trackChannelIds.map((id) => `<#${id}>`).join(', ')}`,
          `Tracking after: **${store.getStartIso(config.trackAfterIso)}**`,
          `Last sync: **${stats.lastSyncIso || 'never'}**`,
          syncLine,
          `Auto sync interval: **${config.autoSyncIntervalSeconds > 0 ? `${Math.max(config.autoSyncIntervalSeconds, 30)}s` : 'off'}**`,
          `Tracked plays: **${stats.playCount}**`,
          `Stored win/loss reactions: **${stats.reactionCount}**`,
          `Stored reactor-point reactions: **${stats.pointReactionCount}**`,
          `Allowed play sources: **${config.requireWebhook ? 'webhook only, plus bot/app alerts if enabled' : 'webhook + bot/app alerts'}**`
        ].join('\n'))
        .setTimestamp(new Date());
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  } catch (error) {
    console.error('interaction failed:', error);
    const payload = { content: `Command failed: ${error.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down BaliHQ tracker.');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down BaliHQ tracker.');
  client.destroy();
  process.exit(0);
});

client.login(config.token);
