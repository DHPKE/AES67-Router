# node-red-contrib-aes67-router

AES67 audio streaming for Node-RED with three dedicated nodes: Router (discovery), Sender (transmit), and Receiver (receive).

## Features

- **AES67 Router** - Automatic discovery of AES67 streams using SAP/SDP protocols
- **AES67 Sender** - Transmit audio streams with RTP and SAP announcements
- **AES67 Receiver** - Receive RTP audio streams with buffer overflow protection
- **Standard Compliant** - Implements AES67, SAP, SDP, and RTP standards
- **Multicast Support** - Supports both unicast and multicast streams
- **Production Ready** - Comprehensive error handling prevents Node-RED crashes

## Nodes

### AES67 Router
Discovers AES67 audio streams on the network using SAP/SDP and enables subscribing to streams.

### AES67 Sender
Transmits AES67 audio streams via RTP with automatic SAP announcements for stream discovery.

### AES67 Receiver
Receives AES67 audio streams via RTP with safe packet parsing and buffer overflow protection.

## Installation

```bash
cd ~/.node-red
npm install node-red-contrib-aes67-router
```

Or install directly from the Node-RED palette manager.

## Usage

This package provides three nodes for working with AES67 audio streams:

### AES67 Router Node

The router node discovers AES67 streams on your network and manages subscriptions.

#### Basic Setup

1. Add the **AES67 Router** node to your flow
2. Enable "Auto Discover" in the node configuration (enabled by default)
3. The node will automatically start discovering AES67 streams on your network
4. Connect the outputs to debug nodes to see discovered streams and audio data

#### Input Commands

Send messages to the router node with the following topics:

- **`discover`** or **`start`** - Start stream discovery
- **`list_streams`** - Get all discovered streams (output on port 3)
- **`list_devices`** - Get all discovered devices (output on port 3)
- **`subscribe`** - Subscribe to a stream
  - Payload: `{streamKey: "192.168.1.100:5004", localPort: 5004}` (localPort is optional)
- **`unsubscribe`** - Unsubscribe from a stream
  - Payload: `{subscriptionId: "192.168.1.100:5004_5004"}`
- **`list_subscriptions`** - Get all active subscriptions (output on port 3)
- **`status`** - Get node status (output on port 3)

#### Outputs

The router node has 3 outputs:

1. **Discovery Events** - Stream discovered/removed events
2. **Audio Data** - RTP audio packets from subscribed streams
3. **Status** - Status information and command responses

### AES67 Sender Node

The sender node transmits audio streams via RTP with automatic SAP announcements.

#### Configuration

- **Stream Name** - Name announced via SAP/SDP
- **Destination IP** - Multicast or unicast IP address (e.g., 239.69.1.1)
- **Destination Port** - UDP port for RTP stream (typically 5004+)
- **Sample Rate** - Audio sample rate: 48000, 96000, or 44100 Hz
- **Channels** - Number of audio channels (1, 2, 4, or 8)
- **Encoding** - Audio format: L24 (24-bit PCM) or L16 (16-bit PCM)
- **Packet Time** - Packet duration in milliseconds (typically 1ms)

#### Usage

Send audio data as a Buffer in `msg.payload`:

```javascript
msg.payload = audioBuffer;  // Buffer containing audio samples
return msg;
```

The node automatically handles RTP packet construction, sequence numbering, and timestamps.

### AES67 Receiver Node

The receiver node listens for and receives RTP audio streams.

#### Configuration

- **Listen Port** - UDP port to listen on (typically 5004+)
- **Multicast IP** - Optional multicast group to join (leave empty for unicast)

#### Output

Each received RTP packet produces an output message with:

```javascript
{
  topic: "audio/data",
  payload: audioBuffer,      // Audio data as Buffer
  rtp: {                     // RTP header information
    sequenceNumber: 12345,
    timestamp: 67890,
    ssrc: 0x12345678,
    // ... other RTP header fields
  },
  source: {
    address: "192.168.1.100",
    port: 5004
  }
}
```
3. **Status** - Status information and command responses

### Example Flow

```json
[
    {
        "id": "aes67-router",
        "type": "aes67-router",
        "name": "AES67 Router",
        "autoDiscover": true,
        "x": 300,
        "y": 200,
        "wires": [
            ["debug-discovery"],
            ["debug-audio"],
            ["debug-status"]
        ]
    },
    {
        "id": "debug-discovery",
        "type": "debug",
        "name": "Discovery Events"
    },
    {
        "id": "debug-audio",
        "type": "debug",
        "name": "Audio Data"
    },
    {
        "id": "debug-status",
        "type": "debug",
        "name": "Status"
    }
]
```

## Stream Format

Discovered streams include:

- Stream name and description
- Source and destination IP addresses
- Number of audio channels
- Sample rate and encoding (L24, L16, etc.)
- Packet time (ptime)
- Media clock reference (PTP)

Example stream object:
```json
{
    "id": "12345678",
    "name": "AES67 Stream",
    "sourceIP": "192.168.1.100",
    "destIP": "239.69.1.1",
    "port": 5004,
    "channels": 2,
    "sampleRate": 48000,
    "encoding": "L24",
    "ptime": 1,
    "isMulticast": true,
    "status": "active"
}
```

## AES67 Standards

This node implements:

- **SAP (RFC 2974)** - Session Announcement Protocol for stream announcement
- **SDP (RFC 4566)** - Session Description Protocol for stream description
- **RTP (RFC 3550)** - Real-time Transport Protocol for audio transport
- **IEEE 1588-2008 PTP** - Precision Time Protocol for synchronization reference

## Troubleshooting

### No streams are being discovered

1. **Check network connectivity** - Ensure your Node-RED instance can receive multicast traffic on port 9875
2. **Firewall rules** - Allow UDP traffic on port 9875 and RTP ports (typically 5004+)
3. **Multicast routing** - Verify multicast is enabled on your network interfaces
4. **AES67 devices** - Ensure your AES67 devices are configured to send SAP announcements

### Node-RED shows "Lost connection to server"

This should no longer occur with version 1.0.0+. If you still experience this:

1. **Update the module** - Run `npm update node-red-contrib-aes67-router`
2. **Check logs** - Look for error messages in the Node-RED logs
3. **Restart Node-RED** - Sometimes a clean restart helps

### sdp-transform dependency not found

The `sdp-transform` module is now optional. The node will operate in limited mode without it:

1. **Install dependency** - Run `npm install sdp-transform` in your Node-RED directory
2. **Restart Node-RED** - The node will detect and use the module

### Audio data is not received

1. **Verify subscription** - Send a `list_subscriptions` command to verify the subscription is active
2. **Check port binding** - Ensure the RTP port is not in use by another application
3. **Multicast membership** - Verify your system can join multicast groups
4. **Stream is active** - Check that the source device is actually streaming

### High CPU usage

1. **Limit subscriptions** - Only subscribe to streams you need
2. **Check packet rate** - High sample rates and short ptime values generate more packets
3. **Disable auto-discover** - If not needed, disable auto-discovery in the node config

### Memory leaks

The node has been designed to prevent memory leaks:

- Streams are automatically cleaned up after 2 minutes of inactivity
- Sockets are properly closed when subscriptions are removed
- All intervals and timers are cleared on node close

If you still experience memory issues, please file a bug report.

## Network Configuration

### Multicast Addresses

The node listens on the following multicast addresses:

- **239.255.255.255** - Primary SAP multicast address
- **239.192.0.0** - Alternative SAP multicast address

### Port Configuration

- **SAP Port**: 9875 (UDP)
- **RTP Ports**: Configurable per stream (typically 5004+)

### Firewall Rules

Allow inbound UDP traffic on:
- Port 9875 (SAP)
- Ports 5004-5100 (RTP, adjust based on your streams)

Example iptables rules:
```bash
# Allow SAP
iptables -A INPUT -p udp --dport 9875 -j ACCEPT

# Allow RTP
iptables -A INPUT -p udp --dport 5004:5100 -j ACCEPT

# Allow multicast
iptables -A INPUT -m pkttype --pkt-type multicast -j ACCEPT
```

## Performance Considerations

- Each subscription creates a UDP socket
- High channel counts and sample rates increase CPU usage
- Consider using a dedicated network interface for audio traffic
- Monitor Node-RED memory usage with active subscriptions

## Security Considerations

- The node binds to `0.0.0.0` by default (all interfaces)
- Consider using firewall rules to restrict access
- Validate stream sources before subscribing
- Be aware that RTP audio is unencrypted

## Compatibility

- **Node.js**: >=14.0.0
- **Node-RED**: >=2.0.0
- **AES67 Devices**: Any compliant device (Dante, Ravenna, Livewire+, Q-LAN, etc.)

## License

MIT

## Support

For issues and feature requests, please visit:
https://github.com/DHPKE/AES67-Router/issues

## Changelog

### 1.0.0 (2025-11-11)

- Initial production release
- Comprehensive error handling to prevent Node-RED crashes
- Optional sdp-transform dependency with graceful fallback
- Robust socket management with proper cleanup
- Safe RTP packet parsing with bounds checking
- Input validation throughout
- Improved status reporting
- Added troubleshooting documentation

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
