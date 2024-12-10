import { parseCodecInst } from "./video_codec.js";
import { frameData, vps, pps, sps } from "./frame_data.js";

const wsUrl = "wss://dev-ws.agi7.ai/agi7/api/user/ws"
const secretKey = "mingVison"


function testWebSocketConnection() {
    const socket = new WebSocket(wsUrl);

    // Connection opened
    socket.onopen = () => {
        console.log("WebSocket connection opened.");
        showToast("WebSocket connection opened.");
    };

    // Listen for messages
    socket.onmessage = (event) => {
        console.log("Message from server:", event.data);
    };

    // Handle errors
    socket.onerror = (error) => {
        showToast(`WebSocket error: ${error}`);
    };

    // Connection closed
    socket.onclose = (event) => {
        console.log(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
    };
}
const wsButton = document.getElementById("wsButton") as HTMLButtonElement;
wsButton.addEventListener("click", testWebSocketConnection);

function isInsertableStreamsSupported(videoStreams: any, audioStreams: any): boolean {
    // Check if RTCRtpSender and RTCRtpReceiver have the createEncodedStreams method
    const supportsInsertableStreams = 'createEncodedStreams' in RTCRtpReceiver.prototype && videoStreams && audioStreams

    // Optionally, you can also check browser and version here
    const userAgent = navigator.userAgent.toLowerCase();
    const isChrome = /chrome|crios|crmo/.test(userAgent);
    const chromeMatch = userAgent.match(/chrome\/(\d+)/);
    const chromeVersion = isChrome && chromeMatch ? parseInt(chromeMatch[1], 10) : null;

    // Insertable streams are supported in Chrome 89 and later
    return supportsInsertableStreams && isChrome && chromeVersion !== null && chromeVersion >= 89;
}
let gotCandidate = false, connectionEstablished = false

async function startWebRTC(): Promise<void> {
    try {
        const peerConnection = new RTCPeerConnection();

        // Create encoded streams upfront
        const videoTransceiver = peerConnection.addTransceiver("video", { direction: "recvonly" });
        const audioTransceiver = peerConnection.addTransceiver("audio", { direction: "recvonly" });

        const videoStreams = (videoTransceiver.receiver as any).createEncodedStreams();
        const audioStreams = (audioTransceiver.receiver as any).createEncodedStreams();

        let datachannel = peerConnection.createDataChannel("datachannel");
        datachannel.onopen = () => {
            connectionEstablished = true
            showToast("connected", 3000)
        }
        // Use the function to check for support before creating encoded streams
        if (isInsertableStreamsSupported(videoStreams, audioStreams)) {
            showToast("Your browser supports insertable streams.");
        } else {
            showToast("Your browser does not support insertable streams.");
        }

        // Set up event listener to attach remote streams
        peerConnection.ontrack = (event: RTCTrackEvent) => {
            if (event.track.kind === "video" && event.streams[0]) {
                console.log("Received video track:", event.track);
                // Assuming you have fetched the binary data of test.mp4
            } else if (event.track.kind === "audio" && event.streams[0]) {
                console.log("Received audio track:", event.track);
            }
        }
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                gotCandidate = true
                console.log(`STUN server reachable, candidate: ${event.candidate.candidate}`);
            } else {
                console.log('No more ICE candidates.');
            }
        }

        setTimeout(() => {
            if (!gotCandidate) {
                showToast("STUN server unreachable.");
            }
        }, 5000);

        setTimeout(() => {
            if (!connectionEstablished) {
                showToast("Failed to establish WebRTC connection.");
            }
        }, 15000);

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        const offerResponse = await fetch("/offer", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${secretKey}`,
            },
            body: JSON.stringify(peerConnection.localDescription),
        });
        const answer = await offerResponse.json();
        await peerConnection.setRemoteDescription(answer);
    } catch (error) {
        showToast(`Failed to start WebRTC: ${error}`);
    }
}

const button = document.getElementById("startButton") as HTMLButtonElement;
button.addEventListener("click", startWebRTC);
const videoButton = document.getElementById("videoButton") as HTMLButtonElement;
videoButton.addEventListener("click", () => {
    decodeH265Video()
    videoButton.disabled = true
});

async function decodeH265Video() {
    const videoElement = document.getElementById("video") as HTMLVideoElement;

    // Split the file into NAL units
    const nalUnits: Uint8Array[] = [];

    const videoDecoder = new VideoDecoder({
        output: (frame) => {
            const canvas = document.createElement('canvas'); // Create a new canvas
            const ctx = canvas.getContext('2d');             // Get the 2D rendering context
            if (ctx) {
                // Set the canvas dimensions to match the video frame
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;

                // Draw the frame onto the canvas
                ctx.drawImage(frame, 0, 0);

                // Append the canvas to your video element or container
                videoElement.parentNode.insertBefore(canvas, videoElement.nextSibling);

                // Optionally, add a class or style to the canvas for customization
                canvas.style.border = "1px solid black";
                showToast("Video frame decoded successfully.", 3000);
            }
            frame.close(); // Release the video frame
        },
        error: (err) => console.error("VideoDecoder error:", err),
    });

    let timestamp = 0; // Initialize the timestamp
    let gotKey = false
    if (sps && pps && vps) {
        let result = await parseCodecInst.parseCodec(sps, pps, vps)
        if (result.error) {
            console.error("Failed to parse codec:", result.error);
        }
        if (result.data) {
            videoDecoder.configure(result.data);
        } else {
            console.error("Failed to configure video decoder: result.data is undefined");
        }
    }
    try {
        const chunk = new EncodedVideoChunk({
            type: 'key',
            timestamp: timestamp,
            data: frameData,
            duration: 0,
        });
        videoDecoder.decode(chunk);
    } catch (error) {
        console.error("Failed to decode video chunk:", error);
    }
}


async function decodePCMAudio(file: File) {
    const audioElement = document.getElementById("audio") as HTMLAudioElement;
    const arrayBuffer = await file.arrayBuffer();
    const dataView = new DataView(arrayBuffer);

    // Parse WAV header
    const audioFormat = dataView.getUint16(20, true); // Should be 6 (PCMA)
    const numChannels = dataView.getUint16(22, true);
    const sampleRate = dataView.getUint32(24, true);
    const byteRate = dataView.getUint32(28, true);
    const blockAlign = dataView.getUint16(32, true);
    const bitsPerSample = dataView.getUint16(34, true);

    if (audioFormat !== 6) {
        throw new Error("Unsupported audio format. Only PCMA is supported.");
    }

    // Extract PCM data
    const dataOffset = 44; // Typically starts after the header
    const rawPCMA = new Uint8Array(arrayBuffer.slice(dataOffset));

    // Decode PCMA to PCM
    const pcmData = new Float32Array(rawPCMA.length);
    for (let i = 0; i < rawPCMA.length; i++) {
        pcmData[i] = (rawPCMA[i] - 128) / 128; // Convert to [-1, 1] range
    }

    // Play PCM data using Web Audio API
    const audioContext = new AudioContext();
    const buffer = audioContext.createBuffer(numChannels, pcmData.length, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
        buffer.copyToChannel(pcmData, channel);
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    source.start();

    // Optionally link audio stream to the HTML audio element
    const mediaStreamDestination = audioContext.createMediaStreamDestination();
    source.connect(mediaStreamDestination);
    audioElement.srcObject = mediaStreamDestination.stream;
}

function showToast(message: string, duration: number = 3000): void {
    // Get the toast container
    const container = document.getElementById("toast-container");

    if (!container) {
        console.error("Toast container not found.");
        return;
    }

    // Create a new toast element
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;

    // Add the toast to the container
    container.appendChild(toast);

    // Show the toast
    requestAnimationFrame(() => {
        toast.classList.add("show");
    });

    // Remove the toast after the duration
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => container.removeChild(toast), 500); // Allow animation to finish
    }, duration);
}