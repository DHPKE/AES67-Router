module.exports = function(RED) {
    const dgram = require('dgram');
    const os = require('os');
    const crypto = require('crypto');
    
    // Try to load sdp-transform, but make it optional
    let sdp = null;
    let sdpAvailable = false;
    try {
        sdp = require('sdp-transform');
        sdpAvailable = true;
    } catch (err) {
        RED.log.warn('sdp-transform module not available. Some features will be limited.');
    }
    
    // AES67 Constants
    const AES67_SAP_PORT = 9875;           // Session Announcement Protocol port
    const AES67_SAP_MULTICAST = '239.255.255.255'; // SAP multicast address
    const AES67_RTP_PORT_BASE = 5004;      // Base RTP port
    const AES67_PTP_DOMAIN = 0;            // Default PTP domain
    const AES67_SAMPLE_RATE = 48000;       // Standard sample rate
    
    // Global stream registry
    let globalStreamRegistry = new Map();
    
    // AES67 Stream Discovery using SAP/SDP
    class AES67Discovery {
        constructor(node) {
            this.node = node;
            this.streams = new Map();
            this.devices = new Map();
            this.sapSocket = null;
            this.running = false;
            this.localIP = this.getLocalIP();
        }
        
        getLocalIP() {
            try {
                const interfaces = os.networkInterfaces();
                if (!interfaces) return '127.0.0.1';
                
                for (const name of Object.keys(interfaces)) {
                    const ifaces = interfaces[name];
                    if (!ifaces) continue;
                    
                    for (const iface of ifaces) {
                        if (iface && iface.family === 'IPv4' && !iface.internal) {
                            return iface.address;
                        }
                    }
                }
            } catch (err) {
                this.node.warn(`Error getting local IP: ${err.message}`);
            }
            return '127.0.0.1';
        }
        
        async start() {
            if (this.running) return;
            this.running = true;
            
            this.node.status({ fill: "yellow", shape: "ring", text: "discovering AES67 streams..." });
            
            try {
                // Create SAP listener socket
                await this.createSAPSocket();
                
                // Send our own SAP announcements
                this.announcementInterval = setInterval(() => {
                    this.sendSAPAnnouncements();
                }, 30000); // Every 30 seconds as per AES67 spec
                
                // Initial announcement
                this.sendSAPAnnouncements();
                
                // Cleanup stale streams periodically
                this.cleanupInterval = setInterval(() => {
                    this.cleanupStaleStreams();
                }, 60000);
                
                this.node.log('AES67 discovery started');
                
            } catch (err) {
                this.node.error(`Failed to start AES67 discovery: ${err.message}`);
                this.node.status({ fill: "red", shape: "ring", text: "discovery error" });
            }
        }
        
        async createSAPSocket() {
            return new Promise((resolve, reject) => {
                try {
                    this.sapSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                    
                    this.sapSocket.on('error', (err) => {
                        this.node.error(`SAP socket error: ${err.message}`);
                        if (this.sapSocket) {
                            try {
                                this.sapSocket.close();
                            } catch (e) {
                                // Ignore close errors
                            }
                        }
                        // Don't reject here to prevent crashes, just log
                        this.node.status({ fill: "red", shape: "ring", text: "SAP error" });
                    });
                    
                    this.sapSocket.on('message', (msg, rinfo) => {
                        try {
                            this.handleSAPMessage(msg, rinfo);
                        } catch (err) {
                            this.node.debug(`Error handling SAP message: ${err.message}`);
                        }
                    });
                    
                    this.sapSocket.on('listening', () => {
                        try {
                            const address = this.sapSocket.address();
                            this.node.log(`SAP listener on ${address.address}:${address.port}`);
                            
                            // Join SAP multicast group with error handling
                            try {
                                this.sapSocket.addMembership(AES67_SAP_MULTICAST);
                            } catch (e) {
                                this.node.warn(`Could not join primary multicast ${AES67_SAP_MULTICAST}: ${e.message}`);
                            }
                            
                            try {
                                this.sapSocket.addMembership('239.192.0.0');
                            } catch (e) {
                                this.node.debug(`Could not join alternative multicast: ${e.message}`);
                            }
                            
                            try {
                                this.sapSocket.setBroadcast(true);
                                this.sapSocket.setMulticastTTL(32);
                            } catch (e) {
                                this.node.debug(`Could not set socket options: ${e.message}`);
                            }
                            
                            resolve();
                        } catch (err) {
                            this.node.error(`Error in SAP listening handler: ${err.message}`);
                            reject(err);
                        }
                    });
                    
                    // Bind with error handling
                    try {
                        this.sapSocket.bind(AES67_SAP_PORT, '0.0.0.0');
                    } catch (err) {
                        this.node.error(`Failed to bind SAP socket: ${err.message}`);
                        reject(err);
                    }
                } catch (err) {
                    this.node.error(`Failed to create SAP socket: ${err.message}`);
                    reject(err);
                }
            });
        }
        
        handleSAPMessage(msg, rinfo) {
            try {
                // Validate input
                if (!msg || !Buffer.isBuffer(msg) || msg.length < 8) {
                    return;
                }
                
                // Parse SAP header (RFC 2974)
                const sapHeader = {
                    version: (msg[0] >> 5) & 0x7,
                    addressType: (msg[0] >> 4) & 0x1,
                    reserved: (msg[0] >> 3) & 0x1,
                    messageType: (msg[0] >> 2) & 0x1,
                    encrypted: (msg[0] >> 1) & 0x1,
                    compressed: msg[0] & 0x1,
                    authLength: msg[1],
                    msgIdHash: msg.readUInt16BE(2)
                };
                
                // Skip if not a valid SAP packet
                if (sapHeader.version !== 1) return;
                
                // Extract originating source with bounds checking
                if (msg.length < 8) return;
                const sourceIP = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
                
                // Calculate SDP offset
                let sdpOffset = 8; // Basic SAP header
                sdpOffset += sapHeader.authLength * 4; // Authentication data
                
                // Validate offset is within bounds
                if (sdpOffset >= msg.length) return;
                
                // Find the payload type field (after null terminator)
                while (sdpOffset < msg.length && msg[sdpOffset] !== 0) {
                    sdpOffset++;
                }
                sdpOffset += 1; // Skip null terminator
                
                // Validate offset is still within bounds
                if (sdpOffset >= msg.length) return;
                
                // Skip payload type identifier
                if (sdpOffset + 8 < msg.length) {
                    try {
                        const payloadType = msg.slice(sdpOffset, sdpOffset + 8).toString('utf8');
                        if (payloadType.includes('sdp')) {
                            sdpOffset += 8;
                        }
                    } catch (err) {
                        // Ignore payload type parsing errors
                    }
                }
                
                // Validate final offset
                if (sdpOffset >= msg.length) return;
                
                // Extract SDP payload
                const sdpData = msg.slice(sdpOffset).toString('utf8');
                
                if (sdpData && sdpData.startsWith('v=0')) {
                    this.parseSDP(sdpData, sourceIP, rinfo.address, sapHeader.messageType);
                }
                
            } catch (err) {
                // Invalid SAP packet, log but don't crash
                this.node.debug(`Error parsing SAP message: ${err.message}`);
            }
        }
        
        parseSDP(sdpString, sourceIP, actualIP, messageType) {
            try {
                // Check if sdp-transform is available
                if (!sdpAvailable || !sdp) {
                    this.node.debug('SDP parsing skipped - sdp-transform not available');
                    return;
                }
                
                // Validate inputs
                if (!sdpString || typeof sdpString !== 'string') {
                    return;
                }
                
                // Parse SDP using sdp-transform
                const session = sdp.parse(sdpString);
                
                if (!session || !session.media || !Array.isArray(session.media)) {
                    return;
                }
                
                // Process each media stream
                session.media.forEach(media => {
                    try {
                        if (media && media.type === 'audio' && media.protocol === 'RTP/AVP') {
                            const streamInfo = {
                                id: (session.origin && session.origin.sessionId) || crypto.randomBytes(8).toString('hex'),
                                name: session.name || 'AES67 Stream',
                                description: session.description || '',
                                sourceIP: actualIP || sourceIP || 'unknown',
                                destIP: (media.connection && media.connection.ip) || (session.connection && session.connection.ip) || 'unknown',
                                port: media.port || 0,
                                channels: this.extractChannels(media),
                                sampleRate: this.extractSampleRate(media),
                                encoding: this.extractEncoding(media),
                                ptime: media.ptime || 1, // Packet time in ms
                                mediaClk: this.extractMediaClock(media),
                                isMulticast: this.isMulticastIP((media.connection && media.connection.ip) || (session.connection && session.connection.ip)),
                                sdp: sdpString,
                                lastSeen: Date.now(),
                                status: messageType === 0 ? 'active' : 'deleted'
                            };
                            
                            // Register the stream
                            this.registerStream(streamInfo);
                        }
                    } catch (err) {
                        this.node.debug(`Error processing media stream: ${err.message}`);
                    }
                });
                
            } catch (err) {
                this.node.debug(`Failed to parse SDP: ${err.message}`);
            }
        }
        
        extractChannels(media) {
            try {
                // Look for channel count in rtpmap
                if (media && media.rtpmap && Array.isArray(media.rtpmap)) {
                    for (const rtpmap of media.rtpmap) {
                        if (rtpmap && rtpmap.channels) {
                            return parseInt(rtpmap.channels) || 2;
                        }
                    }
                }
            } catch (err) {
                this.node.debug(`Error extracting channels: ${err.message}`);
            }
            // Default to 2 channels (stereo)
            return 2;
        }
        
        extractSampleRate(media) {
            try {
                // Look for sample rate in rtpmap
                if (media && media.rtpmap && Array.isArray(media.rtpmap)) {
                    for (const rtpmap of media.rtpmap) {
                        if (rtpmap && rtpmap.rate) {
                            return parseInt(rtpmap.rate) || AES67_SAMPLE_RATE;
                        }
                    }
                }
            } catch (err) {
                this.node.debug(`Error extracting sample rate: ${err.message}`);
            }
            return AES67_SAMPLE_RATE;
        }
        
        extractEncoding(media) {
            try {
                // Look for encoding in rtpmap
                if (media && media.rtpmap && Array.isArray(media.rtpmap)) {
                    for (const rtpmap of media.rtpmap) {
                        if (rtpmap && rtpmap.name) {
                            return rtpmap.name; // L24, L16, etc.
                        }
                    }
                }
            } catch (err) {
                this.node.debug(`Error extracting encoding: ${err.message}`);
            }
            return 'L24'; // Default to 24-bit PCM
        }
        
        extractMediaClock(media) {
            try {
                // Look for media clock reference
                if (media && media.mediaclk) {
                    return media.mediaclk;
                }
                // Check for PTP clock
                if (media && media.tsRefClk) {
                    return media.tsRefClk;
                }
            } catch (err) {
                this.node.debug(`Error extracting media clock: ${err.message}`);
            }
            return 'ptp=IEEE1588-2008:00-00-00-00-00-00-00-00:0';
        }
        
        isMulticastIP(ip) {
            try {
                if (!ip || typeof ip !== 'string') return false;
                const parts = ip.split('.');
                if (parts.length !== 4) return false;
                const firstOctet = parseInt(parts[0]);
                return !isNaN(firstOctet) && firstOctet >= 224 && firstOctet <= 239;
            } catch (err) {
                return false;
            }
        }
        
        registerStream(streamInfo) {
            try {
                if (!streamInfo || !streamInfo.sourceIP || !streamInfo.port) {
                    return;
                }
                
                const streamKey = `${streamInfo.sourceIP}:${streamInfo.port}`;
                
                // Check if this is a new stream
                const isNew = !this.streams.has(streamKey);
                
                // Update stream registry
                this.streams.set(streamKey, streamInfo);
                globalStreamRegistry.set(streamKey, streamInfo);
                
                // Extract device info
                const deviceKey = streamInfo.sourceIP;
                if (!this.devices.has(deviceKey)) {
                    this.devices.set(deviceKey, {
                        ip: streamInfo.sourceIP,
                        name: streamInfo.sourceIP,
                        streams: []
                    });
                }
                
                const device = this.devices.get(deviceKey);
                if (device && !device.streams.includes(streamKey)) {
                    device.streams.push(streamKey);
                }
                
                // Send notification for new streams
                if (isNew && streamInfo.status === 'active') {
                    try {
                        this.node.send([{
                            topic: 'stream/discovered',
                            payload: streamInfo
                        }, null, null]);
                        
                        this.node.log(`Discovered AES67 stream: ${streamInfo.name} from ${streamInfo.sourceIP} (${streamInfo.channels}ch @ ${streamInfo.sampleRate}Hz)`);
                    } catch (err) {
                        this.node.debug(`Error sending discovery event: ${err.message}`);
                    }
                }
                
                this.updateNodeStatus();
            } catch (err) {
                this.node.error(`Error registering stream: ${err.message}`);
            }
        }
        
        sendSAPAnnouncements() {
            try {
                // Check if sdp is available
                if (!sdpAvailable || !sdp) {
                    return;
                }
                
                // Announce our own streams (if any)
                // For now, send a discovery probe
                const discoverySDP = this.createDiscoverySDP();
                if (!discoverySDP) return;
                
                const sapPacket = this.createSAPPacket(discoverySDP);
                if (!sapPacket) return;
                
                if (this.sapSocket && this.running) {
                    this.sapSocket.send(sapPacket, AES67_SAP_PORT, AES67_SAP_MULTICAST, (err) => {
                        if (err) {
                            this.node.debug(`SAP send error: ${err.message}`);
                        }
                    });
                }
            } catch (err) {
                this.node.debug(`Error sending SAP announcement: ${err.message}`);
            }
        }
        
        createDiscoverySDP() {
            try {
                if (!sdpAvailable || !sdp) {
                    return null;
                }
                
                const session = {
                    version: 0,
                    origin: {
                        username: 'node-red',
                        sessionId: Date.now().toString(),
                        sessionVersion: 1,
                        netType: 'IN',
                        addressType: 'IP4',
                        unicastAddress: this.localIP
                    },
                    name: 'Node-RED AES67 Discovery',
                    timing: {
                        start: 0,
                        stop: 0
                    },
                    connection: {
                        version: 'IP4',
                        ip: '0.0.0.0'
                    }
                };
                
                return sdp.write(session);
            } catch (err) {
                this.node.debug(`Error creating discovery SDP: ${err.message}`);
                return null;
            }
        }
        
        createSAPPacket(sdpData) {
            try {
                if (!sdpData) return null;
                
                const sdpBuffer = Buffer.from(sdpData, 'utf8');
                const packet = Buffer.allocUnsafe(8 + 8 + sdpBuffer.length);
                
                // SAP Header
                packet[0] = 0x20; // Version 1, IPv4, announcement
                packet[1] = 0x00; // No authentication
                packet.writeUInt16BE(0x0000, 2); // Message ID hash
                
                // Originating source (our IP)
                const ipParts = this.localIP.split('.').map(p => parseInt(p) || 0);
                if (ipParts.length !== 4) return null;
                
                packet[4] = ipParts[0];
                packet[5] = ipParts[1];
                packet[6] = ipParts[2];
                packet[7] = ipParts[3];
                
                // Payload type
                packet.write('application/sdp', 8, 'ascii');
                
                // SDP data
                sdpBuffer.copy(packet, 8 + 8);
                
                return packet;
            } catch (err) {
                this.node.debug(`Error creating SAP packet: ${err.message}`);
                return null;
            }
        }
        
        cleanupStaleStreams() {
            try {
                const now = Date.now();
                const timeout = 120000; // 2 minutes
                
                for (const [key, stream] of this.streams) {
                    try {
                        if (stream && stream.lastSeen && (now - stream.lastSeen > timeout)) {
                            this.streams.delete(key);
                            globalStreamRegistry.delete(key);
                            
                            this.node.send([{
                                topic: 'stream/removed',
                                payload: stream
                            }, null, null]);
                        }
                    } catch (err) {
                        this.node.debug(`Error cleaning up stream ${key}: ${err.message}`);
                    }
                }
                
                this.updateNodeStatus();
            } catch (err) {
                this.node.error(`Error in cleanup: ${err.message}`);
            }
        }
        
        updateNodeStatus() {
            try {
                const streamCount = this.streams.size;
                const deviceCount = this.devices.size;
                
                if (streamCount === 0) {
                    this.node.status({ fill: "yellow", shape: "ring", text: "searching for AES67 streams..." });
                } else {
                    this.node.status({ 
                        fill: "green", 
                        shape: "dot", 
                        text: `${streamCount} streams from ${deviceCount} devices` 
                    });
                }
            } catch (err) {
                this.node.error(`Error updating status: ${err.message}`);
            }
        }
        
        stop() {
            this.running = false;
            
            if (this.announcementInterval) {
                clearInterval(this.announcementInterval);
            }
            
            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);
            }
            
            if (this.sapSocket) {
                try {
                    this.sapSocket.close();
                } catch (e) {}
            }
        }
        
        getStreams() {
            return Array.from(this.streams.values());
        }
        
        getDevices() {
            return Array.from(this.devices.values());
        }
    }
    
    // AES67 Router for creating subscriptions
    class AES67Router {
        constructor(node) {
            this.node = node;
            this.subscriptions = new Map();
            this.rtpSockets = new Map();
        }
        
        createSubscription(streamKey, localPort) {
            try {
                if (!streamKey) {
                    return { success: false, error: 'Stream key is required' };
                }
                
                const stream = globalStreamRegistry.get(streamKey);
                if (!stream) {
                    return { success: false, error: 'Stream not found' };
                }
                
                const subscriptionId = `${streamKey}_${localPort || 'auto'}`;
                
                if (this.subscriptions.has(subscriptionId)) {
                    return { success: false, error: 'Subscription already exists' };
                }
                
                // Create RTP receiver socket
                try {
                    const rtpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                    
                    rtpSocket.on('message', (msg, rinfo) => {
                        try {
                            // Handle RTP packets
                            this.handleRTPPacket(msg, rinfo, subscriptionId);
                        } catch (err) {
                            this.node.debug(`Error handling RTP packet: ${err.message}`);
                        }
                    });
                    
                    rtpSocket.on('error', (err) => {
                        this.node.warn(`RTP socket error for ${subscriptionId}: ${err.message}`);
                        // Don't crash, just log the error
                    });
                    
                    // Bind to local port
                    rtpSocket.bind(localPort || 0, '0.0.0.0', () => {
                        try {
                            const actualPort = rtpSocket.address().port;
                            
                            // Join multicast group if needed
                            if (stream.isMulticast && stream.destIP) {
                                try {
                                    rtpSocket.addMembership(stream.destIP);
                                } catch (e) {
                                    this.node.warn(`Could not join multicast ${stream.destIP}: ${e.message}`);
                                }
                            }
                            
                            const subscription = {
                                id: subscriptionId,
                                stream: stream,
                                localPort: actualPort,
                                created: new Date().toISOString(),
                                packetsReceived: 0,
                                bytesReceived: 0,
                                status: 'active'
                            };
                            
                            this.subscriptions.set(subscriptionId, subscription);
                            this.rtpSockets.set(subscriptionId, rtpSocket);
                            
                            this.node.log(`Created AES67 subscription: ${stream.name} on port ${actualPort}`);
                        } catch (err) {
                            this.node.error(`Error in bind callback: ${err.message}`);
                            try {
                                rtpSocket.close();
                            } catch (e) {
                                // Ignore close errors
                            }
                        }
                    });
                    
                    return { 
                        success: true, 
                        subscription: subscriptionId,
                        message: `Subscribed to ${stream.name}`
                    };
                } catch (err) {
                    this.node.error(`Failed to create RTP socket: ${err.message}`);
                    return { success: false, error: `Failed to create socket: ${err.message}` };
                }
                
            } catch (err) {
                this.node.error(`Error creating subscription: ${err.message}`);
                return { success: false, error: err.message };
            }
        }
        
        handleRTPPacket(msg, rinfo, subscriptionId) {
            try {
                // Validate inputs
                if (!msg || !Buffer.isBuffer(msg) || msg.length < 12) {
                    return; // RTP header is at least 12 bytes
                }
                
                const subscription = this.subscriptions.get(subscriptionId);
                if (!subscription) return;
                
                // Update statistics
                subscription.packetsReceived++;
                subscription.bytesReceived += msg.length;
                
                // Parse RTP header with bounds checking
                const rtpHeader = {
                    version: (msg[0] >> 6) & 0x3,
                    padding: (msg[0] >> 5) & 0x1,
                    extension: (msg[0] >> 4) & 0x1,
                    csrcCount: msg[0] & 0xF,
                    marker: (msg[1] >> 7) & 0x1,
                    payloadType: msg[1] & 0x7F,
                    sequenceNumber: msg.readUInt16BE(2),
                    timestamp: msg.readUInt32BE(4),
                    ssrc: msg.readUInt32BE(8)
                };
                
                // Calculate header length with bounds checking
                let headerLength = 12 + (rtpHeader.csrcCount * 4);
                
                // Validate header length doesn't exceed buffer
                if (headerLength > msg.length) {
                    this.node.debug(`Invalid RTP packet: header length exceeds buffer`);
                    return;
                }
                
                if (rtpHeader.extension && (headerLength + 4 <= msg.length)) {
                    const extLength = msg.readUInt16BE(headerLength + 2) * 4;
                    headerLength += 4 + extLength;
                }
                
                // Final validation
                if (headerLength > msg.length) {
                    this.node.debug(`Invalid RTP packet: total header length exceeds buffer`);
                    return;
                }
                
                // Extract audio payload
                const audioPayload = msg.slice(headerLength);
                
                // Send audio data event
                this.node.send([null, {
                    topic: 'audio/data',
                    payload: {
                        subscriptionId: subscriptionId,
                        streamName: subscription.stream.name,
                        rtp: rtpHeader,
                        audio: audioPayload,
                        format: {
                            encoding: subscription.stream.encoding,
                            channels: subscription.stream.channels,
                            sampleRate: subscription.stream.sampleRate
                        }
                    }
                }, null]);
                
            } catch (err) {
                this.node.debug(`Error handling RTP packet: ${err.message}`);
            }
        }
        
        removeSubscription(subscriptionId) {
            try {
                if (!subscriptionId) {
                    return { success: false, error: 'Subscription ID is required' };
                }
                
                const subscription = this.subscriptions.get(subscriptionId);
                if (!subscription) {
                    return { success: false, error: 'Subscription not found' };
                }
                
                // Close RTP socket
                const socket = this.rtpSockets.get(subscriptionId);
                if (socket) {
                    try {
                        socket.close();
                    } catch (err) {
                        this.node.debug(`Error closing socket: ${err.message}`);
                    }
                    this.rtpSockets.delete(subscriptionId);
                }
                
                this.subscriptions.delete(subscriptionId);
                
                return { 
                    success: true, 
                    message: `Removed subscription to ${subscription.stream.name}`
                };
            } catch (err) {
                this.node.error(`Error removing subscription: ${err.message}`);
                return { success: false, error: err.message };
            }
        }
        
        getSubscriptions() {
            return Array.from(this.subscriptions.values());
        }
        
        shutdown() {
            try {
                // Close all RTP sockets
                for (const [id, socket] of this.rtpSockets) {
                    try {
                        socket.close();
                    } catch (e) {
                        this.node.debug(`Error closing socket ${id}: ${e.message}`);
                    }
                }
                this.rtpSockets.clear();
                this.subscriptions.clear();
            } catch (err) {
                this.node.error(`Error in shutdown: ${err.message}`);
            }
        }
    }
    
    // Main Node-RED Node
    function AES67RouterNode(config) {
        try {
            RED.nodes.createNode(this, config);
            const node = this;
            
            node.name = config.name || 'AES67 Router';
            node.autoDiscover = config.autoDiscover !== false;
            
            // Initialize components with error handling
            try {
                node.discovery = new AES67Discovery(node);
                node.router = new AES67Router(node);
            } catch (err) {
                node.error(`Failed to initialize AES67 components: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: "initialization error" });
                return;
            }
            
            // Start discovery
            if (node.autoDiscover) {
                // Use setImmediate to avoid blocking Node-RED startup
                setImmediate(() => {
                    try {
                        node.discovery.start();
                    } catch (err) {
                        node.error(`Failed to start discovery: ${err.message}`);
                        node.status({ fill: "red", shape: "ring", text: "discovery error" });
                    }
                });
            }
            
            // Handle input messages
            node.on('input', function(msg, send, done) {
                // Ensure send and done are available
                send = send || function() { node.send.apply(node, arguments) };
                done = done || function(err) { if(err) node.error(err, msg) };
                
                try {
                    // Validate msg object
                    if (!msg || typeof msg !== 'object') {
                        done(new Error('Invalid message object'));
                        return;
                    }
                    
                    const topic = (msg.topic || '').toLowerCase();
                    const payload = msg.payload || {};
                    
                    let response = null;
                    let outputPort = 0;
                    
                    try {
                        switch(topic) {
                            case 'discover':
                            case 'start':
                                node.discovery.start();
                                response = {
                                    topic: 'discovery/started',
                                    payload: { message: 'AES67 discovery started' }
                                };
                                break;
                                
                            case 'streams':
                            case 'list_streams':
                                response = {
                                    topic: 'streams',
                                    payload: node.discovery.getStreams()
                                };
                                outputPort = 2; // Status output
                                break;
                                
                            case 'devices':
                            case 'list_devices':
                                response = {
                                    topic: 'devices',
                                    payload: node.discovery.getDevices()
                                };
                                outputPort = 2;
                                break;
                                
                            case 'subscribe':
                                if (payload && payload.streamKey) {
                                    const result = node.router.createSubscription(
                                        payload.streamKey,
                                        payload.localPort
                                    );
                                    response = {
                                        topic: result.success ? 'subscribed' : 'subscription_error',
                                        payload: result
                                    };
                                } else {
                                    node.error('Stream key required for subscription', msg);
                                    response = {
                                        topic: 'subscription_error',
                                        payload: { error: 'Stream key required' }
                                    };
                                    outputPort = 2;
                                }
                                break;
                                
                            case 'unsubscribe':
                                if (payload && payload.subscriptionId) {
                                    const result = node.router.removeSubscription(payload.subscriptionId);
                                    response = {
                                        topic: 'unsubscribed',
                                        payload: result
                                    };
                                } else {
                                    node.error('Subscription ID required for unsubscribe', msg);
                                    response = {
                                        topic: 'error',
                                        payload: { error: 'Subscription ID required' }
                                    };
                                    outputPort = 2;
                                }
                                break;
                                
                            case 'subscriptions':
                            case 'list_subscriptions':
                                response = {
                                    topic: 'subscriptions',
                                    payload: node.router.getSubscriptions()
                                };
                                outputPort = 2;
                                break;
                                
                            case 'status':
                                response = {
                                    topic: 'status',
                                    payload: {
                                        streams: node.discovery.getStreams().length,
                                        devices: node.discovery.getDevices().length,
                                        subscriptions: node.router.getSubscriptions().length,
                                        discovery: node.discovery.running ? 'active' : 'stopped',
                                        sdpAvailable: sdpAvailable
                                    }
                                };
                                outputPort = 2;
                                break;
                                
                            default:
                                if (topic) {
                                    node.warn(`Unknown topic: ${topic}`);
                                }
                                break;
                        }
                        
                        if (response) {
                            const outputs = [null, null, null];
                            outputs[outputPort] = response;
                            send(outputs);
                        }
                        
                        done();
                        
                    } catch (error) {
                        node.error(`Error processing message: ${error.message}`, msg);
                        send([null, null, {
                            topic: 'error',
                            payload: { error: error.message }
                        }]);
                        done();
                    }
                } catch (err) {
                    node.error(`Critical error in input handler: ${err.message}`, msg);
                    done(err);
                }
            });
            
            // Cleanup
            node.on('close', function(done) {
                try {
                    if (node.discovery) {
                        node.discovery.stop();
                    }
                    if (node.router) {
                        node.router.shutdown();
                    }
                    // Give sockets time to close
                    setTimeout(() => {
                        done();
                    }, 100);
                } catch (err) {
                    node.error(`Error during cleanup: ${err.message}`);
                    done();
                }
            });
            
            node.log('AES67 Router node initialized');
            
        } catch (err) {
            // Critical error during node creation
            RED.log.error(`Failed to create AES67 Router node: ${err.message}`);
            if (this.error) {
                this.error(`Initialization failed: ${err.message}`);
            }
            if (this.status) {
                this.status({ fill: "red", shape: "ring", text: "initialization failed" });
            }
        }
    }
    
    // Register the node type with error handling
    try {
        RED.nodes.registerType("aes67-router", AES67RouterNode);
    } catch (err) {
        RED.log.error(`Failed to register AES67 Router node: ${err.message}`);
    }
    
    // HTTP Admin endpoints with error handling
    RED.httpAdmin.get('/aes67/streams', function(req, res) {
        try {
            const streams = Array.from(globalStreamRegistry.values());
            res.json(streams);
        } catch (err) {
            RED.log.error(`Error getting streams: ${err.message}`);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    
    RED.httpAdmin.post('/aes67/subscribe', function(req, res) {
        try {
            const { nodeId, streamKey, localPort } = req.body || {};
            
            if (!nodeId || !streamKey) {
                res.status(400).json({ error: 'Missing required parameters' });
                return;
            }
            
            const node = RED.nodes.getNode(nodeId);
            
            if (node && node.router) {
                const result = node.router.createSubscription(streamKey, localPort);
                res.json(result);
            } else {
                res.status(404).json({ error: 'Node not found' });
            }
        } catch (err) {
            RED.log.error(`Error creating subscription: ${err.message}`);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
};
