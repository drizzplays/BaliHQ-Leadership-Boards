const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder
} = require('discord.js');
const { config } = require('./config');
const { Store } = require('./store');

let sharp = null;
try {
  sharp = require('sharp');
} catch (error) {
  console.warn('Leaderboard image renderer unavailable:', error.message);
}

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

function cleanDisplayName(value) {
  const raw = String(value || '').trim() || 'Unknown User';
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[*_`~|>]/g, '')
    .replace(/@everyone/g, 'everyone')
    .replace(/@here/g, 'here')
    .slice(0, 32);
}

const displayNameCache = new Map();

async function resolveDisplayName(userId, guild = null) {
  const cacheKey = `${guild?.id || 'global'}:${userId}`;
  if (displayNameCache.has(cacheKey)) return displayNameCache.get(cacheKey);

  let name = null;

  if (guild) {
    try {
      const member = await guild.members.fetch(userId);
      name = member?.displayName || member?.user?.globalName || member?.user?.username;
    } catch (_) {
      // Fall back to global user lookup below.
    }
  }

  if (!name) {
    try {
      const user = await client.users.fetch(userId);
      name = user?.globalName || user?.username;
    } catch (_) {
      name = `User ${String(userId).slice(-4)}`;
    }
  }

  const cleaned = cleanDisplayName(name);
  displayNameCache.set(cacheKey, cleaned);
  return cleaned;
}



function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function trimPlainText(value, maxLength = 24) {
  const raw = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(0, maxLength - 1))}…`;
}

function rankMedal(rank) {
  if (rank === 1) return '1';
  if (rank === 2) return '2';
  if (rank === 3) return '3';
  return String(rank);
}

function medalFill(rank) {
  if (rank === 1) return '#F7C948';
  if (rank === 2) return '#AEB7C8';
  if (rank === 3) return '#C47A39';
  return '#263248';
}

function rowStroke(rank) {
  if (rank === 1) return '#F7C948';
  if (rank === 2) return '#AEB7C8';
  if (rank === 3) return '#C47A39';
  return '#2A364E';
}


let leaderboardLogoDataUriCache = null;
let leaderboardLogoDataUriAttempted = false;

async function fetchImageAsDataUri(url) {
  if (!url || typeof fetch !== 'function') return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`logo fetch failed: ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/png';
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

async function getLeaderboardLogoDataUri() {
  if (leaderboardLogoDataUriCache || leaderboardLogoDataUriAttempted) return leaderboardLogoDataUriCache;
  leaderboardLogoDataUriAttempted = true;

  const explicitLogoUrl = process.env.LEADERBOARD_LOGO_URL || process.env.BALIHQ_LOGO_URL;
  const botAvatarUrl = client.user?.displayAvatarURL
    ? client.user.displayAvatarURL({ extension: 'png', size: 256 })
    : null;

  const candidates = [explicitLogoUrl, botAvatarUrl].filter(Boolean);
  for (const url of candidates) {
    try {
      leaderboardLogoDataUriCache = await fetchImageAsDataUri(url);
      if (leaderboardLogoDataUriCache) return leaderboardLogoDataUriCache;
    } catch (error) {
      console.warn(`Leaderboard logo could not load from ${url}: ${error.message}`);
    }
  }

  return null;
}

function safeSvgText(value) {
  return escapeHtml(String(value || '').replace(/[\u0000-\u001F\u007F]/g, ''));
}

async function renderLeaderboardImage({ type, period, rows, stats, guild }) {
  if (!sharp) return null;

  const normalizedType = normalizeLeaderboardType(type);
  const normalizedPeriod = normalizePeriod(period);
  const isReactions = normalizedType === 'reactions';
  const accent = isReactions ? '#F6B73C' : '#17B7FF';
  const accentRgb = isReactions ? '246,183,60' : '23,183,255';
  const title = `${periodLabel(normalizedPeriod)} ${isReactions ? 'Reactions' : 'Win/Loss'} Leaderboard`;
  const subtitle = isReactions ? 'BaliHQ reaction standings' : 'BaliHQ graded play standings';
  const logoDataUri = await getLeaderboardLogoDataUri();

  const resolvedRows = [];
  for (const [index, row] of rows.entries()) {
    resolvedRows.push({
      ...row,
      rank: index + 1,
      name: await resolveDisplayName(row.userId, guild)
    });
  }

  const visibleRows = resolvedRows.slice(0, 10);
  const width = 1400;
  const outerPad = 42;
  const cardX = 68;
  const cardW = width - (cardX * 2);
  const rowHeight = 82;
  const rowGap = 12;
  const rowsStartY = 350;
  const rowsHeight = visibleRows.length ? (visibleRows.length * rowHeight) + ((visibleRows.length - 1) * rowGap) : 180;
  const height = rowsStartY + rowsHeight + 128;

  const metricValue = isReactions ? stats.pointReactionCount : stats.reactionCount;
  const metricLabel = isReactions ? 'total reactions' : 'total grades';
  const periodText = periodWindowText(normalizedPeriod);
  const updatedText = formatDateTime(new Date().toISOString()).replace(/, 2026|, 2027|, 2028/g, '');
  const nameMax = isReactions ? 34 : 28;

  const statCard = (x, label, value, w = 250) => `
    <rect x="${x}" y="220" width="${w}" height="74" rx="22" fill="rgba(255,255,255,0.058)" stroke="rgba(255,255,255,0.095)"/>
    <text x="${x + 24}" y="250" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="17" font-weight="800" letter-spacing="1.8" fill="#7F8DA8">${safeSvgText(label.toUpperCase())}</text>
    <text x="${x + 24}" y="279" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="25" font-weight="900" fill="#F8FAFC">${safeSvgText(value)}</text>
  `;

  const rowsSvg = visibleRows.length
    ? visibleRows.map((row, idx) => {
        const y = rowsStartY + idx * (rowHeight + rowGap);
        const rank = row.rank;
        const isTop = rank <= 3;
        const rankFill = rank === 1 ? '#F7C948' : rank === 2 ? '#B8C0D0' : rank === 3 ? '#CE7D35' : '#22314A';
        const rankText = rank <= 3 ? '#08101F' : '#D7E2F2';
        const stroke = rank === 1 ? '#F7C948' : rank === 2 ? '#9CA8BA' : rank === 3 ? '#B86C2E' : 'rgba(255,255,255,0.08)';
        const name = safeSvgText(trimPlainText(row.name, nameMax));
        const reactions = Number(row.reactions ?? row.points ?? 0);
        const record = isReactions ? '' : `${row.wins}-${row.losses}`;
        const pct = isReactions ? '' : `${cleanPct(row.winPct)}%`;
        const grades = isReactions ? '' : String(row.total);
        const rowFill = isTop ? `url(#rowGlow${rank})` : 'rgba(12,20,36,0.84)';
        const rankBadgeText = rank <= 3 ? ['1ST', '2ND', '3RD'][rank - 1] : `#${rank}`;

        if (isReactions) {
          return `
            <rect x="${cardX}" y="${y}" width="${cardW}" height="${rowHeight}" rx="22" fill="${rowFill}" stroke="${stroke}" stroke-opacity="${isTop ? '0.72' : '1'}"/>
            <rect x="${cardX}" y="${y}" width="5" height="${rowHeight}" rx="3" fill="${isTop ? rankFill : accent}" opacity="${isTop ? '1' : '0.38'}"/>
            <rect x="${cardX + 22}" y="${y + 20}" width="72" height="42" rx="21" fill="${rankFill}"/>
            <text x="${cardX + 58}" y="${y + 47}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="18" font-weight="900" fill="${rankText}">${rankBadgeText}</text>
            <text x="${cardX + 122}" y="${y + 36}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="29" font-weight="900" fill="#FFFFFF">${name}</text>
            <text x="${cardX + 122}" y="${y + 62}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="18" font-weight="700" fill="#93A3BD">reaction-point standings</text>
            <text x="${width - 160}" y="${y + 38}" text-anchor="end" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="34" font-weight="900" fill="#FFFFFF">${reactions}</text>
            <text x="${width - 160}" y="${y + 64}" text-anchor="end" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="18" font-weight="800" fill="#AAB8CF">${reactions === 1 ? 'REACTION' : 'REACTIONS'}</text>
          `;
        }

        return `
          <rect x="${cardX}" y="${y}" width="${cardW}" height="${rowHeight}" rx="22" fill="${rowFill}" stroke="${stroke}" stroke-opacity="${isTop ? '0.72' : '1'}"/>
          <rect x="${cardX}" y="${y}" width="5" height="${rowHeight}" rx="3" fill="${isTop ? rankFill : accent}" opacity="${isTop ? '1' : '0.38'}"/>
          <rect x="${cardX + 22}" y="${y + 20}" width="72" height="42" rx="21" fill="${rankFill}"/>
          <text x="${cardX + 58}" y="${y + 47}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="18" font-weight="900" fill="${rankText}">${rankBadgeText}</text>
          <text x="${cardX + 122}" y="${y + 36}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="29" font-weight="900" fill="#FFFFFF">${name}</text>
          <text x="${cardX + 122}" y="${y + 62}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="18" font-weight="700" fill="#93A3BD">${safeSvgText(row.total === 1 ? '1 graded play' : `${row.total} graded plays`)}</text>
          <text x="${width - 445}" y="${y + 51}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="30" font-weight="900" fill="#FFFFFF">${record}</text>
          <text x="${width - 270}" y="${y + 51}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="30" font-weight="900" fill="#FFFFFF">${pct}</text>
          <text x="${width - 118}" y="${y + 51}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="30" font-weight="900" fill="#FFFFFF">${grades}</text>
        `;
      }).join('')
    : `
      <rect x="${cardX}" y="${rowsStartY}" width="${cardW}" height="180" rx="28" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.10)"/>
      <text x="${width / 2}" y="${rowsStartY + 76}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="36" font-weight="900" fill="#FFFFFF">No tracked data yet</text>
      <text x="${width / 2}" y="${rowsStartY + 118}" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="22" font-weight="650" fill="#AAB5C8">New tracked plays and reactions will populate this board automatically.</text>
    `;

  const columnHeader = isReactions
    ? `
      <text x="${cardX + 22}" y="330" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">RANK</text>
      <text x="${cardX + 122}" y="330" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">MEMBER</text>
      <text x="${width - 160}" y="330" text-anchor="end" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">REACTIONS</text>
    `
    : `
      <text x="${cardX + 22}" y="330" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">RANK</text>
      <text x="${cardX + 122}" y="330" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">MEMBER</text>
      <text x="${width - 445}" y="330" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">RECORD</text>
      <text x="${width - 270}" y="330" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">WIN RATE</text>
      <text x="${width - 118}" y="330" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="900" letter-spacing="1.6" fill="#6F7F9B">GRADES</text>
    `;

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#050914"/>
        <stop offset="0.48" stop-color="#091224"/>
        <stop offset="1" stop-color="#06101F"/>
      </linearGradient>
      <radialGradient id="accentGlow" cx="78%" cy="8%" r="52%">
        <stop offset="0" stop-color="${accent}" stop-opacity="0.34"/>
        <stop offset="0.45" stop-color="${accent}" stop-opacity="0.10"/>
        <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="rgba(18,31,55,0.94)"/>
        <stop offset="0.55" stop-color="rgba(9,17,32,0.96)"/>
        <stop offset="1" stop-color="rgba(5,10,20,0.98)"/>
      </linearGradient>
      <linearGradient id="rowGlow1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(247,201,72,0.22)"/><stop offset="0.45" stop-color="rgba(29,35,48,0.90)"/><stop offset="1" stop-color="rgba(9,17,32,0.96)"/></linearGradient>
      <linearGradient id="rowGlow2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(184,192,208,0.18)"/><stop offset="0.45" stop-color="rgba(26,35,51,0.90)"/><stop offset="1" stop-color="rgba(9,17,32,0.96)"/></linearGradient>
      <linearGradient id="rowGlow3" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(206,125,53,0.20)"/><stop offset="0.45" stop-color="rgba(29,35,48,0.90)"/><stop offset="1" stop-color="rgba(9,17,32,0.96)"/></linearGradient>
      <clipPath id="logoClip"><circle cx="130" cy="116" r="58"/></clipPath>
      <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="20" stdDeviation="18" flood-color="#000000" flood-opacity="0.42"/></filter>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <rect width="${width}" height="${height}" fill="url(#accentGlow)"/>
    <rect x="${outerPad}" y="${outerPad}" width="${width - outerPad * 2}" height="${height - outerPad * 2}" rx="36" fill="url(#panel)" stroke="rgba(255,255,255,0.11)" filter="url(#cardShadow)"/>
    <rect x="${outerPad}" y="${outerPad}" width="7" height="${height - outerPad * 2}" rx="3.5" fill="${accent}"/>

    <circle cx="130" cy="116" r="64" fill="rgba(255,255,255,0.055)" stroke="${accent}" stroke-width="4"/>
    ${logoDataUri ? `<image href="${logoDataUri}" x="72" y="58" width="116" height="116" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice"/>` : `<text x="130" y="125" text-anchor="middle" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="28" font-weight="900" fill="#FFFFFF">BHQ</text>`}

    <rect x="215" y="66" width="142" height="31" rx="15.5" fill="rgba(${accentRgb},0.16)" stroke="rgba(${accentRgb},0.38)"/>
    <text x="236" y="88" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="15" font-weight="900" letter-spacing="2.3" fill="${accent}">BALI HQ</text>
    <text x="215" y="145" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="52" font-weight="900" fill="#FFFFFF">${safeSvgText(title)}</text>
    <text x="215" y="186" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="24" font-weight="700" fill="#AEBBD2">${safeSvgText(subtitle)}</text>

    ${statCard(68, 'Window', periodText, 300)}
    ${statCard(388, 'Tracked Plays', `${stats.playCount}`, 230)}
    ${statCard(638, metricLabel, `${metricValue}`, 230)}
    <rect x="${width - 315}" y="220" width="247" height="74" rx="22" fill="rgba(${accentRgb},0.12)" stroke="rgba(${accentRgb},0.24)"/>
    <text x="${width - 291}" y="250" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="17" font-weight="800" letter-spacing="1.8" fill="#7F8DA8">UPDATED</text>
    <text x="${width - 291}" y="279" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="25" font-weight="900" fill="#F8FAFC">${safeSvgText(updatedText)}</text>

    ${columnHeader}
    <line x1="${cardX}" y1="340" x2="${width - cardX}" y2="340" stroke="rgba(255,255,255,0.08)"/>
    ${rowsSvg}

    <text x="68" y="${height - 58}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="19" font-weight="800" letter-spacing="1.8" fill="#667792">BALI HQ LEADERBOARD SYSTEM</text>
    <text x="${width - 68}" y="${height - 58}" text-anchor="end" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="19" font-weight="700" fill="#8190AA">${safeSvgText(periodText)} • Top ${visibleRows.length || 0}</text>
  </svg>`;

  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const fileName = `balihq-${normalizedType}-${normalizedPeriod}-leaderboard.png`;
  return new AttachmentBuilder(buffer, { name: fileName });
}
async function leaderboardImageReply(type, limit, period = 'all_time', guild = null) {
  const normalizedType = normalizeLeaderboardType(type);
  const normalizedPeriod = normalizePeriod(period);
  const stats = store.statsForPeriod ? store.statsForPeriod(normalizedPeriod) : store.stats();
  const rows = normalizedType === 'reactions'
    ? (store.getReactionsLeaderboard ? store.getReactionsLeaderboard(limit, normalizedPeriod) : store.getReactorsLeaderboard(limit, normalizedPeriod))
    : store.getWinLossLeaderboard(limit, normalizedPeriod);

  try {
    const attachment = await renderLeaderboardImage({
      type: normalizedType,
      period: normalizedPeriod,
      rows,
      stats,
      guild
    });

    return { attachment, rows, stats, error: null };
  } catch (error) {
    console.error('Image leaderboard render failed:', error);
    return { attachment: null, rows, stats, error };
  }
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

async function winLossLeaderboardEmbed(limit, period = 'all_time', guild = null) {
  const normalizedPeriod = normalizePeriod(period);
  const rows = store.getWinLossLeaderboard(limit, normalizedPeriod);
  const stats = store.statsForPeriod ? store.statsForPeriod(normalizedPeriod) : store.stats();

  const embed = new EmbedBuilder()
    .setColor(0x00AEEF)
    .setTitle(leaderboardHeader('win_loss', normalizedPeriod))
    .setFooter({ text: `BaliHQ Leaderboard • ${periodWindowText(normalizedPeriod)} • ${plural(stats.playCount, 'tracked play')} • ${plural(stats.reactionCount, 'grade')}` })
    .setTimestamp(new Date());

  if (!rows.length) {
    return embed.setDescription(`No win/loss grades tracked for **${periodWindowText(normalizedPeriod)}** yet.`);
  }

  const lines = [];
  for (const [index, row] of rows.entries()) {
    const name = await resolveDisplayName(row.userId, guild);
    const pct = cleanPct(row.winPct);
    lines.push(`${rankBadge(index)} **${name}** — **${row.wins}-${row.losses}** · **${pct}%** · ${plural(row.total, 'grade')}`);
  }

  return embed.setDescription([
    `BaliHQ graded play results • **${periodWindowText(normalizedPeriod)}**`,
    '',
    ...lines
  ].join('\n'));
}

async function reactionsLeaderboardEmbed(limit, period = 'all_time', guild = null) {
  const normalizedPeriod = normalizePeriod(period);
  const rows = store.getReactionsLeaderboard
    ? store.getReactionsLeaderboard(limit, normalizedPeriod)
    : store.getReactorsLeaderboard(limit, normalizedPeriod);
  const stats = store.statsForPeriod ? store.statsForPeriod(normalizedPeriod) : store.stats();

  const embed = new EmbedBuilder()
    .setColor(0xFFB000)
    .setTitle(leaderboardHeader('reactions', normalizedPeriod))
    .setFooter({ text: `BaliHQ Leaderboard • ${periodWindowText(normalizedPeriod)} • ${plural(stats.playCount, 'tracked play')} • ${plural(stats.pointReactionCount, 'reaction')}` })
    .setTimestamp(new Date());

  if (!rows.length) {
    return embed.setDescription(`No reaction points tracked for **${periodWindowText(normalizedPeriod)}** yet.`);
  }

  const lines = [];
  for (const [index, row] of rows.entries()) {
    const name = await resolveDisplayName(row.userId, guild);
    const reactions = Number(row.reactions ?? row.points ?? 0);
    lines.push(`${rankBadge(index)} **${name}** — **${plural(reactions, 'reaction')}**`);
  }

  return embed.setDescription([
    `BaliHQ reaction leaderboard • **${periodWindowText(normalizedPeriod)}**`,
    '',
    ...lines
  ].join('\n'));
}

async function leaderboardEmbed(type, limit, period = 'all_time', guild = null) {
  const normalizedType = normalizeLeaderboardType(type);
  if (normalizedType === 'reactions') return reactionsLeaderboardEmbed(limit, period, guild);
  return winLossLeaderboardEmbed(limit, period, guild);
}

async function recordEmbed(userId, period = 'all_time', guild = null) {
  const normalizedPeriod = normalizePeriod(period);
  const row = store.getUserRecord(userId, normalizedPeriod);
  const reactionRow = store.getUserPoints(userId, normalizedPeriod);
  const pct = cleanPct(row.winPct);
  const name = await resolveDisplayName(userId, guild);

  return new EmbedBuilder()
    .setColor(0x00AEEF)
    .setTitle(`📌 BaliHQ ${periodLabel(normalizedPeriod)} Member Record`)
    .setDescription(`**${name}** • ${periodWindowText(normalizedPeriod)}`)
    .addFields(
      {
        name: 'Win/Loss',
        value: `**${row.wins}-${row.losses}** · **${pct}%** · ${plural(row.total, 'grade')}`,
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

      const { attachment, error } = await leaderboardImageReply(type, limit, period, interaction.guild);
      if (attachment) {
        await interaction.editReply({ files: [attachment] });
      } else {
        await interaction.editReply({
          content: error ? `Image leaderboard failed to render: ${error.message}` : 'Image leaderboard renderer is unavailable. Showing fallback embed.',
          embeds: [await leaderboardEmbed(type, limit, period, interaction.guild)]
        });
      }
      return;
    }

    if (interaction.commandName === 'record') {
      const user = interaction.options.getUser('user') || interaction.user;
      const period = interaction.options.getString('period') || 'all_time';
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await runRecentSync('record-command');
      await interaction.editReply({ embeds: [await recordEmbed(user.id, period, interaction.guild)] });
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
