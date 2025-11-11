module.exports = function(RED) {
    const dgram = require('dgram');
    const os = require('os');
    const sdp = require('sdp-transform');
    const crypto = require('crypto');
    
    // AES67 Constants
    const AES67_SAP_PORT = 9875;
    const AES67_SAP_MULTICAST = '239.255.255.255';
    const AES67_RTP_PAYLOAD_TYPE = 96; // Dynamic payload type for L24
    const AES67_SSRC_BASE = 0x67670000; // Base SSRC for AES67
    
    // RTP Packet Builder
    class RTPPacketBuilder {
        constructor(payloadType, ssrc, sampleRate) {
            this.payloadType = payloadType;
            this.ssrc = ssrc;
            this.sampleRate = sampleRate;
            this.sequenceNumber = Math.floor(Math.random() * 65535);
            this.timestamp = Math.floor(Math.random() * 0xFFFFFFFF);
        }
        
        buildPacket(audioData, marker = false) {
            // RTP header is 12 bytes
            const header = Buffer.allocUnsafe(12);
            
            // Byte 0: Version (2), Padding (0), Extension (0), CSRC count (0)
            header[0] = 0x80; // Version 2
            
            // Byte 1: Marker bit and Payload Type
            header[1] = (marker ? 0x80 : 0x00) | (this.payloadType & 0x7F);
            
            // Bytes 2-3: Sequence Number
            header.writeUInt16BE(this.sequenceNumber, 2);
            
            // Bytes 4-7: Timestamp
            header.writeUInt32BE(this.timestamp, 4);
            
            // Bytes 8-11: SSRC
            header.writeUInt32BE(this.ssrc, 8);
            
            // Combine header and payload
            const packet = Buffer.concat([header, audioData]);
            
            // Increment sequence number (with wrap)
            this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
            
            return packet;
        }
        
        incrementTimestamp(samples) {
            // Increment timestamp based on number of samples
            this.timestamp = (this.timestamp + samples) & 0xFFFFFFFF;
        }
    }
    
    // SAP Announcer
    class SAPAnnouncer {
        constructor(node, streamConfig) {
            this.node = node;
            this.config = streamConfig;
            this.sapSocket = null;
            this.announcementInterval = null;
            this.msgIdHash = crypto.randomBytes(2).readUInt16BE(0);
        }
        
        async start() {
            try {
                this.sapSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                
                this.sapSocket.on('error', (err) => {
                    this.node.warn(`SAP socket error: ${err.message}`);
                });
                
                // Send SAP announcements every 30 seconds
                this.announcementInterval = setInterval(() => {
                    this.sendAnnouncement();
                }, 30000);
                
                // Send initial announcement
                this.sendAnnouncement();
                
                this.node.log('SAP announcements started');
                
            } catch (err) {
                this.node.error(`Failed to start SAP announcer: ${err.message}`);
                throw err;
            }
        }
        
        sendAnnouncement() {
            const sdpData = this.createSDP();
            const sapPacket = this.createSAPPacket(sdpData);
            
            if (this.sapSocket) {
                this.sapSocket.send(sapPacket, AES67_SAP_PORT, AES67_SAP_MULTICAST, (err) => {
                    if (err) {
                        this.node.debug(`SAP send error: ${err.message}`);
                    }
                });
            }
        }
        
        createSDP() {
            const session = {
                version: 0,
                origin: {
                    username: 'node-red',
                    sessionId: this.config.sessionId || Date.now().toString(),
                    sessionVersion: 1,
                    netType: 'IN',
                    addressType: 'IP4',
                    unicastAddress: this.config.sourceIP
                },
                name: this.config.streamName || 'Node-RED AES67 Stream',
                timing: {
                    start: 0,
                    stop: 0
                },
                connection: {
                    version: 4,
                    ip: this.config.destIP
                },
                media: [{
                    type: 'audio',
                    port: this.config.port,
                    protocol: 'RTP/AVP',
                    payloads: this.config.payloadType.toString(),
                    rtp: [{
                        payload: this.config.payloadType,
                        codec: this.config.encoding,
                        rate: this.config.sampleRate,
                        encoding: this.config.channels
                    }],
                    ptime: this.config.ptime || 1,
                    fmtp: []
                }]
            };
            
            // Add PTP clock reference
            if (this.config.ptpDomain !== undefined) {
                session.media[0].tsRefClk = `ptp=IEEE1588-2008:${this.config.ptpDomain}`;
                session.media[0].mediaclk = 'direct=0';
            }
            
            return sdp.write(session);
        }
        
        createSAPPacket(sdpData) {
            const sdpBuffer = Buffer.from(sdpData, 'utf8');
            const payloadType = Buffer.from('application/sdp\0', 'ascii');
            const packet = Buffer.allocUnsafe(8 + payloadType.length + sdpBuffer.length);
            
            // SAP Header
            packet[0] = 0x20; // Version 1, IPv4, announcement
            packet[1] = 0x00; // No authentication
            packet.writeUInt16BE(this.msgIdHash, 2); // Message ID hash
            
            // Originating source (our IP)
            const ipParts = this.config.sourceIP.split('.').map(p => parseInt(p));
            packet[4] = ipParts[0];
            packet[5] = ipParts[1];
            packet[6] = ipParts[2];
            packet[7] = ipParts[3];
            
            // Payload type
            payloadType.copy(packet, 8);
            
            // SDP data
            sdpBuffer.copy(packet, 8 + payloadType.length);
            
            return packet;
        }
        
        sendDeletion() {
            // Send deletion announcement (messageType = 1)
            const sdpData = this.createSDP();
            const sdpBuffer = Buffer.from(sdpData, 'utf8');
            const payloadType = Buffer.from('application/sdp\0', 'ascii');
            const packet = Buffer.allocUnsafe(8 + payloadType.length + sdpBuffer.length);
            
            // SAP Header with deletion bit set
            packet[0] = 0x24; // Version 1, IPv4, deletion
            packet[1] = 0x00;
            packet.writeUInt16BE(this.msgIdHash, 2);
            
            const ipParts = this.config.sourceIP.split('.').map(p => parseInt(p));
            packet[4] = ipParts[0];
            packet[5] = ipParts[1];
            packet[6] = ipParts[2];
            packet[7] = ipParts[3];
            
            payloadType.copy(packet, 8);
            sdpBuffer.copy(packet, 8 + payloadType.length);
            
            if (this.sapSocket) {
                this.sapSocket.send(packet, AES67_SAP_PORT, AES67_SAP_MULTICAST);
            }
        }
        
        stop() {
            if (this.announcementInterval) {
                clearInterval(this.announcementInterval);
            }
            
            // Send deletion announcement
            this.sendDeletion();
            
            if (this.sapSocket) {
                try {
                    this.sapSocket.close();
                } catch (e) {}
            }
        }
    }
    
    // AES67 Sender Node
    function AES67SenderNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        node.streamName = config.streamName || 'AES67 Stream';
        node.sampleRate = parseInt(config.sampleRate) || 48000;
        node.channels = parseInt(config.channels) || 2;
        node.encoding = config.encoding || 'L24';
        node.ptime = parseInt(config.ptime) || 1;
        node.destIP = config.destIP || '239.69.1.1';
        node.destPort = parseInt(config.destPort) || 5004;
        node.ptpDomain = config.ptpDomain !== undefined ? parseInt(config.ptpDomain) : 0;
        node.enableSAP = config.enableSAP !== false;
        
        // Calculate bits per sample based on encoding
        const bitsPerSample = node.encoding === 'L24' ? 24 : 
                             node.encoding === 'L16' ? 16 : 24;
        node.bytesPerSample = bitsPerSample / 8;
        
        // Runtime state
        node.rtpSocket = null;
        node.sapAnnouncer = null;
        node.rtpBuilder = null;
        node.running = false;
        
        // Get local IP
        node.localIP = getLocalIP();
        
        // Initialize
        node.status({ fill: "yellow", shape: "ring", text: "initializing..." });
        
        try {
            // Create RTP socket
            node.rtpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            
            node.rtpSocket.on('error', (err) => {
                node.error(`RTP socket error: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: "socket error" });
            });
            
            // Generate SSRC
            const ssrc = AES67_SSRC_BASE + Math.floor(Math.random() * 0xFFFF);
            
            // Initialize RTP packet builder
            node.rtpBuilder = new RTPPacketBuilder(AES67_RTP_PAYLOAD_TYPE, ssrc, node.sampleRate);
            
            // Start SAP announcements if enabled
            if (node.enableSAP) {
                const streamConfig = {
                    streamName: node.streamName,
                    sourceIP: node.localIP,
                    destIP: node.destIP,
                    port: node.destPort,
                    sampleRate: node.sampleRate,
                    channels: node.channels,
                    encoding: node.encoding,
                    ptime: node.ptime,
                    ptpDomain: node.ptpDomain,
                    payloadType: AES67_RTP_PAYLOAD_TYPE,
                    sessionId: Date.now().toString()
                };
                
                node.sapAnnouncer = new SAPAnnouncer(node, streamConfig);
                node.sapAnnouncer.start();
            }
            
            node.running = true;
            node.status({ fill: "green", shape: "dot", text: "ready" });
            node.log(`AES67 sender initialized: ${node.channels}ch @ ${node.sampleRate}Hz (${node.encoding}) -> ${node.destIP}:${node.destPort}`);
            
        } catch (err) {
            node.error(`Failed to initialize sender: ${err.message}`);
            node.status({ fill: "red", shape: "ring", text: "initialization failed" });
        }
        
        // Handle input messages
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments) };
            done = done || function(err) { if(err) node.error(err, msg) };
            
            try {
                if (!node.running) {
                    done(new Error('Sender not running'));
                    return;
                }
                
                // Handle control messages
                if (msg.topic === 'control') {
                    handleControlMessage(node, msg, send, done);
                    return;
                }
                
                // Handle audio data
                if (msg.payload && Buffer.isBuffer(msg.payload)) {
                    sendAudioData(node, msg.payload, send);
                    done();
                } else if (msg.payload && msg.payload.audio && Buffer.isBuffer(msg.payload.audio)) {
                    sendAudioData(node, msg.payload.audio, send);
                    done();
                } else {
                    done(new Error('Invalid audio data: expected Buffer'));
                }
                
            } catch (error) {
                node.error(error.message);
                done(error);
            }
        });
        
        // Cleanup
        node.on('close', function(done) {
            node.running = false;
            
            if (node.sapAnnouncer) {
                node.sapAnnouncer.stop();
            }
            
            if (node.rtpSocket) {
                try {
                    node.rtpSocket.close();
                } catch (e) {}
            }
            
            node.status({ fill: "gray", shape: "ring", text: "stopped" });
            done();
        });
    }
    
    function handleControlMessage(node, msg, send, done) {
        const command = msg.payload && msg.payload.command;
        
        switch(command) {
            case 'status':
                send({
                    topic: 'status',
                    payload: {
                        running: node.running,
                        streamName: node.streamName,
                        sampleRate: node.sampleRate,
                        channels: node.channels,
                        encoding: node.encoding,
                        destination: `${node.destIP}:${node.destPort}`,
                        ptime: node.ptime
                    }
                });
                break;
                
            default:
                node.warn(`Unknown control command: ${command}`);
        }
        
        done();
    }
    
    function sendAudioData(node, audioBuffer, send) {
        try {
            // Calculate number of samples
            const samplesPerChannel = audioBuffer.length / (node.channels * node.bytesPerSample);
            
            // Build RTP packet
            const rtpPacket = node.rtpBuilder.buildPacket(audioBuffer);
            
            // Send RTP packet
            node.rtpSocket.send(rtpPacket, node.destPort, node.destIP, (err) => {
                if (err) {
                    node.warn(`RTP send error: ${err.message}`);
                }
            });
            
            // Increment timestamp for next packet
            node.rtpBuilder.incrementTimestamp(samplesPerChannel);
            
            // Update status periodically
            if (Math.random() < 0.01) { // 1% of packets
                node.status({ 
                    fill: "green", 
                    shape: "dot", 
                    text: `streaming ${node.channels}ch @ ${node.sampleRate}Hz` 
                });
            }
            
        } catch (err) {
            node.error(`Error sending audio: ${err.message}`);
        }
    }
    
    function getLocalIP() {
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
    
    RED.nodes.registerType("aes67-sender", AES67SenderNode);
};
