const { SlashCommandBuilder } = require('discord.js');

const periodChoices = [
  { name: 'Weekly', value: 'weekly' },
  { name: 'Monthly', value: 'monthly' },
  { name: 'All Time', value: 'all_time' }
];

const commandData = [
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show a BaliHQ leaderboard.')
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Which leaderboard to show.')
        .addChoices(
          { name: 'Win / Loss', value: 'win_loss' },
          { name: 'Reactions', value: 'reactions' }
        )
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('Leaderboard time window.')
        .addChoices(...periodChoices)
    )
    .addIntegerOption((option) =>
      option
        .setName('limit')
        .setDescription('Number of users to show.')
        .setMinValue(1)
        .setMaxValue(25)
    ),

  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Show a user win/loss record and reaction count.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to check. Defaults to you.')
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('Record time window.')
        .addChoices(...periodChoices)
    ),

  new SlashCommandBuilder()
    .setName('botstatus')
    .setDescription('Show BaliHQ tracker status.')
];

module.exports = { commandData };
