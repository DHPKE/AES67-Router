# AES67 Example Flows

This directory contains example Node-RED flows demonstrating the AES67 nodes.

## aes67-example-flow.json

A comprehensive example flow that demonstrates:

1. **Stream Discovery**
   - Uses the AES67 Router node to discover streams via SAP/SDP
   - Displays discovered streams in the debug panel

2. **Audio Reception**
   - Configures an AES67 Receiver to listen on multicast group 239.69.1.1:5004
   - Outputs received audio data with format metadata

3. **Audio Transmission**
   - Generates a 440Hz sine wave test tone
   - Sends it via AES67 Sender to multicast group 239.69.1.2:5004
   - Announces the stream via SAP/SDP

4. **Status Monitoring**
   - Shows how to request status information from nodes
   - Demonstrates control message handling

## How to Import

1. Open Node-RED
2. Click the menu (≡) in the top-right
3. Select "Import"
4. Click "select a file to import"
5. Choose `aes67-example-flow.json`
6. Click "Import"

## Using the Example Flow

### Stream Discovery
1. Deploy the flow
2. The AES67 Router node will automatically start discovering streams
3. Watch the "Discovered Streams" debug node for any AES67 streams on your network

### Testing Audio Transmission
1. Click the "Send Test Audio (every 1ms)" inject node
2. This will start generating and sending a 440Hz test tone
3. The stream will be announced via SAP and visible to other AES67 devices
4. On the sender's network, you should see the stream appear in the discovery

### Testing Audio Reception
1. Configure the receiver's multicast group to match a discovered stream
2. Deploy the flow
3. Enable the "Received Audio" debug node
4. You'll see raw PCM audio buffers being received

### Checking Status
1. Click the "Request Status" inject node
2. This sends a control message to the receiver
3. The receiver will output its current status including:
   - Running state
   - Local port
   - Sample rate and channels
   - Packet statistics

## Modifying the Flow

### Change Audio Format
Edit the sender configuration to change:
- Sample rate (48000, 96000, etc.)
- Channels (1 for mono, 2 for stereo, etc.)
- Encoding (L24 or L16)

Update the test pattern function to match:
```javascript
const sampleRate = 96000;  // Match sender
const channels = 2;        // Match sender
const bytesPerSample = 3;  // 3 for L24, 2 for L16
```

### Change Multicast Addresses
- Use different multicast addresses in the 239.x.x.x range
- Ensure sender and receiver use the same address to communicate
- Make sure your network supports multicast routing

### Add Audio Processing
Insert processing nodes between receiver and output:
```
[Receiver] -> [Function/Processing] -> [Output]
```

### Connect to Real Audio Devices
Replace the test pattern with actual audio capture:
```
[Audio Capture] -> [Buffer Conversion] -> [Sender]
```

Replace debug output with audio playback:
```
[Receiver] -> [Buffer Processing] -> [Audio Output]
```

## Network Requirements

For the example to work properly:

1. **Multicast Support**: Your network must support IGMP multicast
2. **Firewall**: Allow UDP ports:
   - 9875 (SAP)
   - 5004+ (RTP)
3. **Same Network Segment**: Sender and receiver should be on the same subnet
4. **Bandwidth**: Ensure sufficient bandwidth (stereo 48kHz L24 ≈ 2.3 Mbps)

## Troubleshooting

**No streams discovered:**
- Check that AES67 devices are on the same network
- Verify multicast is enabled on your network
- Check firewall settings for UDP port 9875

**No audio received:**
- Verify multicast group matches sender
- Check firewall allows RTP port (typically 5004)
- Ensure receiver format matches sender (sample rate, channels, encoding)

**High packet loss:**
- Check network bandwidth
- Reduce other network traffic
- Consider using a dedicated audio VLAN
- Check network cable quality

## Advanced Examples

### Automatic Stream Subscription

Connect router output to receiver input for automatic subscription:

```javascript
// Function node between router and receiver
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

### Multi-Channel Audio

Generate and send 8-channel audio:
1. Set sender channels to 8
2. Update test pattern to generate 8 channels:
```javascript
const channels = 8;
for (let ch = 0; ch < channels; ch++) {
  // Write sample for each channel
}
```

### Stream Recording

Save received audio to buffer for processing:
```javascript
// Function node to accumulate audio
context.audioBuffer = context.audioBuffer || [];
context.audioBuffer.push(msg.payload);

// Output when we have enough data
if (context.audioBuffer.length >= 100) {
  const combined = Buffer.concat(context.audioBuffer);
  context.audioBuffer = [];
  return { payload: combined };
}
```
