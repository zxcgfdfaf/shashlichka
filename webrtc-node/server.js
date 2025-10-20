const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const cors = require("cors");
const config = require("./config");

const app = express();
app.use(cors());
app.use(express.json());

// Remove CSP headers that might be set elsewhere
app.use((req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('X-Content-Security-Policy');
  res.removeHeader('X-WebKit-CSP');
  next();
});

// Serve static files from configured path
app.use(config.urlPrefix, express.static(config.publicPath));

const server = http.createServer(app);
const io = new Server(server, {
  path: config.socketPath,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let worker;
let router;

// Centralized state management
const RoomState = {
  // User management
  users: new Map(), // socketId -> { name, userIndex, videoEnabled, audioEnabled }
  availableIndexes: Array.from({ length: config.maxUsers }, (_, i) => i), // Available user indexes

  // Media management
  transports: new Map(), // transportId -> { transport, socketId, direction }
  producers: new Map(), // producerId -> { producer, socketId, kind, source, presentationIndex }
  screenProducers: new Map(), // producerId -> producer (for quick screen count)

  // Counters - FIXED: Separate indexes for users and presentations
  userCounter: 0,
  presentationCounter: 0,
  availablePresentationIndexes: Array.from({ length: config.maxScreenShares }, (_, i) => i), // Available presentation indexes

  // Constants from config
  MAX_USERS: config.maxUsers,
  MAX_SCREEN_SHARES: config.maxScreenShares,

  // Helper methods
  isRoomFull() {
    return this.users.size >= this.MAX_USERS;
  },

  getScreenShareCount() {
    return this.screenProducers.size;
  },

  getNextUserIndex() {
    return this.availableIndexes.length > 0 ? this.availableIndexes.shift() : null;
  },

  releaseUserIndex(userIndex) {
    if (userIndex !== null && userIndex >= 0 && userIndex < this.MAX_USERS) {
      this.availableIndexes.push(userIndex);
      this.availableIndexes.sort((a, b) => a - b);
    }
  },

  // FIXED: Presentation index management like user indexes
  getNextPresentationIndex() {
    return this.availablePresentationIndexes.length > 0 ? this.availablePresentationIndexes.shift() : null;
  },

  releasePresentationIndex(presentationIndex) {
    if (presentationIndex !== null && presentationIndex >= 0 && presentationIndex < this.MAX_SCREEN_SHARES) {
      this.availablePresentationIndexes.push(presentationIndex);
      this.availablePresentationIndexes.sort((a, b) => a - b);
    }
  },

  getUserBySocketId(socketId) {
    return this.users.get(socketId);
  },

  getProducersForUser(socketId) {
    const userProducers = [];
    this.producers.forEach((producerData, producerId) => {
      if (producerData.socketId === socketId) {
        userProducers.push({
          id: producerId,
          ...producerData
        });
      }
    });
    return userProducers;
  },

  getAllProducers() {
    const producersList = [];
    this.producers.forEach((producerData, producerId) => {
      const userState = this.users.get(producerData.socketId);
      const peerName = userState ? userState.name : 'Unknown';

      producersList.push({
        id: producerId,
        socketId: producerData.socketId,
        kind: producerData.kind,
        source: producerData.source,
        peerName: peerName,
        isScreen: producerData.source === 'screen',
        userIndex: userState ? userState.userIndex : 0,
        presentationIndex: producerData.presentationIndex
      });
    });
    return producersList;
  },

  getAllUsers(excludeSocketId = null) {
    const usersList = [];
    this.users.forEach((userState, socketId) => {
      if (socketId !== excludeSocketId) {
        usersList.push({
          socketId: socketId,
          name: userState.name,
          userIndex: userState.userIndex,
          videoEnabled: userState.videoEnabled,
          audioEnabled: userState.audioEnabled
        });
      }
    });
    return usersList;
  },

  // New method to remove user screen shares
  removeUserScreenShares(socketId) {
    const removedProducers = [];
    this.producers.forEach((producerData, producerId) => {
      if (producerData.socketId === socketId && producerData.source === 'screen') {
        // Release the presentation index
        if (producerData.presentationIndex !== null) {
          this.releasePresentationIndex(producerData.presentationIndex);
        }
        
        if (producerData.producer) {
          producerData.producer.close();
        }
        this.producers.delete(producerId);
        this.screenProducers.delete(producerId);
        removedProducers.push(producerId);
      }
    });
    return removedProducers;
  },

  // Cleanup methods
  cleanupUser(socketId) {
    const userState = this.users.get(socketId);

    // Remove user
    this.users.delete(socketId);

    // Release user index
    if (userState) {
      this.releaseUserIndex(userState.userIndex);
    }

    // Remove producers and release presentation indexes
    this.producers.forEach((producerData, producerId) => {
      if (producerData.socketId === socketId) {
        if (producerData.source === 'screen') {
          // Release presentation index for screen shares
          if (producerData.presentationIndex !== null) {
            this.releasePresentationIndex(producerData.presentationIndex);
          }
          this.screenProducers.delete(producerId);
        }
        if (producerData.producer) {
          producerData.producer.close();
        }
        this.producers.delete(producerId);
      }
    });

    // Remove transports
    this.transports.forEach((transportData, transportId) => {
      if (transportData.socketId === socketId) {
        if (transportData.transport) {
          transportData.transport.close();
        }
        this.transports.delete(transportId);
      }
    });
  },

  // Debug method
  printState() {
    console.log('\n=== ROOM STATE ===');
    console.log(`Users: ${this.users.size}/${this.MAX_USERS}`);
    console.log(`Available user indexes: [${this.availableIndexes.join(', ')}]`);
    console.log(`Screen shares: ${this.screenProducers.size}/${this.MAX_SCREEN_SHARES}`);
    console.log(`Available presentation indexes: [${this.availablePresentationIndexes.join(', ')}]`);
    console.log(`Transports: ${this.transports.size}`);
    console.log(`Producers: ${this.producers.size}`);
    console.log('==================\n');
  }
};

// Initialize mediasoup
(async () => {
  try {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
      mediaCodecs: config.mediaCodecs
    });
    console.log("✅ Mediasoup worker and router ready");
  } catch (error) {
    console.error("Failed to initialize mediasoup:", error);
  }
})();

// Serve HTML with injected configuration
app.get(`${config.urlPrefix}/`, (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebRTC Conference</title>
    <link rel="stylesheet" href="${config.urlPrefix}/style.css">
    <script>
        // Injected server configuration
        window.SERVER_CONFIG = {
            SOCKET_URL: "",
            URL_PREFIX: "${config.urlPrefix}",
            SOCKET_PATH: "${config.socketPath}",
            MAX_USERS: ${config.maxUsers},
            MAX_SCREEN_SHARES: ${config.maxScreenShares}
        };
    </script>
</head>
<body>
    <div class="container">
        <header class="header">
            <h1>WebRTC Video Conference</h1>
            <p class="subtitle">Real-time peer-to-peer video communication with screen sharing</p>
        </header>

        <div class="controls">
            <div class="join-section">
                <input type="text" id="username" placeholder="Enter your name" value="User">
                <button id="startBtn">Join Conference</button>
            </div>
            <div class="media-controls" id="mediaControls">
                <button class="control-btn screen-btn" id="screenShareBtn">
                    📺 Share Screen
                </button>
                <button class="control-btn video-btn active" id="toggleVideoBtn">
                    📹 Video On
                </button>
                <button class="control-btn audio-btn active" id="toggleAudioBtn">
                    🎤 Audio On
                </button>
            </div>
        </div>

        <div class="room-status" id="roomStatus">
            Users: <span id="peerCount">0</span>/${config.maxUsers} | Presentations: <span id="screenCount">0</span>/${config.maxScreenShares}
        </div>

        <!-- Users Grid -->
        <div class="video-grid" id="peersContainer">
            <div class="video-wrapper self">
                <div class="video-header">
                    <div class="video-title">You</div>
                    <div class="screen-number">scr0</div>
                    <div class="video-status" id="localStatus">Ready</div>
                </div>
                <video id="localVideo" autoplay muted playsinline></video>
            </div>
        </div>

        <!-- Presentations Section (will be dynamically created) -->
    </div>

    <!-- Video Switcher -->
    <div id="videoSwitcher" class="video-switcher">
        <div class="video-switcher-header">
            <div class="video-switcher-title">Rearrange Videos</div>
            <button class="video-switcher-close">&times;</button>
        </div>
        <div class="video-switcher-list" id="videoSwitcherList">
            <!-- Video sources will be populated here -->
        </div>
    </div>

    <!-- Swap Instructions - UPDATED -->
    <div id="swapInstructions" class="swap-instructions" style="display: none;">
        <h3>🎯 Swap Mode Active</h3>
        <p><strong>Source selected:</strong> <span id="swapSourceDisplay">scr0</span></p>
        <p>Now click on any other video in the grid to swap positions</p>
        <button class="swap-mode-btn exit" onclick="window.conference.cancelSwap()">Cancel Swap</button>
    </div>

    <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
    <script src="${config.urlPrefix}/mediasoup.bundle.js"></script>
    <script src="${config.urlPrefix}/client.js"></script>
</body>
</html>`;
  res.send(html);
});

// HTTP endpoints
app.get(`${config.urlPrefix}/router-rtp-capabilities`, (req, res) => {
  res.json(router.rtpCapabilities);
});

app.post(`${config.urlPrefix}/create-transport`, async (req, res) => {
  try {
    const { socketId, direction } = req.body;

    if (!socketId) {
      return res.status(400).json({ error: "Socket ID is required" });
    }

    // Only check room capacity for NEW users, not existing ones
    if (direction === 'send') {
      const userState = RoomState.getUserBySocketId(socketId);
      // Only check room capacity if this user isn't already in the room
      if (!userState && RoomState.isRoomFull()) {
        return res.status(403).json({ error: `Room is full. Maximum ${config.maxUsers} users allowed.` });
      }
    }

    const transport = await router.createWebRtcTransport({
      listenIps: [
        {
          ip: config.listenIp,
          announcedIp: config.announcedIp
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: config.initialOutgoingBitrate,
    });

    RoomState.transports.set(transport.id, {
      transport,
      socketId,
      direction
    });

    console.log(`🚚 Created ${direction} transport for ${socketId}: ${transport.id}`);

    res.json({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });
  } catch (error) {
    console.error("Error creating transport:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${config.urlPrefix}/connect-transport`, async (req, res) => {
  try {
    const { transportId, dtlsParameters } = req.body;
    const transportData = RoomState.transports.get(transportId);

    if (!transportData) {
      return res.status(404).json({ error: "Transport not found" });
    }

    await transportData.transport.connect({ dtlsParameters });
    res.json({ success: true });
  } catch (error) {
    console.error("Error connecting transport:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${config.urlPrefix}/produce`, async (req, res) => {
  try {
    const { transportId, kind, rtpParameters, socketId, source } = req.body;
    const transportData = RoomState.transports.get(transportId);

    if (!transportData) {
      return res.status(404).json({ error: "Transport not found" });
    }

    if (source === 'screen') {
      if (RoomState.getScreenShareCount() >= RoomState.MAX_SCREEN_SHARES) {
        return res.status(403).json({ error: `Maximum ${config.maxScreenShares} screen shares allowed` });
      }
    }

    const producer = await transportData.transport.produce({
      kind,
      rtpParameters
    });

    const producerData = {
      producer,
      socketId,
      kind,
      source: source || 'camera'
    };

    const userState = RoomState.getUserBySocketId(socketId);
    const peerName = userState ? userState.name : 'Unknown';

    if (source === 'screen') {
      // FIXED: Get presentation index from available pool
      const presentationIndex = RoomState.getNextPresentationIndex();
      if (presentationIndex === null) {
        return res.status(403).json({ error: `Maximum ${config.maxScreenShares} screen shares allowed` });
      }
      
      producerData.presentationIndex = presentationIndex;
      RoomState.screenProducers.set(producer.id, producer);

      console.log(`🖥️ New screen share from ${socketId}: ${producer.id} (pr${presentationIndex})`);

      // Broadcast to ALL users INCLUDING the sender
      io.emit("new-presentation", {
        id: producer.id,
        socketId: socketId,
        kind: kind,
        peerName: peerName,
        presentationIndex: presentationIndex
      });

      console.log(`📢 Broadcasted new-presentation to ALL users including sender`);

      // Update room status when screen share starts
      io.emit('room-status', {
        userCount: RoomState.users.size,
        maxUsers: RoomState.MAX_USERS,
        screenShareCount: RoomState.getScreenShareCount()
      });
      console.log(`📊 Updated room status: ${RoomState.getScreenShareCount()} screen shares`);

    } else {
      console.log(`🎥 New ${kind} producer from ${socketId}: ${producer.id} (${source})`);

      // Notify about new user producer - Broadcast to all except sender
      socketId && io.except(socketId).emit("new-producer", {
        id: producer.id,
        socketId: socketId,
        kind: kind,
        source: source || 'camera',
        peerName: peerName,
        userIndex: userState ? userState.userIndex : 0
      });
    }

    RoomState.producers.set(producer.id, producerData);
    res.json({ id: producer.id });
  } catch (error) {
    console.error("Error creating producer:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post(`${config.urlPrefix}/consume`, async (req, res) => {
  try {
    const { transportId, producerId, rtpCapabilities } = req.body;
    const transportData = RoomState.transports.get(transportId);
    const producerData = RoomState.producers.get(producerId);

    if (!transportData) {
      return res.status(404).json({ error: "Transport not found" });
    }

    if (!producerData) {
      return res.status(404).json({ error: "Producer not found" });
    }

    if (!router.canConsume({ producerId, rtpCapabilities })) {
      return res.status(400).json({ error: "Cannot consume" });
    }

    const consumer = await transportData.transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    res.json({
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  } catch (error) {
    console.error("Error creating consumer:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get(`${config.urlPrefix}/producers`, (req, res) => {
  res.json(RoomState.getAllProducers());
});

app.get(`${config.urlPrefix}/room-state`, (req, res) => {
  res.json({
    users: RoomState.getAllUsers(),
    producers: RoomState.getAllProducers(),
    userCount: RoomState.users.size,
    maxUsers: RoomState.MAX_USERS,
    screenShareCount: RoomState.getScreenShareCount(),
    maxScreenShares: RoomState.MAX_SCREEN_SHARES,
    availableIndexes: RoomState.availableIndexes,
    availablePresentationIndexes: RoomState.availablePresentationIndexes
  });
});

// Socket.IO
io.on("connection", (socket) => {
  console.log("🔌 New socket connection:", socket.id);

  if (RoomState.isRoomFull()) {
    socket.emit('room-full');
    socket.disconnect();
    console.log(`❌ Rejected connection from ${socket.id}: room full`);
    return;
  }

  // Assign user index from available pool
  const userIndex = RoomState.getNextUserIndex();
  if (userIndex === null) {
    socket.emit('room-full');
    socket.disconnect();
    console.log(`❌ No available user index for ${socket.id}`);
    return;
  }

  RoomState.users.set(socket.id, {
    id: socket.id,
    name: "Anonymous",
    videoEnabled: true,
    audioEnabled: true,
    userIndex: userIndex
  });

  console.log(`✅ Peer connected: ${socket.id} assigned index: scr${userIndex}`);
  RoomState.printState();

  // Send initial data to the new user
  socket.emit('init', {
    userIndex: userIndex,
    currentUsers: RoomState.getAllUsers(socket.id),
    currentProducers: RoomState.getAllProducers()
  });

  // Notify others about new user
  socket.broadcast.emit("user-joined", {
    socketId: socket.id,
    name: "Anonymous",
    userIndex: userIndex,
    videoEnabled: true,
    audioEnabled: true
  });

  // Update room status for everyone
  io.emit('room-status', {
    userCount: RoomState.users.size,
    maxUsers: RoomState.MAX_USERS,
    screenShareCount: RoomState.getScreenShareCount()
  });

  socket.on("set-name", (name) => {
    const userState = RoomState.getUserBySocketId(socket.id);
    if (userState) {
      userState.name = name;
      console.log(`📛 Peer ${socket.id} set name to: ${name}`);

      socket.broadcast.emit("user-updated", {
        socketId: socket.id,
        name: name,
        videoEnabled: userState.videoEnabled,
        audioEnabled: userState.audioEnabled,
        userIndex: userState.userIndex
      });

      io.emit('room-status', {
        userCount: RoomState.users.size,
        maxUsers: RoomState.MAX_USERS,
        screenShareCount: RoomState.getScreenShareCount()
      });
    }
  });

  socket.on("toggle-video", (data) => {
    const userState = RoomState.getUserBySocketId(socket.id);
    if (userState) {
      userState.videoEnabled = data.enabled;
      socket.broadcast.emit("user-video-toggled", {
        socketId: socket.id,
        enabled: data.enabled
      });
    }
  });

  socket.on("toggle-audio", (data) => {
    const userState = RoomState.getUserBySocketId(socket.id);
    if (userState) {
      userState.audioEnabled = data.enabled;
      socket.broadcast.emit("user-audio-toggled", {
        socketId: socket.id,
        enabled: data.enabled
      });
    }
  });

  // New event for screen share stop
  socket.on("stop-screen-share", () => {
    console.log(`🖥️ User ${socket.id} stopped screen sharing`);

    const removedProducers = RoomState.removeUserScreenShares(socket.id);

    // Notify all clients about ended presentations
    removedProducers.forEach(producerId => {
      io.emit("presentation-ended", {
        producerId: producerId,
        socketId: socket.id
      });
    });

    // Update room status IMMEDIATELY after removal
    io.emit('room-status', {
      userCount: RoomState.users.size,
      maxUsers: RoomState.MAX_USERS,
      screenShareCount: RoomState.getScreenShareCount()
    });

    console.log(`🗑️ Removed ${removedProducers.length} screen producers for ${socket.id}, current sreen shares: ${RoomState.getScreenShareCount()}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Peer disconnected:", socket.id);

    // Get user state before cleanup
    const userState = RoomState.getUserBySocketId(socket.id);

    // Clean up all user resources
    RoomState.cleanupUser(socket.id);

    // Notify about user left
    socket.broadcast.emit("user-left", {
      socketId: socket.id
    });

    // Notify about ended presentations for this user
    RoomState.producers.forEach((producerData, producerId) => {
      if (producerData.socketId === socket.id && producerData.source === 'screen') {
        io.emit("presentation-ended", {
          producerId: producerId
        });
      }
    });

    // Update room status
    io.emit('room-status', {
      userCount: RoomState.users.size,
      maxUsers: RoomState.MAX_USERS,
      screenShareCount: RoomState.getScreenShareCount()
    });

    console.log(`🗑️ Cleaned up resources for ${socket.id}`);
    if (userState) {
      console.log(`📊 Released user index: scr${userState.userIndex}`);
    }
    RoomState.printState();
  });
});

// Reset state when server starts
function resetServerState() {
  RoomState.users.clear();
  RoomState.transports.clear();
  RoomState.producers.clear();
  RoomState.screenProducers.clear();
  RoomState.availableIndexes = Array.from({ length: config.maxUsers }, (_, i) => i);
  RoomState.availablePresentationIndexes = Array.from({ length: config.maxScreenShares }, (_, i) => i);
  RoomState.userCounter = 0;
  RoomState.presentationCounter = 0;

  console.log("🔄 Server state reset complete");
}

server.listen(config.port, () => {
  resetServerState();
  console.log("🚀 Server running on port", config.port);
  console.log(`👥 User limit: ${config.maxUsers} users`);
  console.log(`🖥️ Screen share limit: ${config.maxScreenShares} simultaneous shares`);
  console.log("✅ STUN servers configured for NAT traversal");
  console.log(`📊 Available user indexes: [${Array.from({ length: config.maxUsers }, (_, i) => i).join(', ')}]`);
  console.log(`📊 Available presentation indexes: [${Array.from({ length: config.maxScreenShares }, (_, i) => i).join(', ')}]`);
  console.log(`🌐 URL prefix: ${config.urlPrefix}`);
  console.log(`🔌 Socket path: ${config.socketPath}`);
  console.log(`📡 Announced IP: ${config.announcedIp}`);
});
