const { SlashCommandBuilder } = require('discord.js');

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
          { name: 'Reactors', value: 'reactors' }
        )
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
    .setDescription('Show a user record and reactor points.')
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('User to check. Defaults to you.')
    ),

  new SlashCommandBuilder()
    .setName('botstatus')
    .setDescription('Show BaliHQ tracker status.')
];

module.exports = { commandData };
