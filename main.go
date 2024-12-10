package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/go-audio/wav"
	"github.com/gorilla/handlers"
	"github.com/pion/ice/v2"
	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"
)

const (
	audioFileName = "audio.wav"
	videoFileName = "video.h265"
	secretKey     = "mingVison"
)

func main() {
	settingEngine := webrtc.SettingEngine{}
	var muxes []ice.UDPMux
	for i := 0; i < 2; i++ {
		mux, err := ice.NewMultiUDPMuxFromPort(8443 - i)
		if err != nil {
			panic(err)
		}
		muxes = append(muxes, mux)
	}
	// Listen on UDP Port 8000, will be used for all WebRTC traffic
	mux := ice.NewMultiUDPMuxDefault(muxes...)
	settingEngine.SetICEUDPMux(mux)
	fmt.Printf("Listening for WebRTC traffic at %d\n", 8443)
	//register codec
	m := &webrtc.MediaEngine{}

	// Setup the codecs you want to use.
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000, Channels: 0, SDPFmtpLine: "", RTCPFeedback: nil},
		PayloadType:        102,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		panic(err)
	}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypePCMA, ClockRate: 8000, Channels: 1, SDPFmtpLine: "", RTCPFeedback: nil},
		PayloadType:        8,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		panic(err)
	}
	// register codec done
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine), webrtc.WithMediaEngine(m))

	// Setup HTTP routes for signaling and static file serving
	http.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) {
		handleOffer(api, w, r)
	})

	// Serve static files from the current directory (including HTML, JS, etc.)
	fs := http.FileServer(http.Dir("."))

	// Enable CORS for the static file server
	cors := handlers.CORS(
		handlers.AllowedOrigins([]string{"*"}), // Allow all origins
		handlers.AllowedMethods([]string{"GET", "POST", "OPTIONS"}),
		handlers.AllowedHeaders([]string{"Content-Type", "Authorization"}),
	)

	// Wrap the static file handler with CORS
	http.Handle("/", cors(fs))

	// Start the HTTP server on port 7009
	fmt.Println("HTTP server running on :7009")
	log.Fatal(http.ListenAndServe(":7009", nil))
}

func handleOffer(api *webrtc.API, w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+secretKey {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var offer webrtc.SessionDescription
	if err := json.NewDecoder(r.Body).Decode(&offer); err != nil {
		http.Error(w, fmt.Sprintf("Invalid offer: %v", err), http.StatusBadRequest)
		return
	}

	// Create PeerConnection
	peerConnection, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create PeerConnection: %v", err), http.StatusInternalServerError)
		return
	}
	timer := time.AfterFunc(30*time.Second, func() {
		fmt.Println("Timeout reached, closing PeerConnection")
		peerConnection.Close()
	})
	// Add audio track
	audioTrack, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypePCMA}, "audio", "webrtc")
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create audio track: %v", err), http.StatusInternalServerError)
		return
	}
	_, err = peerConnection.AddTrack(audioTrack)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to add audio track: %v", err), http.StatusInternalServerError)
		return
	}

	// Add video track
	videoTrack, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "webrtc")
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create video track: %v", err), http.StatusInternalServerError)
		return
	}
	_, err = peerConnection.AddTrack(videoTrack)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to add video track: %v", err), http.StatusInternalServerError)
		return
	}
	peerConnection.CreateDataChannel("data", nil)
	// ICE connection state callback
	peerConnection.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		fmt.Printf("ICE connection state: %s\n", state.String())
	})
	peerConnection.OnSignalingStateChange(func(state webrtc.SignalingState) {
		fmt.Printf("Signaling state: %s\n", state.String())
	})
	peerConnection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		fmt.Printf("Connection state: %s\n", state.String())
		if state == webrtc.PeerConnectionStateClosed {
			timer.Stop()
		}
	})
	// Set the remote description
	if err := peerConnection.SetRemoteDescription(offer); err != nil {
		http.Error(w, fmt.Sprintf("Failed to set remote description: %v", err), http.StatusInternalServerError)
		return
	}
	gatherComplete := webrtc.GatheringCompletePromise(peerConnection)
	// Create an answer
	answer, err := peerConnection.CreateAnswer(nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create answer: %v", err), http.StatusInternalServerError)
		return
	}

	// Set local description
	if err := peerConnection.SetLocalDescription(answer); err != nil {
		http.Error(w, fmt.Sprintf("Failed to set local description: %v", err), http.StatusInternalServerError)
		return
	}
	<-gatherComplete
	// Return the answer
	if err := json.NewEncoder(w).Encode(peerConnection.LocalDescription()); err != nil {
		http.Error(w, fmt.Sprintf("Failed to encode answer: %v", err), http.StatusInternalServerError)
		return
	}

	// Start streaming in separate goroutines
	go readAndStreamAudio(audioFileName, audioTrack)
	go readAndStreamVideo(videoFileName, videoTrack)
}

func readAndStreamAudio(fileName string, audioTrack *webrtc.TrackLocalStaticSample) {
	file, err := os.Open(fileName)
	if err != nil {
		log.Printf("failed to open WAV file: %v", err)
		return
	}
	defer file.Close()

	decoder := wav.NewDecoder(file)
	if !decoder.IsValidFile() {
		panic("invalid WAV file")
	}

	// Ensure the WAV file is already in PCMA format (8-bit A-law encoding)
	// A WAV file header for PCMA encoded audio should be checked
	if decoder.Format().SampleRate != 8000 || decoder.Format().NumChannels != 1 {
		panic("WAV file is not in PCMA (A-law) format")
	}

	// Buffer to read the audio data from the file
	buffer := make([]byte, 160) // Buffer for 20ms of PCMA (A-law) data at 8kHz sampling rate (8 bits per sample)
	for {
		// Read a chunk of PCMA samples (already in 8-bit A-law format)
		n, err := file.Read(buffer)
		if err != nil && err != io.EOF {
			panic(fmt.Errorf("failed to read WAV file: %w", err))
		}

		// If EOF is reached, stop streaming
		if n == 0 {
			return
		}

		// Send the PCMA data to the WebRTC track
		err = audioTrack.WriteSample(media.Sample{Data: buffer[:n], Duration: time.Millisecond * 20})
		if err != nil {
			panic(fmt.Errorf("failed to send PCMA data to track: %w", err))
		}
	}
}

func readAndStreamVideo(fileName string, videoTrack *webrtc.TrackLocalStaticSample) {
	file, err := os.Open(fileName)
	if err != nil {
		log.Printf("failed to open H.265 file: %v", err)
		return
	}
	defer file.Close()

	for {
		frame, err := extractH265Frame(file)
		if err != nil {
			if err == io.EOF {
				return
			}
			panic(err)
		}

		err = videoTrack.WriteSample(media.Sample{Data: frame, Duration: time.Second / 30})
		if err != nil {
			panic(err)
		}
	}
}

func extractH265Frame(file *os.File) ([]byte, error) {
	var frame []byte
	startCodeShort := []byte{0x00, 0x00, 0x01}
	startCodeLong := []byte{0x00, 0x00, 0x00, 0x01}
	buf := make([]byte, 4)

	for {
		_, err := file.Read(buf)
		if err != nil {
			if err == io.EOF && len(frame) > 0 {
				// Return the last frame
				return frame, nil
			}
			return nil, err
		}

		if bytes.Equal(buf, startCodeShort) || bytes.Equal(buf, startCodeLong) {
			if len(frame) > 0 {
				// Seek back to the start of the new frame
				_, seekErr := file.Seek(int64(-len(buf)), io.SeekCurrent)
				if seekErr != nil {
					return nil, seekErr
				}
				return frame, nil
			}
		}

		// Append current buffer to the frame
		frame = append(frame, buf...)
	}
}
