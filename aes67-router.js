module.exports = function(RED) {
    const dgram = require('dgram');
    const os = require('os');
    const sdp = require('sdp-transform');
    const crypto = require('crypto');
    
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
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return iface.address;
                    }
                }
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
                this.sapSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                
                this.sapSocket.on('error', (err) => {
                    this.node.error(`SAP socket error: ${err.message}`);
                    reject(err);
                });
                
                this.sapSocket.on('message', (msg, rinfo) => {
                    this.handleSAPMessage(msg, rinfo);
                });
                
                this.sapSocket.on('listening', () => {
                    const address = this.sapSocket.address();
                    this.node.log(`SAP listener on ${address.address}:${address.port}`);
                    
                    // Join SAP multicast group
                    try {
                        this.sapSocket.addMembership(AES67_SAP_MULTICAST);
                        this.sapSocket.addMembership('239.192.0.0'); // Alternative SAP multicast
                        this.sapSocket.setBroadcast(true);
                        this.sapSocket.setMulticastTTL(32);
                    } catch (e) {
                        this.node.warn(`Could not join multicast: ${e.message}`);
                    }
                    
                    resolve();
                });
                
                this.sapSocket.bind(AES67_SAP_PORT, '0.0.0.0');
            });
        }
        
        handleSAPMessage(msg, rinfo) {
            try {
                // Parse SAP header (RFC 2974)
                if (msg.length < 8) return;
                
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
                
                // Extract originating source
                const sourceIP = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
                
                // Calculate SDP offset
                let sdpOffset = 8; // Basic SAP header
                sdpOffset += sapHeader.authLength * 4; // Authentication data
                
                // Find the payload type field (after null terminator)
                while (sdpOffset < msg.length && msg[sdpOffset] !== 0) {
                    sdpOffset++;
                }
                sdpOffset += 1; // Skip null terminator
                
                // Skip payload type identifier
                if (sdpOffset + 8 < msg.length) {
                    const payloadType = msg.slice(sdpOffset, sdpOffset + 8).toString();
                    if (payloadType.includes('sdp')) {
                        sdpOffset += 8;
                    }
                }
                
                // Extract SDP payload
                const sdpData = msg.slice(sdpOffset).toString('utf8');
                
                if (sdpData.startsWith('v=0')) {
                    this.parseSDP(sdpData, sourceIP, rinfo.address, sapHeader.messageType);
                }
                
            } catch (err) {
                // Invalid SAP packet, ignore
            }
        }
        
        parseSDP(sdpString, sourceIP, actualIP, messageType) {
            try {
                // Parse SDP using sdp-transform
                const session = sdp.parse(sdpString);
                
                if (!session || !session.media) return;
                
                // Process each media stream
                session.media.forEach(media => {
                    if (media.type === 'audio' && media.protocol === 'RTP/AVP') {
                        const streamInfo = {
                            id: session.origin?.sessionId || crypto.randomBytes(8).toString('hex'),
                            name: session.name || 'AES67 Stream',
                            description: session.description || '',
                            sourceIP: actualIP || sourceIP,
                            destIP: media.connection?.ip || session.connection?.ip,
                            port: media.port,
                            channels: this.extractChannels(media),
                            sampleRate: this.extractSampleRate(media),
                            encoding: this.extractEncoding(media),
                            ptime: media.ptime || 1, // Packet time in ms
                            mediaClk: this.extractMediaClock(media),
                            isMulticast: this.isMulticastIP(media.connection?.ip || session.connection?.ip),
                            sdp: sdpString,
                            lastSeen: Date.now(),
                            status: messageType === 0 ? 'active' : 'deleted'
                        };
                        
                        // Register the stream
                        this.registerStream(streamInfo);
                    }
                });
                
            } catch (err) {
                this.node.debug(`Failed to parse SDP: ${err.message}`);
            }
        }
        
        extractChannels(media) {
            // Look for channel count in rtpmap
            if (media.rtpmap) {
                for (const rtpmap of media.rtpmap) {
                    if (rtpmap.channels) {
                        return rtpmap.channels;
                    }
                }
            }
            // Default to 2 channels (stereo)
            return 2;
        }
        
        extractSampleRate(media) {
            // Look for sample rate in rtpmap
            if (media.rtpmap) {
                for (const rtpmap of media.rtpmap) {
                    if (rtpmap.rate) {
                        return rtpmap.rate;
                    }
                }
            }
            return AES67_SAMPLE_RATE;
        }
        
        extractEncoding(media) {
            // Look for encoding in rtpmap
            if (media.rtpmap) {
                for (const rtpmap of media.rtpmap) {
                    if (rtpmap.name) {
                        return rtpmap.name; // L24, L16, etc.
                    }
                }
            }
            return 'L24'; // Default to 24-bit PCM
        }
        
        extractMediaClock(media) {
            // Look for media clock reference
            if (media.mediaclk) {
                return media.mediaclk;
            }
            // Check for PTP clock
            if (media.tsRefClk) {
                return media.tsRefClk;
            }
            return 'ptp=IEEE1588-2008:00-00-00-00-00-00-00-00:0';
        }
        
        isMulticastIP(ip) {
            if (!ip) return false;
            const parts = ip.split('.');
            const firstOctet = parseInt(parts[0]);
            return firstOctet >= 224 && firstOctet <= 239;
        }
        
        registerStream(streamInfo) {
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
            if (!device.streams.includes(streamKey)) {
                device.streams.push(streamKey);
            }
            
            // Send notification for new streams
            if (isNew && streamInfo.status === 'active') {
                this.node.send([{
                    topic: 'stream/discovered',
                    payload: streamInfo
                }, null, null]);
                
                this.node.log(`Discovered AES67 stream: ${streamInfo.name} from ${streamInfo.sourceIP} (${streamInfo.channels}ch @ ${streamInfo.sampleRate}Hz)`);
            }
            
            this.updateNodeStatus();
        }
        
        sendSAPAnnouncements() {
            // Announce our own streams (if any)
            // This is where you would announce streams this node is transmitting
            
            // For now, send a discovery probe
            const discoverySDP = this.createDiscoverySDP();
            const sapPacket = this.createSAPPacket(discoverySDP);
            
            if (this.sapSocket) {
                this.sapSocket.send(sapPacket, AES67_SAP_PORT, AES67_SAP_MULTICAST, (err) => {
                    if (err) {
                        this.node.debug(`SAP send error: ${err.message}`);
                    }
                });
            }
        }
        
        createDiscoverySDP() {
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
        }
        
        createSAPPacket(sdpData) {
            const sdpBuffer = Buffer.from(sdpData, 'utf8');
            const packet = Buffer.allocUnsafe(8 + 8 + sdpBuffer.length);
            
            // SAP Header
            packet[0] = 0x20; // Version 1, IPv4, announcement
            packet[1] = 0x00; // No authentication
            packet.writeUInt16BE(0x0000, 2); // Message ID hash
            
            // Originating source (our IP)
            const ipParts = this.localIP.split('.').map(p => parseInt(p));
            packet[4] = ipParts[0];
            packet[5] = ipParts[1];
            packet[6] = ipParts[2];
            packet[7] = ipParts[3];
            
            // Payload type
            packet.write('application/sdp', 8, 'ascii');
            
            // SDP data
            sdpBuffer.copy(packet, 8 + 8);
            
            return packet;
        }
        
        cleanupStaleStreams() {
            const now = Date.now();
            const timeout = 120000; // 2 minutes
            
            for (const [key, stream] of this.streams) {
                if (now - stream.lastSeen > timeout) {
                    this.streams.delete(key);
                    globalStreamRegistry.delete(key);
                    
                    this.node.send([{
                        topic: 'stream/removed',
                        payload: stream
                    }, null, null]);
                }
            }
            
            this.updateNodeStatus();
        }
        
        updateNodeStatus() {
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
            const stream = globalStreamRegistry.get(streamKey);
            if (!stream) {
                return { success: false, error: 'Stream not found' };
            }
            
            const subscriptionId = `${streamKey}_${localPort}`;
            
            if (this.subscriptions.has(subscriptionId)) {
                return { success: false, error: 'Subscription already exists' };
            }
            
            // Create RTP receiver socket
            const rtpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            
            rtpSocket.on('message', (msg, rinfo) => {
                // Handle RTP packets
                this.handleRTPPacket(msg, rinfo, subscriptionId);
            });
            
            rtpSocket.on('error', (err) => {
                this.node.warn(`RTP socket error: ${err.message}`);
            });
            
            // Bind to local port
            rtpSocket.bind(localPort || 0, '0.0.0.0', () => {
                const actualPort = rtpSocket.address().port;
                
                // Join multicast group if needed
                if (stream.isMulticast) {
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
            });
            
            return { 
                success: true, 
                subscription: subscriptionId,
                message: `Subscribed to ${stream.name}`
            };
        }
        
        handleRTPPacket(msg, rinfo, subscriptionId) {
            const subscription = this.subscriptions.get(subscriptionId);
            if (!subscription) return;
            
            // Update statistics
            subscription.packetsReceived++;
            subscription.bytesReceived += msg.length;
            
            // Parse RTP header
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
            
            // Calculate header length
            let headerLength = 12 + (rtpHeader.csrcCount * 4);
            if (rtpHeader.extension) {
                headerLength += 4 + (msg.readUInt16BE(headerLength + 2) * 4);
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
        }
        
        removeSubscription(subscriptionId) {
            const subscription = this.subscriptions.get(subscriptionId);
            if (!subscription) {
                return { success: false, error: 'Subscription not found' };
            }
            
            // Close RTP socket
            const socket = this.rtpSockets.get(subscriptionId);
            if (socket) {
                socket.close();
                this.rtpSockets.delete(subscriptionId);
            }
            
            this.subscriptions.delete(subscriptionId);
            
            return { 
                success: true, 
                message: `Removed subscription to ${subscription.stream.name}`
            };
        }
        
        getSubscriptions() {
            return Array.from(this.subscriptions.values());
        }
        
        shutdown() {
            // Close all RTP sockets
            for (const socket of this.rtpSockets.values()) {
                try {
                    socket.close();
                } catch (e) {}
            }
            this.rtpSockets.clear();
            this.subscriptions.clear();
        }
    }
    
    // Main Node-RED Node
    function AES67RouterNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        node.name = config.name || 'AES67 Router';
        node.autoDiscover = config.autoDiscover !== false;
        
        // Initialize components
        node.discovery = new AES67Discovery(node);
        node.router = new AES67Router(node);
        
        // Start discovery
        if (node.autoDiscover) {
            node.discovery.start();
        }
        
        // Handle input messages
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments) };
            done = done || function(err) { if(err) node.error(err, msg) };
            
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
                        if (payload.streamKey) {
                            const result = node.router.createSubscription(
                                payload.streamKey,
                                payload.localPort
                            );
                            response = {
                                topic: result.success ? 'subscribed' : 'subscription_error',
                                payload: result
                            };
                        } else {
                            throw new Error('Stream key required for subscription');
                        }
                        break;
                        
                    case 'unsubscribe':
                        if (payload.subscriptionId) {
                            const result = node.router.removeSubscription(payload.subscriptionId);
                            response = {
                                topic: 'unsubscribed',
                                payload: result
                            };
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
                                discovery: node.discovery.running ? 'active' : 'stopped'
                            }
                        };
                        outputPort = 2;
                        break;
                }
                
                if (response) {
                    const outputs = [null, null, null];
                    outputs[outputPort] = response;
                    send(outputs);
                }
                
                done();
                
            } catch (error) {
                node.error(error.message);
                send([null, null, {
                    topic: 'error',
                    payload: { error: error.message }
                }]);
                done();
            }
        });
        
        // Cleanup
        node.on('close', function(done) {
            node.discovery.stop();
            node.router.shutdown();
            done();
        });
        
        node.log('AES67 Router node initialized');
    }
    
    RED.nodes.registerType("aes67-router", AES67RouterNode);
    
    // HTTP Admin endpoints
    RED.httpAdmin.get('/aes67/streams', function(req, res) {
        const streams = Array.from(globalStreamRegistry.values());
        res.json(streams);
    });
    
    RED.httpAdmin.post('/aes67/subscribe', function(req, res) {
        const { nodeId, streamKey, localPort } = req.body;
        const node = RED.nodes.getNode(nodeId);
        
        if (node && node.router) {
            const result = node.router.createSubscription(streamKey, localPort);
            res.json(result);
        } else {
            res.status(404).json({ error: 'Node not found' });
        }
    });
};
