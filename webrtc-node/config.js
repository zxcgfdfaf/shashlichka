const path = require('path');

// Load environment variables
require('dotenv').config();

const config = {
  // Server
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Room limits
  maxUsers: parseInt(process.env.MAX_USERS) || 3,
  maxScreenShares: parseInt(process.env.MAX_SCREEN_SHARES) || 2,
  
  // URL configuration
  urlPrefix: process.env.URL_PREFIX || '/zzy',
  socketPath: process.env.SOCKET_PATH || '/zzy/socket.io',
  
  // Network configuration
  announcedIp: process.env.ANNOUNCED_IP || '193.178.169.164',
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  
  // Media configuration
  initialOutgoingBitrate: parseInt(process.env.INITIAL_OUTGOING_BITRATE) || 1000000,
  
  // Derived paths
  get publicPath() {
    return path.join(__dirname, 'public');
  },
  
  // Media codecs (static configuration)
  mediaCodecs: [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
      parameters: {
        minptime: 10,
        useinbandfec: 1
      }
    },
    {
      kind: "video",
      mimeType: "video/VP8",
      clockRate: 90000,
    }
  ]
};

// Validate required environment variables
const required = ['ANNOUNCED_IP'];
required.forEach(key => {
  if (!process.env[key]) {
    console.warn(`⚠️  Warning: ${key} environment variable is not set`);
  }
});

module.exports = config;
