const fs = require('node:fs');
const path = require('node:path');

function nowIso() {
  return new Date().toISOString();
}

function createEmptyState(installedAtIso = nowIso()) {
  return {
    schemaVersion: 2,
    installedAtIso,
    lastSyncIso: null,
    plays: {},

    // Win/loss reactions. Key: messageId:userId
    reactions: {},

    // Reactor leaderboard points. Key: messageId:userId
    // A user gets 1 point per tracked message when they use a configured reactor-point emoji.
    pointReactions: {}
  };
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      this.state = createEmptyState();
      this.save();
      return;
    }

    const parsed = JSON.parse(raw);
    this.state = {
      ...createEmptyState(parsed.installedAtIso || nowIso()),
      ...parsed,
      schemaVersion: 2,
      plays: parsed.plays || {},
      reactions: parsed.reactions || {},
      pointReactions: parsed.pointReactions || {}
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  getStartIso(configTrackAfterIso) {
    return configTrackAfterIso || this.state.installedAtIso;
  }

  upsertPlay(play) {
    const existing = this.state.plays[play.messageId] || {};
    this.state.plays[play.messageId] = {
      ...existing,
      ...play,
      updatedAtIso: nowIso()
    };
    this.save();
    return this.state.plays[play.messageId];
  }

  getPlay(messageId) {
    return this.state.plays[messageId] || null;
  }

  reactionKey(messageId, userId) {
    return `${messageId}:${userId}`;
  }

  setUserResult(messageId, userId, result) {
    const key = this.reactionKey(messageId, userId);
    this.state.reactions[key] = {
      messageId,
      userId,
      result,
      updatedAtIso: nowIso()
    };
    this.save();
  }

  removeUserResult(messageId, userId) {
    const key = this.reactionKey(messageId, userId);
    delete this.state.reactions[key];
    this.save();
  }

  replaceMessageResults(messageId, resultByUserId) {
    for (const key of Object.keys(this.state.reactions)) {
      if (key.startsWith(`${messageId}:`)) delete this.state.reactions[key];
    }

    for (const [userId, result] of Object.entries(resultByUserId)) {
      this.state.reactions[this.reactionKey(messageId, userId)] = {
        messageId,
        userId,
        result,
        updatedAtIso: nowIso()
      };
    }

    this.save();
  }

  setUserPoint(messageId, userId) {
    const key = this.reactionKey(messageId, userId);
    this.state.pointReactions[key] = {
      messageId,
      userId,
      points: 1,
      updatedAtIso: nowIso()
    };
    this.save();
  }

  removeUserPoint(messageId, userId) {
    const key = this.reactionKey(messageId, userId);
    delete this.state.pointReactions[key];
    this.save();
  }

  replaceMessagePoints(messageId, userIds) {
    for (const key of Object.keys(this.state.pointReactions)) {
      if (key.startsWith(`${messageId}:`)) delete this.state.pointReactions[key];
    }

    for (const userId of userIds) {
      this.state.pointReactions[this.reactionKey(messageId, userId)] = {
        messageId,
        userId,
        points: 1,
        updatedAtIso: nowIso()
      };
    }

    this.save();
  }

  getUserRecord(userId) {
    let wins = 0;
    let losses = 0;

    for (const reaction of Object.values(this.state.reactions)) {
      if (reaction.userId !== userId) continue;
      if (!this.state.plays[reaction.messageId]) continue;
      if (reaction.result === 'win') wins += 1;
      if (reaction.result === 'loss') losses += 1;
    }

    return formatRecord(userId, wins, losses);
  }

  getUserPoints(userId) {
    let points = 0;

    for (const reaction of Object.values(this.state.pointReactions)) {
      if (reaction.userId !== userId) continue;
      if (!this.state.plays[reaction.messageId]) continue;
      points += Number(reaction.points || 1);
    }

    return { userId, points };
  }

  getWinLossLeaderboard(limit = 10) {
    const map = new Map();

    for (const reaction of Object.values(this.state.reactions)) {
      if (!this.state.plays[reaction.messageId]) continue;
      if (!map.has(reaction.userId)) {
        map.set(reaction.userId, { userId: reaction.userId, wins: 0, losses: 0 });
      }
      const row = map.get(reaction.userId);
      if (reaction.result === 'win') row.wins += 1;
      if (reaction.result === 'loss') row.losses += 1;
    }

    return Array.from(map.values())
      .map((row) => formatRecord(row.userId, row.wins, row.losses))
      .sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.winPct !== a.winPct) return b.winPct - a.winPct;
        return b.total - a.total;
      })
      .slice(0, limit);
  }

  getReactorsLeaderboard(limit = 10) {
    const map = new Map();

    for (const reaction of Object.values(this.state.pointReactions)) {
      if (!this.state.plays[reaction.messageId]) continue;
      if (!map.has(reaction.userId)) {
        map.set(reaction.userId, { userId: reaction.userId, points: 0 });
      }
      const row = map.get(reaction.userId);
      row.points += Number(reaction.points || 1);
    }

    return Array.from(map.values())
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return a.userId.localeCompare(b.userId);
      })
      .slice(0, limit);
  }

  // Backward-compatible alias for older code paths.
  getLeaderboard(limit = 10) {
    return this.getWinLossLeaderboard(limit);
  }

  setLastSyncNow() {
    this.state.lastSyncIso = nowIso();
    this.save();
  }

  stats() {
    return {
      installedAtIso: this.state.installedAtIso,
      lastSyncIso: this.state.lastSyncIso,
      playCount: Object.keys(this.state.plays).length,
      reactionCount: Object.keys(this.state.reactions).length,
      pointReactionCount: Object.keys(this.state.pointReactions).length
    };
  }
}

function formatRecord(userId, wins, losses) {
  const total = wins + losses;
  const winPct = total ? Number(((wins / total) * 100).toFixed(1)) : 0;
  return { userId, wins, losses, total, winPct };
}

module.exports = { Store, nowIso };
