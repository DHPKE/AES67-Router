module.exports = function(RED) {
    const dgram = require('dgram');
    const os = require('os');
    
    // RTP Packet Parser
    class RTPPacketParser {
        constructor() {
            this.lastSequence = null;
            this.packetsLost = 0;
            this.packetsReceived = 0;
        }
        
        parsePacket(buffer) {
            if (buffer.length < 12) {
                return null; // Invalid RTP packet
            }
            
            // Parse RTP header
            const header = {
                version: (buffer[0] >> 6) & 0x3,
                padding: (buffer[0] >> 5) & 0x1,
                extension: (buffer[0] >> 4) & 0x1,
                csrcCount: buffer[0] & 0xF,
                marker: (buffer[1] >> 7) & 0x1,
                payloadType: buffer[1] & 0x7F,
                sequenceNumber: buffer.readUInt16BE(2),
                timestamp: buffer.readUInt32BE(4),
                ssrc: buffer.readUInt32BE(8)
            };
            
            // Check for lost packets
            if (this.lastSequence !== null) {
                const expected = (this.lastSequence + 1) & 0xFFFF;
                if (header.sequenceNumber !== expected) {
                    const lost = (header.sequenceNumber - expected + 0x10000) & 0xFFFF;
                    this.packetsLost += lost;
                }
            }
            this.lastSequence = header.sequenceNumber;
            this.packetsReceived++;
            
            // Calculate header length
            let headerLength = 12 + (header.csrcCount * 4);
            
            // Handle extension header if present
            if (header.extension) {
                if (buffer.length >= headerLength + 4) {
                    const extLength = buffer.readUInt16BE(headerLength + 2) * 4;
                    headerLength += 4 + extLength;
                }
            }
            
            // Extract payload
            let payload = buffer.slice(headerLength);
            
            // Remove padding if present
            if (header.padding && payload.length > 0) {
                const paddingLength = payload[payload.length - 1];
                payload = payload.slice(0, -paddingLength);
            }
            
            return {
                header: header,
                payload: payload
            };
        }
        
        getStats() {
            return {
                packetsReceived: this.packetsReceived,
                packetsLost: this.packetsLost,
                lossRate: this.packetsReceived > 0 ? 
                    (this.packetsLost / (this.packetsReceived + this.packetsLost)) : 0
            };
        }
        
        reset() {
            this.lastSequence = null;
            this.packetsLost = 0;
            this.packetsReceived = 0;
        }
    }
    
    // Audio Buffer Manager
    class AudioBufferManager {
        constructor(sampleRate, channels, bytesPerSample) {
            this.sampleRate = sampleRate;
            this.channels = channels;
            this.bytesPerSample = bytesPerSample;
            this.buffers = [];
            this.maxBufferSize = sampleRate * channels * bytesPerSample * 0.1; // 100ms buffer
        }
        
        addAudioData(data) {
            this.buffers.push(data);
            
            // Trim buffer if it gets too large
            const totalSize = this.buffers.reduce((sum, buf) => sum + buf.length, 0);
            if (totalSize > this.maxBufferSize) {
                // Remove oldest buffers
                while (this.buffers.length > 0 && 
                       this.buffers.reduce((sum, buf) => sum + buf.length, 0) > this.maxBufferSize * 0.8) {
                    this.buffers.shift();
                }
            }
        }
        
        getAudioData(requestedSize) {
            if (this.buffers.length === 0) {
                return null;
            }
            
            const available = this.buffers.reduce((sum, buf) => sum + buf.length, 0);
            if (available < requestedSize) {
                return null;
            }
            
            const result = Buffer.allocUnsafe(requestedSize);
            let offset = 0;
            
            while (offset < requestedSize && this.buffers.length > 0) {
                const buffer = this.buffers[0];
                const needed = requestedSize - offset;
                
                if (buffer.length <= needed) {
                    // Use entire buffer
                    buffer.copy(result, offset);
                    offset += buffer.length;
                    this.buffers.shift();
                } else {
                    // Use part of buffer
                    buffer.copy(result, offset, 0, needed);
                    this.buffers[0] = buffer.slice(needed);
                    offset += needed;
                }
            }
            
            return result;
        }
        
        clear() {
            this.buffers = [];
        }
        
        getBufferedAmount() {
            return this.buffers.reduce((sum, buf) => sum + buf.length, 0);
        }
    }
    
    // AES67 Receiver Node
    function AES67ReceiverNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        
        // Configuration
        node.streamSource = config.streamSource || 'auto'; // 'auto' or 'manual'
        node.sourceIP = config.sourceIP || '';
        node.sourcePort = config.sourcePort || 5004;
        node.multicastGroup = config.multicastGroup || '';
        node.localPort = parseInt(config.localPort) || 0; // 0 = auto-assign
        node.sampleRate = parseInt(config.sampleRate) || 48000;
        node.channels = parseInt(config.channels) || 2;
        node.encoding = config.encoding || 'L24';
        node.outputMode = config.outputMode || 'buffer'; // 'buffer' or 'stream'
        
        // Calculate bytes per sample
        const bitsPerSample = node.encoding === 'L24' ? 24 : 
                             node.encoding === 'L16' ? 16 : 24;
        node.bytesPerSample = bitsPerSample / 8;
        
        // Runtime state
        node.rtpSocket = null;
        node.rtpParser = new RTPPacketParser();
        node.audioBuffer = new AudioBufferManager(node.sampleRate, node.channels, node.bytesPerSample);
        node.running = false;
        node.statsInterval = null;
        
        // Initialize
        node.status({ fill: "yellow", shape: "ring", text: "initializing..." });
        
        try {
            // Create RTP receiver socket
            node.rtpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            
            node.rtpSocket.on('error', (err) => {
                node.error(`RTP socket error: ${err.message}`);
                node.status({ fill: "red", shape: "ring", text: "socket error" });
            });
            
            node.rtpSocket.on('message', (msg, rinfo) => {
                handleRTPPacket(node, msg, rinfo);
            });
            
            node.rtpSocket.bind(node.localPort, '0.0.0.0', () => {
                const actualPort = node.rtpSocket.address().port;
                node.localPort = actualPort;
                
                // Join multicast group if specified
                if (node.multicastGroup) {
                    try {
                        node.rtpSocket.addMembership(node.multicastGroup);
                        node.log(`Joined multicast group: ${node.multicastGroup}`);
                    } catch (e) {
                        node.warn(`Could not join multicast ${node.multicastGroup}: ${e.message}`);
                    }
                }
                
                node.running = true;
                node.status({ 
                    fill: "green", 
                    shape: "dot", 
                    text: `listening on port ${actualPort}` 
                });
                
                node.log(`AES67 receiver listening on port ${actualPort}`);
            });
            
            // Periodic stats update
            node.statsInterval = setInterval(() => {
                updateStats(node);
            }, 5000);
            
        } catch (err) {
            node.error(`Failed to initialize receiver: ${err.message}`);
            node.status({ fill: "red", shape: "ring", text: "initialization failed" });
        }
        
        // Handle input messages
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments) };
            done = done || function(err) { if(err) node.error(err, msg) };
            
            try {
                if (msg.topic === 'control') {
                    handleControlMessage(node, msg, send, done);
                } else if (msg.topic === 'subscribe' && msg.payload) {
                    // Dynamic subscription
                    subscribeToStream(node, msg.payload, send, done);
                } else {
                    done();
                }
            } catch (error) {
                node.error(error.message);
                done(error);
            }
        });
        
        // Cleanup
        node.on('close', function(done) {
            node.running = false;
            
            if (node.statsInterval) {
                clearInterval(node.statsInterval);
            }
            
            if (node.rtpSocket) {
                try {
                    if (node.multicastGroup) {
                        node.rtpSocket.dropMembership(node.multicastGroup);
                    }
                    node.rtpSocket.close();
                } catch (e) {}
            }
            
            node.status({ fill: "gray", shape: "ring", text: "stopped" });
            done();
        });
    }
    
    function handleRTPPacket(node, buffer, rinfo) {
        if (!node.running) return;
        
        // Parse RTP packet
        const packet = node.rtpParser.parsePacket(buffer);
        if (!packet) return;
        
        // Add audio data to buffer
        if (packet.payload && packet.payload.length > 0) {
            node.audioBuffer.addAudioData(packet.payload);
        }
        
        // Output mode handling
        if (node.outputMode === 'buffer') {
            // Send buffered audio periodically
            const chunkSize = node.sampleRate * node.channels * node.bytesPerSample * 0.01; // 10ms chunks
            const audioData = node.audioBuffer.getAudioData(chunkSize);
            
            if (audioData) {
                node.send({
                    topic: 'audio',
                    payload: audioData,
                    format: {
                        sampleRate: node.sampleRate,
                        channels: node.channels,
                        encoding: node.encoding,
                        bytesPerSample: node.bytesPerSample
                    },
                    rtp: {
                        timestamp: packet.header.timestamp,
                        sequenceNumber: packet.header.sequenceNumber,
                        ssrc: packet.header.ssrc
                    }
                });
            }
        } else if (node.outputMode === 'stream') {
            // Send each packet immediately
            node.send({
                topic: 'audio',
                payload: packet.payload,
                format: {
                    sampleRate: node.sampleRate,
                    channels: node.channels,
                    encoding: node.encoding,
                    bytesPerSample: node.bytesPerSample
                },
                rtp: {
                    timestamp: packet.header.timestamp,
                    sequenceNumber: packet.header.sequenceNumber,
                    ssrc: packet.header.ssrc,
                    marker: packet.header.marker
                }
            });
        }
    }
    
    function handleControlMessage(node, msg, send, done) {
        const command = msg.payload && msg.payload.command;
        
        switch(command) {
            case 'status':
                const stats = node.rtpParser.getStats();
                send({
                    topic: 'status',
                    payload: {
                        running: node.running,
                        localPort: node.localPort,
                        multicastGroup: node.multicastGroup,
                        sampleRate: node.sampleRate,
                        channels: node.channels,
                        encoding: node.encoding,
                        bufferedBytes: node.audioBuffer.getBufferedAmount(),
                        stats: stats
                    }
                });
                break;
                
            case 'reset':
                node.rtpParser.reset();
                node.audioBuffer.clear();
                node.log('Receiver reset');
                break;
                
            default:
                node.warn(`Unknown control command: ${command}`);
        }
        
        done();
    }
    
    function subscribeToStream(node, streamInfo, send, done) {
        try {
            // Leave current multicast group if any
            if (node.multicastGroup && node.rtpSocket) {
                try {
                    node.rtpSocket.dropMembership(node.multicastGroup);
                } catch (e) {}
            }
            
            // Update configuration
            if (streamInfo.multicastGroup) {
                node.multicastGroup = streamInfo.multicastGroup;
            }
            if (streamInfo.sampleRate) {
                node.sampleRate = streamInfo.sampleRate;
            }
            if (streamInfo.channels) {
                node.channels = streamInfo.channels;
            }
            if (streamInfo.encoding) {
                node.encoding = streamInfo.encoding;
            }
            
            // Join new multicast group
            if (node.multicastGroup && node.rtpSocket) {
                try {
                    node.rtpSocket.addMembership(node.multicastGroup);
                    node.log(`Subscribed to stream: ${node.multicastGroup}`);
                } catch (e) {
                    node.warn(`Could not join multicast ${node.multicastGroup}: ${e.message}`);
                }
            }
            
            // Reset parser and buffer
            node.rtpParser.reset();
            node.audioBuffer.clear();
            
            node.status({ 
                fill: "green", 
                shape: "dot", 
                text: `receiving ${node.channels}ch @ ${node.sampleRate}Hz` 
            });
            
            done();
            
        } catch (err) {
            node.error(`Failed to subscribe: ${err.message}`);
            done(err);
        }
    }
    
    function updateStats(node) {
        if (!node.running) return;
        
        const stats = node.rtpParser.getStats();
        
        if (stats.packetsReceived > 0) {
            const lossPercent = (stats.lossRate * 100).toFixed(2);
            node.status({ 
                fill: stats.lossRate > 0.05 ? "yellow" : "green", 
                shape: "dot", 
                text: `${stats.packetsReceived} pkts, ${lossPercent}% loss` 
            });
        }
    }
    
    RED.nodes.registerType("aes67-receiver", AES67ReceiverNode);
};
