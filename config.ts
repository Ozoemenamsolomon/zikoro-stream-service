
import type {
  TransportProtocol
  
} from "mediasoup/node/lib/types";
export const config = {
    mediasoup: {
      // Number of mediasoup workers
      numWorkers: 2,
  
      // mediasoup Worker settings
      workerSettings: {
        dtlsCertificateFile : process.env.SSL_CERT,
			dtlsPrivateKeyFile  : process.env.SSL_KEY,
        logLevel: "warn",
        logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
         rtcMinPort: 42000,
         rtcMaxPort: 42030,
      },
  
      // mediasoup Router options
      routerOptions: {
        mediaCodecs: [
          {
            kind: "audio",
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
            rtcpFeedback: [
            
              { type: "nack" },
              { type: "nack", parameter: "pli" },
            ],
          },
          {
            kind: "video",
            mimeType: "video/VP8",
            clockRate: 90000,
            parameters: {
              "x-google-start-bitrate": 1000,
            },
           
          },
          {
            kind: "video",
            mimeType: "video/VP9",
            clockRate: 90000,
            parameters: {
              "profile-id": 2,
              "x-google-start-bitrate": 1000,
            },
          },
          {
            kind: "video",
            mimeType: "video/h264",
            clockRate: 90000,
            parameters: {
              "packetization-mode": 1,
              "profile-level-id": "4d0032",
              "level-asymmetry-allowed": 1,
              "x-google-start-bitrate": 1000,
            },
          },
          {
            kind: "video",
            mimeType: "video/h264",
            clockRate: 90000,
            parameters: {
              "packetization-mode": 1,
              "profile-level-id": "42e01f",
              "level-asymmetry-allowed": 1,
              "x-google-start-bitrate": 1000,
            },
          },
        ],
      },
   
  
      // WebRtcTransport options
      webRtcTransportOptions: {
       
        listenInfos :
			[
				{
					protocol         : 'udp' as TransportProtocol,
					ip               : process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
					announcedAddress : process.env.MEDIASOUP_ANNOUNCED_IP || '192.168.115.187',
					portRange        :
					{
						min :  42000,
						max :  42030,
					}
				},
				{
					protocol         : 'tcp' as TransportProtocol,
					ip               : process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
					announcedAddress : process.env.MEDIASOUP_ANNOUNCED_IP || '192.168.115.187',
					portRange        :
					{
						min :  42000,
						max :  42030,
					}
				}
			],
        initialAvailableOutgoingBitrate: 1000000,
        minimumAvailableOutgoingBitrate: 600000,
        maxSctpMessageSize: 262144,
        maxIncomingBitrate: 1500000,
      },
    },
  }
  