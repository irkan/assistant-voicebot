const ariClient = require('ari-client');
const WebSocket = require('ws');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
// -------- TIMESTAMP LOGS --------
['log', 'warn', 'error'].forEach(method => {
    const original = console[method];
    console[method] = (...args) => {
      const timestamp = new Date().toISOString();
      original(`[${timestamp}]`, ...args);
    };
  });
// Create RTP header
let sequenceNumber = 0; // RTP sequence number
let timestamp = 0; // RTP timestamp

// Buffer for RTP data (collect data for at least 500 ms)
const rtpBufferOut = [];
const RTP_SAMPLE_RATE = 16000; // 16kHz for G.722
const RTP_MIN_DURATION_MS = 500; // Minimum 500 ms buffer
const RTP_BYTES_PER_SAMPLE = 2; // G.722 requires 2 bytes per sample
const RTP_MIN_BUFFER_SIZE = (RTP_SAMPLE_RATE / 1000) * RTP_MIN_DURATION_MS * RTP_BYTES_PER_SAMPLE; // Bytes for 500 ms

// FFmpeg processes for audio conversion
let ffmpegUpsampler = null;
let ffmpegDownsampler = null;

function createRTPHeader() {
    const header = Buffer.alloc(12);
    header[0] = 0x80; // Version 2
    header[1] = 0x09; // Payload Type 9 (g722)
    header.writeUInt16BE(sequenceNumber++, 2); // Sequence Number
    header.writeUInt32BE(timestamp, 4); // Timestamp
    header.writeUInt32BE(0x12345678, 8); // SSRC (arbitrarily chosen)
    return header;
}

// Initialize FFmpeg process
function initializeffmpegProcess(callId) {
    // Upsampler: g722 from Asterisk -> pcm_s16le for WebSocket
    ffmpegUpsampler = spawn('ffmpeg', [
        '-f', 'g722',      // Input format
        '-i', 'pipe:0',    // Input from stdin
        '-acodec', 'pcm_s16le', // Output codec (slin16)
        '-ar', '16000',    // Output sample rate
        '-f', 's16le',     // Output format
        'pipe:1'           // Output to stdout
    ]);

    // Downsampler: pcm_s16le from WebSocket -> g722 for Asterisk
    ffmpegDownsampler = spawn('ffmpeg', [
        '-f', 's16le',     // Input type: raw pcm
        '-ar', '24000',    // Input sample rate: 24kHz (from Gemini)
        '-ac', '1',        // Input channels: mono
        '-i', 'pipe:0',    // Input from stdin
        '-acodec', 'g722',     // Output codec
        '-ar', '16000',    // Output sample rate
        '-f', 'g722',      // Output format
        'pipe:1'           // Output to stdout
    ]);

    ffmpegUpsampler.stderr.on('data', (data) => {
        console.debug(`[FFmpeg Upsampler] Stderr for call ${callId}: ${data}`);
    });
    ffmpegUpsampler.on('error', (err) => {
        console.error(`[FFmpeg Upsampler] Failed to start for call ${callId}: ${err.message}`);
    });
    ffmpegUpsampler.on('close', (code) => {
        console.info(`[FFmpeg Upsampler] Process exited for call ${callId} with code ${code}`);
    });

    ffmpegDownsampler.stderr.on('data', (data) => {
        console.debug(`[FFmpeg Downsampler] Stderr for call ${callId}: ${data}`);
    });
    ffmpegDownsampler.on('error', (err) => {
        console.error(`[FFmpeg Downsampler] Failed to start for call ${callId}: ${err.message}`);
    });
    ffmpegDownsampler.on('close', (code) => {
        console.info(`[FFmpeg Downsampler] Process exited for call ${callId} with code ${code}`);
    });
}

// Clean up FFmpeg processes
function cleanupffmpegProcess() {
    if (ffmpegUpsampler) {
        ffmpegUpsampler.kill('SIGTERM');
        ffmpegUpsampler = null;
    }
    if (ffmpegDownsampler) {
        ffmpegDownsampler.kill('SIGTERM');
        ffmpegDownsampler = null;
    }
    console.log('[AIAgentBackend]: FFmpeg processes cleaned up');
}

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

// Buffer for RTP packets (only for incoming audio)
const rtpBuffer = [];

// Buffer processing for incoming packets
async function processBuffer(rtpSocket, externalMediaRtpPort, externalMediaRtpAddress) {
    while (true) {
        if (rtpBuffer.length > 0) {
            const rtpPacket = rtpBuffer.shift(); // Next packet from buffer
            rtpSocket.send(rtpPacket, 0, rtpPacket.length, externalMediaRtpPort, externalMediaRtpAddress, (err) => {
                if (err) {
                    console.error(`[AIAgentBackend]: Error sending RTP data: ${err.message}`);
                } else {
                    console.log(`[AIAgentBackend]: RTP packet successfully sent (${rtpPacket.length} bytes)`);
                }
            });
            await delay(20); // 20ms pause for next packet
        } else {
            await delay(10); // Short wait if buffer is empty
        }
    }
}

const ASTERISK_URL = 'http://localhost:8088';
const ASTERISK_USERNAME = 'voicebot_user';         // Addım 1.2-də yaratdığınız istifadəçi adı
const ASTERISK_PASSWORD = 'SuperGucluParol123';

let isWebSocketReady = false;

// Establish GeminiBackend Realtime API connection
(async () => {
    const client = await ariClient.connect(ASTERISK_URL, ASTERISK_USERNAME, ASTERISK_PASSWORD);

    const callId = process.argv[2]; // Channel ID passed from ARI server
    const externalMediaRtpAddress = process.argv[3]; // Asterisk RTP address (externalMedia)
    const externalMediaRtpPort = parseInt(process.argv[4], 10); // Asterisk RTP port (externalMedia)
    const incomingRtpAddress = process.argv[5]; // Incoming RTP socket from ari-server
    const incomingRtpPort = parseInt(process.argv[6], 10); // Incoming RTP port from ari-server
    const snoopExternalMediaRtpAddress = process.argv[7]; // Incoming RTP socket from ari-server
    const snoopExternalMediaRtpPort = parseInt(process.argv[8], 10); // Incoming RTP port from ari-server

    console.log(`[AIAgentBackend]: Session started for call (${callId})`);
    console.log(`[AIAgentBackend]: Asterisk RTP address (externalMedia): ${externalMediaRtpAddress}, port: ${externalMediaRtpPort}`);
    console.log(`[AIAgentBackend]: Incoming RTP socket: ${incomingRtpAddress}, port: ${incomingRtpPort}`);

    // Initialize FFmpeg processes
    initializeffmpegProcess(callId);

    const WEBSOCKET_URL = 'ws://46.62.135.5:3001';
    const ws = new WebSocket(WEBSOCKET_URL);    

    // Use incoming RTP socket
    const rtpSocket = dgram.createSocket('udp4');

    // Create snoop RTP socket and wait until it's bound
    const rtpSocketSnoop = dgram.createSocket('udp4');
    const snoopAddress = await bindSocket(rtpSocketSnoop, 0, '127.0.0.1');
    console.log(`[AIAgentBackend]: Snoop RTP socket started and listening on ${snoopAddress.address}:${snoopAddress.port}`);

    const snoopId = `snoop_${callId}`;
    snoopChannel = await client.channels.snoopChannel({
        channelId: callId,
        snoopId: snoopId,
        spy: 'in', // Only incoming audio data
        app: 'voicebot_app',
    });
    console.log(`[ari-server]: SnoopChannel created: ${snoopId}`);

    // Create Snoop Media Channel
    const snoopMedia = await client.channels.externalMedia({
        app: 'voicebot_app',
        external_host: `${snoopAddress.address}:${snoopAddress.port}`, // Connect the Snoop RTP socket
        format: 'g722', // Codec: G.722
        direction: 'both', // Allow both directions
    });
    console.log(`[ari-server]: External Media Channel created for SnoopChannel: ${snoopMedia.id} with ${snoopAddress.address}:${snoopAddress.port}`);

    // Get SnoopMedia RTP address and port from Asterisk
    let snoopMediaRtpAddress, snoopMediakRtpPort;
    try {
        const snoopRtpAddress = await client.channels.getChannelVar({
            channelId: snoopMedia.id,
            variable: 'UNICASTRTP_LOCAL_ADDRESS',
        });
        const snoopRtpPort = await client.channels.getChannelVar({
            channelId: snoopMedia.id,
            variable: 'UNICASTRTP_LOCAL_PORT',
        });

        if (snoopRtpAddress.value && snoopRtpPort.value) {
            snoopMediaRtpAddress = snoopRtpAddress.value;
            snoopMediakRtpPort = parseInt(snoopRtpPort.value, 10);
            console.log(`[ari-server]: Snoop Media RTP address: ${snoopMediaRtpAddress}, port: ${snoopMediakRtpPort}`);
        } else {
            throw new Error('[ari-server]: Could not retrieve Snoop RTP parameters.');
        }
    } catch (err) {
        console.error('[ari-server]: Error retrieving Snoop RTP parameters:', err.message);
        return;
    }

    const snoopBridge = await client.bridges.create({
        type: 'mixing',
        name: `SnoopBridge_${snoopChannel.id}`,
    });
    console.log(`[ari-server]: SnoopBridge created: ${snoopBridge.id}`);

    // Add SnoopChannel and External Media Channel to bridge
    await snoopBridge.addChannel({ channel: [snoopChannel.id, snoopMedia.id] });
    console.log('[ari-server]: SnoopChannel and External Media Channel added to SnoopBridge.');

    // Setup FFmpeg upsampler output handler (g722 -> pcm_s16le for Gemini)
    ffmpegUpsampler.stdout.on('data', (data) => {
        console.log(`[AIAgentBackend]: WebSocket ready. Upsampled audio passing to Websocket.`);
        // Send 16kHz PCM data to Gemini
            ws.send(data, (err) => {
            if (err) {
                console.error(`[AIAgentBackend]: Error sending upsampled audio to Gemini: ${err.message}`);
            } else {
                console.log(`[AIAgentBackend]: Upsampled audio sent to Gemini (${data.length} bytes)`);
            }
        });
    });

    // Setup FFmpeg downsampler output handler (pcm_s16le -> g722 for Asterisk)
    ffmpegDownsampler.stdout.on('data', (data) => {
        // Convert downsampled g722 data to RTP packets
        const chunkSize = 160; // 20ms for G.722
        let offset = 0;

        while (offset < data.length) {
            const chunk = data.slice(offset, Math.min(offset + chunkSize, data.length));
            const rtpHeader = createRTPHeader();
            const rtpPacket = Buffer.concat([rtpHeader, chunk]);
            rtpBuffer.push(rtpPacket);

            timestamp += chunk.length;
            offset += chunkSize;
        }

        console.log(`[AIAgentBackend]: Downsampled audio converted to RTP packets (${data.length} bytes)`);
    });

    // Start buffer processing (for outgoing audio data to Asterisk)
    processBuffer(rtpSocket, externalMediaRtpPort, externalMediaRtpAddress).catch((err) => {
        console.error(`[AIAgentBackend]: Error in buffer processing: ${err.message}`);
    });

    // WebSocket events
    ws.on('open', () => {
        console.log(`[AIAgentBackend]: WebSocket connection successfully opened for call ${callId}`);
        isWebSocketReady = true;
    });

    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        switch (data.type) {
            case 'gemini':
                const geminiMessage = data.data;
                if (geminiMessage.serverContent?.interrupted) {
                    console.log('[AIAgentBackend]: Received an interrupt. Clearing audio buffer. length:' + rtpBuffer.length);
                    rtpBuffer.length = 0;
                    return;
                }
                const audioBase64 = geminiMessage.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                if(!audioBase64){
                    console.log(`[AIAgentBackend]: No audio data received from Gemini`);
                    return;
                }
                
                const audioChunk = Buffer.from(audioBase64, 'base64');
                
                // Send 24kHz audio to FFmpeg downsampler for conversion to g722
                if (ffmpegDownsampler && ffmpegDownsampler.stdin.writable) {
                    ffmpegDownsampler.stdin.write(audioChunk, (err) => {
                        if (err) {
                            console.error(`[AIAgentBackend]: Error writing to FFmpeg downsampler: ${err.message}`);
                        } else {
                            console.log(`[AIAgentBackend]: Audio data sent to FFmpeg downsampler (${audioChunk.length} bytes)`);
                        }
                    });
                }
                break;

            case 'status':
                console.log(`[AIAgentBackend]: Status received: ${JSON.stringify(data)}`);
                break;

            case 'error':
                console.log(`[AIAgentBackend]: Error received: ${JSON.stringify(data)}`);
                break;

            case 'generationComplete':
                console.log(`[AIAgentBackend]: Generation complete received: ${JSON.stringify(data)}`);
                break;
            default:
                console.log(`[AIAgentBackend]: Unrecognized event received: ${JSON.stringify(data)}`);
        }
    });

    // Handle incoming RTP data from Asterisk (8kHz alaw)
    rtpSocketSnoop.on('message', (msg) => {
        // console.log(`[AIAgentBackend]: RTP data received from Snoop RTP socket (${msg.length} bytes)`);

        // Extract audio payload (skip 12-byte RTP header) - this is g722
        const audioPayload = msg.slice(12);

        // Send g722 audio to ffmpeg for conversion to 16kHz PCM
        if (ffmpegUpsampler && ffmpegUpsampler.stdin.writable) {
            ffmpegUpsampler.stdin.write(audioPayload, (err) => {
                if (err) {
                    console.error(`[AIAgentBackend]: Error writing to ffmpeg process: ${err.message}`);
                } else {
                    // console.log(`[AIAgentBackend]: Audio payload sent to ffmpeg process (${audioPayload.length} bytes)`);
                }
            });
        }
    });

    rtpSocketSnoop.on('error', (err) => {
        console.error(`[AIAgentBackend]: RTP socket error: ${err.message}`);
    });

    rtpSocketSnoop.on('listening', () => {
        const address = rtpSocketSnoop.address();
        console.log(`[AIAgentBackend]: RTP socket listening on ${address.address}:${address.port}`);
    });

    ws.on('close', () => {
        console.log(`[AIAgentBackend]: WebSocket connection closed.`);
        cleanupffmpegProcess();
        rtpSocket.close();
        process.exit(0);
    });

    ws.on('error', (error) => {
        console.error(`[AIAgentBackend]: WebSocket Error: ${error.message}`);
        cleanupffmpegProcess();
        rtpSocket.close();
        process.exit(1);
    });

    process.on('SIGTERM', () => {
        console.log(`[AIAgentBackend]: WebSocket Hangup detected. Closing session.`);
        cleanupffmpegProcess();
        ws.close();
    });

    // Handle process cleanup on unexpected exit
    process.on('exit', () => {
        cleanupffmpegProcess();
    });

    process.on('uncaughtException', (error) => {
        console.error(`[AIAgentBackend]: Uncaught exception: ${error.message}`);
        cleanupffmpegProcess();
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error(`[AIAgentBackend]: Unhandled rejection at:`, promise, 'reason:', reason);
        cleanupffmpegProcess();
        process.exit(1);
    });
})();