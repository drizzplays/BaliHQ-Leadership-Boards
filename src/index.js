const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags
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

function trackRejectReason(message) {
  if (!message || !message.id || !message.guildId) return 'invalid-message';
  if (!config.trackChannelIds.includes(message.channelId)) return 'untracked-channel';
  if (!isAfterStart(message)) return 'before-track-after';

  // Never track this leaderboard bot's own command responses.
  if (client.user?.id && message.author?.id === client.user.id) return 'own-message';

  if (config.trackWebhookIds.length > 0 && !config.trackWebhookIds.includes(message.webhookId)) {
    return 'webhook-id-filter';
  }

  if (config.trackAuthorIds.length > 0 && !config.trackAuthorIds.includes(message.author?.id)) {
    return 'author-id-filter';
  }

  if (!passesPlayTextFilters(message)) return 'text-filter';

  // BaliBot may post as a real webhook OR as a Discord app/bot message.
  // Do not count random human chatter in tracked channels unless explicitly enabled.
  const isWebhookPost = Boolean(message.webhookId);
  const isBotOrAppPost = Boolean(message.author?.bot || message.applicationId);

  if (config.requireWebhook && !isWebhookPost) {
    if (!config.allowBotPlayAlerts || !isBotOrAppPost) return 'not-webhook-or-allowed-bot';
  }

  if (!isWebhookPost && !isBotOrAppPost && !config.allowHumanPlayAlerts) {
    return 'human-message-disabled';
  }

  return null;
}

async function shouldTrackMessage(message) {
  return trackRejectReason(message) === null;
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
  let channelsChecked = 0;
  let channelErrors = 0;
  let messageErrors = 0;
  const skipped = {};

  function bumpSkip(reason) {
    skipped[reason] = (skipped[reason] || 0) + 1;
  }

  for (const channelId of config.trackChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId).catch((error) => {
        throw new Error(`fetch channel failed: ${error.message}`);
      });

      if (!channel || !channel.isTextBased()) {
        channelErrors += 1;
        console.warn(`Skipping channel ${channelId}: not found or not text-based.`);
        continue;
      }

      channelsChecked += 1;
      const messages = await channel.messages.fetch({ limit: Math.min(Number(limit) || 100, 100) });
      const sortedMessages = Array.from(messages.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      for (const message of sortedMessages) {
        scanned += 1;
        try {
          const rejectReason = trackRejectReason(message);
          if (rejectReason) {
            bumpSkip(rejectReason);
            continue;
          }

          trackMessage(message);
          tracked += 1;
          const result = await syncMessageReactions(message);
          reactionWins += result.wins;
          reactionLosses += result.losses;
          reactorPoints += result.points;
          ambiguous += result.ambiguous;
        } catch (error) {
          messageErrors += 1;
          console.warn(`Skipping message ${message.id} in channel ${channelId}: ${error.message}`);
        }
      }
    } catch (error) {
      channelErrors += 1;
      console.warn(`Sync skipped channel ${channelId}: ${error.message}`);
    }
  }

  store.setLastSyncNow();
  return {
    scanned,
    tracked,
    reactionWins,
    reactionLosses,
    reactorPoints,
    ambiguous,
    channelsChecked,
    channelErrors,
    messageErrors,
    skipped
  };
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

function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function rankBadge(index) {
  if (index === 0) return '🥇';
  if (index === 1) return '🥈';
  if (index === 2) return '🥉';
  return `**${index + 1}.**`;
}

function cleanPct(value) {
  const number = Number(value || 0);
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(1).replace(/\.0$/, '');
}

function normalizeLeaderboardType(type) {
  const normalized = String(type || 'win_loss').toLowerCase();
  if (normalized === 'reactions' || normalized === 'reactors' || normalized === 'reaction_points') return 'reactions';
  return 'win_loss';
}

function normalizePeriod(period) {
  const normalized = String(period || 'all_time').toLowerCase();
  if (normalized === 'weekly' || normalized === 'week') return 'weekly';
  if (normalized === 'monthly' || normalized === 'month') return 'monthly';
  return 'all_time';
}

function periodLabel(period) {
  const normalized = normalizePeriod(period);
  if (normalized === 'weekly') return 'Weekly';
  if (normalized === 'monthly') return 'Monthly';
  return 'All-Time';
}

function periodWindowText(period) {
  const normalized = normalizePeriod(period);
  if (normalized === 'weekly') return 'Last 7 days';
  if (normalized === 'monthly') return 'Last 30 days';
  return 'Full tracked history';
}

function lastUpdatedFooter(period, extraParts = []) {
  const stats = store.statsForPeriod ? store.statsForPeriod(normalizePeriod(period)) : store.stats();
  const parts = [
    periodWindowText(period),
    plural(stats.playCount, 'tracked play'),
    ...extraParts.filter(Boolean),
    `Updated ${formatDateTime(new Date().toISOString())}`
  ];
  return parts.join(' • ');
}

function leaderboardHeader(type, period) {
  const label = periodLabel(period);
  if (type === 'reactions') return `⚡ BaliHQ ${label} Reactions Leaderboard`;
  return `🏆 BaliHQ ${label} Win/Loss Leaderboard`;
}

function winLossLeaderboardEmbed(limit, period = 'all_time') {
  const normalizedPeriod = normalizePeriod(period);
  const rows = store.getWinLossLeaderboard(limit, normalizedPeriod);
  const stats = store.statsForPeriod ? store.statsForPeriod(normalizedPeriod) : store.stats();

  const embed = new EmbedBuilder()
    .setColor(0x00AEEF)
    .setTitle(leaderboardHeader('win_loss', normalizedPeriod))
    .setDescription(
      rows.length
        ? `BaliHQ graded play reactions • **${periodWindowText(normalizedPeriod)}**`
        : `No win/loss grades tracked for **${periodWindowText(normalizedPeriod)}** yet.`
    )
    .setFooter({ text: lastUpdatedFooter(normalizedPeriod, [plural(stats.reactionCount, 'win/loss grade')]) })
    .setTimestamp(new Date());

  if (!rows.length) return embed;

  for (const [index, row] of rows.entries()) {
    const pct = cleanPct(row.winPct);
    embed.addFields({
      name: `${rankBadge(index)} <@${row.userId}>`,
      value: [
        `**Record:** ${row.wins}-${row.losses}`,
        `**Win Rate:** ${pct}%`,
        `**Graded Plays:** ${row.total}`
      ].join('  •  '),
      inline: false
    });
  }

  return embed;
}

function reactionsLeaderboardEmbed(limit, period = 'all_time') {
  const normalizedPeriod = normalizePeriod(period);
  const rows = store.getReactionsLeaderboard
    ? store.getReactionsLeaderboard(limit, normalizedPeriod)
    : store.getReactorsLeaderboard(limit, normalizedPeriod);
  const stats = store.statsForPeriod ? store.statsForPeriod(normalizedPeriod) : store.stats();

  const embed = new EmbedBuilder()
    .setColor(0xFFB000)
    .setTitle(leaderboardHeader('reactions', normalizedPeriod))
    .setDescription(
      rows.length
        ? `BaliHQ reaction-point emoji rankings • **${periodWindowText(normalizedPeriod)}**`
        : `No reaction points tracked for **${periodWindowText(normalizedPeriod)}** yet.`
    )
    .setFooter({ text: lastUpdatedFooter(normalizedPeriod, [plural(stats.pointReactionCount, 'reaction')]) })
    .setTimestamp(new Date());

  if (!rows.length) return embed;

  for (const [index, row] of rows.entries()) {
    const reactions = Number(row.reactions ?? row.points ?? 0);
    embed.addFields({
      name: `${rankBadge(index)} <@${row.userId}>`,
      value: `**${plural(reactions, 'reaction')}**`,
      inline: false
    });
  }

  return embed;
}

function leaderboardEmbed(type, limit, period = 'all_time') {
  const normalizedType = normalizeLeaderboardType(type);
  if (normalizedType === 'reactions') return reactionsLeaderboardEmbed(limit, period);
  return winLossLeaderboardEmbed(limit, period);
}

function recordEmbed(userId, period = 'all_time') {
  const normalizedPeriod = normalizePeriod(period);
  const row = store.getUserRecord(userId, normalizedPeriod);
  const reactionRow = store.getUserPoints(userId, normalizedPeriod);
  const pct = cleanPct(row.winPct);

  return new EmbedBuilder()
    .setColor(0x00AEEF)
    .setTitle(`📌 BaliHQ ${periodLabel(normalizedPeriod)} Member Record`)
    .setDescription(`<@${row.userId}> • **${periodWindowText(normalizedPeriod)}**`)
    .addFields(
      {
        name: 'Win/Loss',
        value: [
          `**Record:** ${row.wins}-${row.losses}`,
          `**Win Rate:** ${pct}%`,
          `**Graded Plays:** ${row.total}`
        ].join('  •  '),
        inline: false
      },
      {
        name: 'Reactions',
        value: `**${plural(Number(reactionRow.points || 0), 'reaction')}**`,
        inline: false
      }
    )
    .setFooter({ text: 'BaliHQ Leaderboard' })
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
      const period = interaction.options.getString('period') || 'all_time';
      const limit = interaction.options.getInteger('limit') || 10;
      await interaction.deferReply();
      await runRecentSync('leaderboard-command');
      await interaction.editReply({ embeds: [leaderboardEmbed(type, limit, period)] });
      return;
    }

    if (interaction.commandName === 'record') {
      const user = interaction.options.getUser('user') || interaction.user;
      const period = interaction.options.getString('period') || 'all_time';
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await runRecentSync('record-command');
      await interaction.editReply({ embeds: [recordEmbed(user.id, period)] });
      return;
    }


    if (interaction.commandName === 'botstatus') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await runRecentSync('botstatus-command');
      const stats = store.stats();
      const syncLine = lastSyncResult
        ? `Latest sync: scanned **${lastSyncResult.scanned}** messages in **${lastSyncResult.channelsChecked || 0}** channels, tracked **${lastSyncResult.tracked}** play alerts, found **${lastSyncResult.reactionWins + lastSyncResult.reactionLosses}** win/loss reactions and **${lastSyncResult.reactorPoints}** reactions.`
        : 'Latest sync: not available yet.';
      const skippedLine = lastSyncResult?.skipped
        ? `Skipped: ${Object.entries(lastSyncResult.skipped).slice(0, 6).map(([key, value]) => `${key}: ${value}`).join(', ') || 'none'}`
        : 'Skipped: not available yet.';
      const errorLine = lastSyncResult
        ? `Sync errors: channels **${lastSyncResult.channelErrors || 0}**, messages **${lastSyncResult.messageErrors || 0}**`
        : 'Sync errors: not available yet.';

      const skippedSummary = lastSyncResult?.skipped
        ? Object.entries(lastSyncResult.skipped)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' • ') || 'None'
        : 'Not available yet';

      const allowedSources = config.requireWebhook
        ? (config.allowBotPlayAlerts ? 'Webhook + bot/app alerts' : 'Webhook alerts only')
        : (config.allowHumanPlayAlerts ? 'Webhook + bot/app + human alerts' : 'Webhook + bot/app alerts');

      const embed = new EmbedBuilder()
        .setColor(0x00AEEF)
        .setTitle('📊 BaliHQ Tracker Status')
        .setDescription('System health and tracking summary for the BaliHQ leaderboard bot.')
        .addFields(
          {
            name: 'System',
            value: [
              `**Status:** Online`,
              `**Online as:** <@${client.user.id}>`,
              `**Tracked channels:** ${config.trackChannelIds.length}`,
              `**Sync interval:** ${config.autoSyncIntervalSeconds > 0 ? `${Math.max(config.autoSyncIntervalSeconds, 30)}s` : 'Off'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'Tracking Window',
            value: [
              `**Tracking since:** ${formatDateTime(store.getStartIso(config.trackAfterIso))}`,
              `**Last stored sync:** ${formatDateTime(stats.lastSyncIso)}`,
              `**Latest command sync:** ${lastSyncResult?.atIso ? formatDateTime(lastSyncResult.atIso) : 'Not available yet'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'Current Data',
            value: [
              `**Tracked plays:** ${stats.playCount}`,
              `**Win/Loss grades:** ${stats.reactionCount}`,
              `**Reactions:** ${stats.pointReactionCount}`
            ].join('\n'),
            inline: true
          },
          {
            name: 'Last Sync Scan',
            value: lastSyncResult
              ? [
                  `**Messages scanned:** ${lastSyncResult.scanned}`,
                  `**Channels checked:** ${lastSyncResult.channelsChecked || 0}`,
                  `**New/updated plays:** ${lastSyncResult.tracked}`,
                  `**Errors:** ${(lastSyncResult.channelErrors || 0) + (lastSyncResult.messageErrors || 0)}`
                ].join('\n')
              : 'Not available yet',
            inline: true
          },
          {
            name: 'Rules',
            value: [
              `**Allowed sources:** ${allowedSources}`,
              `**Human messages:** ${config.allowHumanPlayAlerts ? 'On' : 'Off'}`,
              `**Skipped summary:** ${skippedSummary}`
            ].join('\n'),
            inline: false
          }
        )
        .setFooter({ text: 'BaliHQ Leaderboard' })
        .setTimestamp(new Date());
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  } catch (error) {
    console.error('interaction failed:', error);
    const payload = { content: `Command failed: ${error.message}`, flags: MessageFlags.Ephemeral };
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
