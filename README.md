# AES67 Router - Node-RED Contribution

A comprehensive suite of Node-RED nodes for AES67 audio-over-IP streaming, discovery, and routing.

## Overview

This package provides three powerful nodes for working with AES67 (SMPTE ST 2110-30) professional audio-over-IP:

- **AES67 Router** - Discovers and routes AES67 streams using SAP/SDP
- **AES67 Sender** - Transmits audio as AES67-compliant RTP streams
- **AES67 Receiver** - Receives AES67 RTP audio streams

## Features

### AES67 Router Node
- ✅ Automatic stream discovery via SAP (Session Announcement Protocol)
- ✅ SDP parsing for stream metadata
- ✅ RTP stream subscription management
- ✅ Real-time stream monitoring
- ✅ Multi-device support
- ✅ Multicast and unicast support

### AES67 Sender Node
- ✅ AES67-compliant RTP transmission
- ✅ SAP/SDP stream announcement
- ✅ Multiple sample rates (48kHz, 96kHz, etc.)
- ✅ Multi-channel audio support (1-64 channels)
- ✅ L24 (24-bit) and L16 (16-bit) PCM encoding
- ✅ PTP clock reference awareness
- ✅ Configurable packet time (ptime)
- ✅ Multicast streaming

### AES67 Receiver Node
- ✅ AES67-compliant RTP reception
- ✅ Multicast and unicast reception
- ✅ Packet loss detection and monitoring
- ✅ Audio buffering for smooth playback
- ✅ Dynamic stream subscription
- ✅ Real-time statistics
- ✅ Multiple sample rates and channels

## Installation

Install via Node-RED's palette manager or using npm:

```bash
npm install node-red-contrib-aes67-router
```

## Quick Start

### 1. Discovering Streams

Add an **AES67 Router** node to your flow. It will automatically start discovering AES67 streams on your network via SAP announcements.

```
[AES67 Router] --> [Debug]
```

The first output shows discovered streams:
```json
{
  "topic": "stream/discovered",
  "payload": {
    "name": "Studio A Main Mix",
    "sourceIP": "192.168.1.100",
    "destIP": "239.69.1.1",
    "port": 5004,
    "channels": 2,
    "sampleRate": 48000,
    "encoding": "L24"
  }
}
```

### 2. Receiving Audio

Add an **AES67 Receiver** node and configure it to receive a stream:

```
[AES67 Receiver] --> [Debug]
```

Configure the receiver with:
- **Multicast Group**: The destination IP from discovery (e.g., 239.69.1.1)
- **Sample Rate**: Must match the sender (e.g., 48000)
- **Channels**: Must match the sender (e.g., 2)
- **Encoding**: Must match the sender (e.g., L24)

The receiver outputs raw PCM audio buffers:
```json
{
  "topic": "audio",
  "payload": <Buffer ...>,
  "format": {
    "sampleRate": 48000,
    "channels": 2,
    "encoding": "L24",
    "bytesPerSample": 3
  }
}
```

### 3. Sending Audio

Add an **AES67 Sender** node and configure it:

```
[Audio Source] --> [AES67 Sender]
```

Configure the sender with:
- **Stream Name**: Descriptive name for your stream
- **Sample Rate**: 48000 or 96000 Hz
- **Channels**: Number of audio channels
- **Encoding**: L24 (24-bit) or L16 (16-bit)
- **Destination IP**: Multicast address (239.x.x.x)
- **Destination Port**: RTP port (typically 5004 or higher even numbers)

Send audio data as Buffer objects:
```javascript
msg.payload = audioBuffer; // Raw PCM audio as Buffer
return msg;
```

## Example Flows

### Stream Discovery and Monitoring

```json
[
  {
    "id": "router1",
    "type": "aes67-router",
    "name": "AES67 Discovery",
    "autoDiscover": true
  },
  {
    "id": "debug1",
    "type": "debug",
    "name": "Discovered Streams"
  }
]
```

### Simple Receiver Setup

```json
[
  {
    "id": "receiver1",
    "type": "aes67-receiver",
    "name": "Studio Feed",
    "multicastGroup": "239.69.1.1",
    "localPort": 5004,
    "sampleRate": 48000,
    "channels": 2,
    "encoding": "L24",
    "outputMode": "buffer"
  },
  {
    "id": "debug1",
    "type": "debug",
    "name": "Audio Output"
  }
]
```

### Audio Streaming

```json
[
  {
    "id": "sender1",
    "type": "aes67-sender",
    "name": "My Stream",
    "streamName": "Node-RED Audio",
    "sampleRate": 48000,
    "channels": 2,
    "encoding": "L24",
    "destIP": "239.69.1.2",
    "destPort": 5004,
    "enableSAP": true
  }
]
```

## Audio Data Format

### Input to Sender (msg.payload)
Audio data must be provided as raw PCM samples in a Buffer:
- **Byte Order**: Big-endian (network byte order)
- **Sample Size**: 24-bit (3 bytes) for L24, 16-bit (2 bytes) for L16
- **Channel Order**: Interleaved (e.g., L, R, L, R for stereo)
- **Alignment**: No padding between samples

Example for stereo L24 at 48kHz (1ms of audio):
```javascript
// 48 samples * 2 channels * 3 bytes = 288 bytes
const audioBuffer = Buffer.allocUnsafe(288);
// Fill with audio samples...
msg.payload = audioBuffer;
```

### Output from Receiver (msg.payload)
Received audio is output as raw PCM Buffer with format metadata:
```javascript
{
  payload: <Buffer>, // Raw audio data
  format: {
    sampleRate: 48000,
    channels: 2,
    encoding: "L24",
    bytesPerSample: 3
  },
  rtp: {
    timestamp: 123456,
    sequenceNumber: 4567,
    ssrc: 0x12345678
  }
}
```

## Advanced Usage

### Dynamic Stream Subscription

You can dynamically subscribe the receiver to different streams:

```javascript
msg.topic = "subscribe";
msg.payload = {
  multicastGroup: "239.69.1.1",
  sampleRate: 48000,
  channels: 2,
  encoding: "L24"
};
return msg;
```

### Getting Status Information

Request status from any node:

```javascript
msg.topic = "control";
msg.payload = { command: "status" };
return msg;
```

### Integrating Router with Receiver

Connect the AES67 Router to automatically configure receivers:

```
[AES67 Router] --> [Function] --> [AES67 Receiver]
```

Function node to auto-subscribe:
```javascript
if (msg.topic === "stream/discovered") {
  return {
    topic: "subscribe",
    payload: {
      multicastGroup: msg.payload.destIP,
      sampleRate: msg.payload.sampleRate,
      channels: msg.payload.channels,
      encoding: msg.payload.encoding
    }
  };
}
```

## Technical Specifications

### Standards Compliance
- **AES67**: Audio Engineering Society standard for high-performance streaming audio-over-IP
- **SMPTE ST 2110-30**: Professional Media Over Managed IP Networks - Audio
- **RFC 3550**: RTP: A Transport Protocol for Real-Time Applications
- **RFC 2974**: Session Announcement Protocol (SAP)
- **RFC 4566**: Session Description Protocol (SDP)
- **IEEE 1588-2008**: Precision Time Protocol (PTP) - reference only

### Supported Configurations
- **Sample Rates**: 44.1kHz, 48kHz, 88.2kHz, 96kHz (and others)
- **Channels**: 1-64 channels
- **Encodings**: L24 (24-bit PCM), L16 (16-bit PCM)
- **Packet Time**: 1-20ms (1ms recommended for AES67)
- **Transport**: RTP/AVP over UDP
- **Multicast**: Full support for IPv4 multicast (239.x.x.x)

### Network Requirements
- **Bandwidth**: ~1.2 Mbps per stereo 48kHz L24 stream
- **Latency**: Low latency (~1ms packet time)
- **Multicast**: Network must support IGMP for multicast
- **Ports**: 
  - RTP: Typically 5004+ (even numbers)
  - SAP: 9875 (fixed)

## Audio Device Integration

These nodes handle AES67 protocol implementation but **do not include audio device drivers**. For complete audio I/O solutions:

### Capturing Audio (for Sender)
To capture audio from local devices, you can:
1. Use external audio capture tools and pipe data to Node-RED
2. Use Node.js audio libraries in Function nodes (with security considerations)
3. Generate test patterns programmatically
4. Integrate with other Node-RED audio nodes

### Playing Audio (from Receiver)
To play received audio on speakers, you can:
1. Write audio buffers to files for playback
2. Stream to external audio applications
3. Use Node.js audio libraries in Function nodes (with security considerations)
4. Integrate with other Node-RED audio nodes

### Security Note
Popular Node.js audio libraries like `speaker` and `mic` have known vulnerabilities:
- **speaker** (≤ 0.5.5): Vulnerable to Denial of Service (no patch available)
- Consider using alternative audio solutions or containerized environments
- See [GitHub Advisory Database](https://github.com/advisories) for current status

## Troubleshooting

### No Streams Discovered
- Verify network supports multicast (IGMP enabled)
- Check firewall allows UDP port 9875 (SAP)
- Ensure AES67 devices are on same network segment
- Verify devices are in AES67 mode (not proprietary mode)

### No Audio Received
- Verify multicast group matches sender
- Check firewall allows UDP RTP port
- Ensure sample rate, channels, and encoding match sender
- Monitor packet loss statistics
- Verify network supports required bandwidth

### Audio Dropouts
- Check packet loss statistics (should be < 0.1%)
- Verify network bandwidth is sufficient
- Consider increasing buffer size
- Check for network congestion
- Verify NIC supports multicast properly

### High Packet Loss
- Check network cables and switches
- Verify Quality of Service (QoS) settings
- Reduce other network traffic
- Use dedicated audio VLAN
- Check for duplex mismatches

## API Reference

### AES67 Router Node

**Input Commands:**
- `discover` - Start/restart stream discovery
- `list_streams` - Get all discovered streams
- `subscribe` - Subscribe to a stream
- `unsubscribe` - Unsubscribe from a stream
- `status` - Get node status

**Outputs:**
1. Discovery events (stream discovered/removed)
2. Audio data from subscribed streams
3. Status and command responses

### AES67 Sender Node

**Input:**
- Audio data as Buffer in `msg.payload`
- Control commands via `msg.topic = "control"`

**Configuration:**
- `streamName`: Stream identifier
- `sampleRate`: Audio sample rate in Hz
- `channels`: Number of audio channels
- `encoding`: PCM encoding (L24/L16)
- `ptime`: Packet time in milliseconds
- `destIP`: Destination multicast IP
- `destPort`: Destination UDP port
- `ptpDomain`: PTP domain number
- `enableSAP`: Enable SAP announcements

### AES67 Receiver Node

**Input:**
- Control commands via `msg.topic = "control"`
- Dynamic subscription via `msg.topic = "subscribe"`

**Output:**
- Audio data as Buffer in `msg.payload`
- Format metadata in `msg.format`
- RTP information in `msg.rtp`

**Configuration:**
- `multicastGroup`: Multicast IP to join
- `localPort`: Local UDP port (0 = auto)
- `sampleRate`: Expected sample rate
- `channels`: Expected channel count
- `encoding`: Expected encoding
- `outputMode`: buffer or stream

## Contributing

Contributions are welcome! Please see the repository for guidelines.

## License

MIT License - see LICENSE file for details

## Author

DHPKE

## Links

- [GitHub Repository](https://github.com/DHPKE/node-red-contrib-aes67-router)
- [AES67 Standard](http://www.aes.org/publications/standards/search.cfm?docID=96)
- [SMPTE ST 2110](https://www.smpte.org/standards/document-index/st-2110)
- [Node-RED](https://nodered.org/)

## Version History

### 1.0.0
- Initial release
- AES67 Router node for stream discovery
- AES67 Sender node for audio transmission
- AES67 Receiver node for audio reception
- Full SAP/SDP support
- RTP packet handling
- Multi-channel support
- Multiple sample rates
- PTP clock reference awareness
