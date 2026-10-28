const { ChatClient } = require('@twurple/chat');
const client = new ChatClient({ channels: ['minusnd'] });
client.connect();
client.onMessage((channel, user, text) => {
    console.log('[RAW]', channel, user, text);
});
