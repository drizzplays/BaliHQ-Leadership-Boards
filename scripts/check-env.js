try {
  const { config } = require('../src/config');
  console.log('Environment looks usable.');
  console.log({
    clientId: config.clientId,
    guildId: config.guildId,
    trackChannelIds: config.trackChannelIds,
    requireWebhook: config.requireWebhook,
    winEmojis: config.winEmojis,
    lossEmojis: config.lossEmojis,
    reactorPointEmojis: config.reactorPointEmojis,
    dataFile: config.dataFile
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
