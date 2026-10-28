require('dotenv').config();
const { ChatClient } = require('@twurple/chat');

const client = new ChatClient({ channels: ['minusnd'] });
client.onConnect(() => console.log("Connected to IRC"));
client.onJoin((channel, user) => console.log(`Joined ${channel} as ${user}`));
client.onMessage((channel, user, text, msg) => {
    console.log(`[MSG] ${channel} - ${user}: ${text}`);
    console.log("Keys of msg:", Object.keys(msg));
    console.log("msg.channelId:", msg.channelId);
    console.log("msg.targetChannelId:", msg.targetChannelId);
    console.log("msg.userInfo:", msg.userInfo ? Object.keys(msg.userInfo) : null);
    if (msg.userInfo) {
        console.log("msg.userInfo.userId:", msg.userInfo.userId);
        console.log("msg.userInfo.userName:", msg.userInfo.userName);
    }
});
client.onDisconnect((manually, reason) => console.error("Disconnected:", manually, reason));
client.connect();
