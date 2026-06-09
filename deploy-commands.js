const { REST, Routes } = require('discord.js');
const { commandData } = require('./src/commands');
const { config } = require('./src/config');

const rest = new REST({ version: '10' }).setToken(config.token);

async function main() {
  const body = commandData.map((command) => command.toJSON());
  console.log(`Deploying ${body.length} BaliHQ slash commands...`);

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body }
  );

  console.log('Slash commands deployed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
