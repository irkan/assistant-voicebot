const ariClient = require('ari-client');
const { spawn } = require('child_process');
const dgram = require('dgram');
const http = require('http');
const url = require('url');
['log', 'warn', 'error'].forEach(method => {
  const original = console[method];
  console[method] = (...args) => {
    const timestamp = new Date().toISOString();
    original(`[${timestamp}]`, ...args);
  };
});
// Promise wrapper for socket binding
function bindSocket(socket, port, address) {
  return new Promise((resolve, reject) => {
    socket.bind(port, address, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(socket.address());
      }
    });
  });
}

const ASTERISK_URL = 'http://localhost:8088';
const ASTERISK_USERNAME = 'voicebot_user';         
const ASTERISK_PASSWORD = 'SuperGucluParol123';
const ARI_APP_NAME = 'voicebot_app';
const HTTP_PORT = 8098;

(async () => {
  const client = await ariClient.connect(ASTERISK_URL, ASTERISK_USERNAME, ASTERISK_PASSWORD);
  console.log('ARI connection successfully established!');

  const activeChannels = new Map();

  // Create HTTP server for originating calls
  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.pathname === '/originate' && req.method === 'GET') {
      const { from, to } = parsedUrl.query;

      if (!from || !to) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: '`from` and `to` query parameters are required.' }));
        return;
      }

      console.log(`[HTTP Server]: Received request to originate call from ${from} to ${to}`);

      try {
        const outboundChannel = await client.channels.originate({
          endpoint: `Local/${to}@from-internal`, // Use Local channel to respect FreePBX dialplan
          callerId: from,
          app: ARI_APP_NAME,
          appArgs: 'dialed', // Pass 'dialed' to distinguish in StasisStart
          timeout: 30, // seconds
        });
        
        console.log(`[HTTP Server]: Originated channel ${outboundChannel.id} to ${to}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Call initiated from ${from} to ${to}.`, channelId: outboundChannel.id }));

      } catch (err) {
        console.error(`[HTTP Server]: Error originating call: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Failed to originate call.' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Not Found' }));
    }
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`[HTTP Server]: Listening for originate requests on port ${HTTP_PORT}`);
  });

  // Periodic channel monitoring
  setInterval(async () => {
    try {
      const channels = await client.channels.list();
      const activeChannelIds = channels.map((c) => c.id);

      console.log(`Active channels: ${[...activeChannels.keys()].join(', ')}`);

      // Remove terminated channels
      activeChannels.forEach(({ channel, agentProcess, bridge }, channelId) => {
        if (!activeChannelIds.includes(channelId)) {
          console.log(`Channel ${channelId} has been terminated.`);

          // Terminate the AIBackend if it's still running
          if (agentProcess) {
            console.log(`[ari-server]: Sending SIGTERM to AIBackend for Call ${channelId}`);
            agentProcess.kill('SIGTERM');
          }

          // Destroy the bridge if it exists
          if (bridge) {
            bridge.destroy().catch((err) => {
              console.error(`Error destroying bridge: ${err.message}`);
            });
          }

          activeChannels.delete(channelId);
        }
      });
    } catch (err) {
      console.error('Error fetching channels:', err.message);
    }
  }, 5000); // Every 5 seconds

  client.on('event', (event) => {
    console.log(`Event received: ${event.type}`);
  });

  // Start call
  client.on('StasisStart', async (event, channel) => {
    // Distinguish between incoming calls and locally originated calls
    if (channel.name.startsWith('PJSIP/')) {
        console.log(`[ari-server]: Incoming call on channel: ${channel.name}`);
    } else if (event.args[0] === 'dialed') {
        console.log(`[ari-server]: Handling locally originated call: ${channel.id}`);
    } else {
        console.log(`[ari-server]: Ignoring channel of unsupported type: ${channel.name}`);
        return;
    }
    
    activeChannels.set(channel.id, { channel });

    try {
      await channel.answer();
      console.log('[ari-server]: Call answered.');

      // Create RTP socket and wait until it's bound
      const rtpSocket = dgram.createSocket('udp4');
      const address = await bindSocket(rtpSocket, 0, '127.0.0.1');
      console.log(`[ari-server]: RTP socket started and listening on ${address.address}:${address.port}`);

      // Create External Media Channel
      const externalMedia = await client.channels.externalMedia({
        app: ARI_APP_NAME,
        external_host: `${address.address}:${address.port}`,
        format: 'g722', // Codec: G.722
        direction: 'both',
      });
      console.log(`[ari-server]: External Media Channel created: ${externalMedia.id}`);

      // Get RTP address and port from Asterisk
      let asteriskRtpAddress, asteriskRtpPort;
      try {
        const rtpAddress = await client.channels.getChannelVar({
          channelId: externalMedia.id,
          variable: 'UNICASTRTP_LOCAL_ADDRESS',
        });
        const rtpPort = await client.channels.getChannelVar({
          channelId: externalMedia.id,
          variable: 'UNICASTRTP_LOCAL_PORT',
        });

        if (rtpAddress.value && rtpPort.value) {
          asteriskRtpAddress = rtpAddress.value;
          asteriskRtpPort = parseInt(rtpPort.value, 10);
          console.log(`[ari-server]: Asterisk RTP address: ${asteriskRtpAddress}, port: ${asteriskRtpPort}`);
        } else {
          throw new Error('[ari-server]: Could not retrieve RTP parameters.');
        }
      } catch (err) {
        console.error('[ari-server]: Error retrieving RTP parameters:', err.message);
        return;
      }

      // Start AIBackend and pass RTP address and port
      const agentProcess = spawn('node', [
        `${__dirname}/agent.js`,
        channel.id,
        asteriskRtpAddress, // Address from externalMedia
        asteriskRtpPort, // Port from ExternalMedia
        address.address,
        address.port
      ]);

      // Store process information
      activeChannels.get(channel.id).agentProcess = agentProcess;

      agentProcess.stdout.on('data', (data) => {
        console.log(`[ari-server-AIAgentBackend]: ${data}`);
      });

      agentProcess.stderr.on('data', (data) => {
        console.error(`[ari-server-AIAgentBackend-Error]: ${data}`);
      });

      agentProcess.on('close', (code) => {
        console.log(`[ari-server-AIAgentBackend]: Terminated with code: ${code}`);
      });

      // Add channels to bridge
      const bridge = await client.bridges.create({
        type: 'mixing',
        name: `Bridge_${channel.id}`,
      });
      console.log(`[ari-server]: Bridge created: ${bridge.id}`);

      await client.channels.setChannelVar({
        channelId: channel.id,
        variable: 'BRIDGE_CHANNEL_FORMAT',
        value: 'g722'
      });
      console.log(`[ari-server]: Forced codec g722 on bridge for channel ${channel.id}`);

      await bridge.addChannel({ channel: [channel.id, externalMedia.id] });
      console.log('[ari-server]: Channels added to bridge.');

      // Store bridge
      activeChannels.get(channel.id).bridge = bridge;

      // Channel monitoring
      channel.on('StasisEnd', async () => {
        console.log(`Channel ${channel.id} has been terminated.`);
        const { agentProcess, bridge, externalMedia } = activeChannels.get(channel.id) || {};

        if (agentProcess) {
          console.log(`[ari-server]: Sending SIGTERM to AIBackend for Call ${channel.id}`);
          agentProcess.kill('SIGTERM'); // Terminate the AIBackend
        }

        if (bridge) {
          await bridge.destroy();
          console.log('[ari-server]: Bridge has been destroyed.');
        }

        if (externalMedia) {
          await externalMedia.hangup();
          console.log('[ari-server]: External Media Channel has been terminated.');
        }

        activeChannels.delete(channel.id);
      });
    } catch (err) {
      console.error(`[ari-server]: Error in StasisStart handler: ${err.message}`);
    }
  });

  // Start Stasis app
  client.start(ARI_APP_NAME);
})();