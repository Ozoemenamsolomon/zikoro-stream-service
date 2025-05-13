import { App, DEDICATED_COMPRESSOR_3KB, type WebSocket } from "uWebSockets.js";
import * as mediasoup from "mediasoup";
import type {
  Worker,
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  Transport,
} from "mediasoup/node/lib/types";
import { config } from "./config";
import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

const supabase = createClient(supabaseUrl, supabaseKey);

interface SocketData {
  peerId: string;
  roomId: string;
}

interface Room {
  id: string;
  router: Router;
  peers: Map<string, Peer>;
  messages: Message[];
}

interface Peer {
  id: string;
  name: string;
  socket: WebSocket<SocketData>;
  transports: Map<string, Transport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  isHost: boolean;
  isInvitee: boolean;
  status: {
    audioMuted: boolean;
    videoMuted: boolean;
    speaking: boolean;
  };
}

interface Message {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
}

// Global variables
const workers: Worker[] = [];
const rooms = new Map<string, Room>();
const serverEvents = new EventEmitter();

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

// Mediasoup setup
async function createWorkers() {
  const { numWorkers, workerSettings } = config.mediasoup;

  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: workerSettings.logLevel as any,
      logTags: workerSettings.logTags as any,
      rtcMinPort: workerSettings.rtcMinPort,
      rtcMaxPort: workerSettings.rtcMaxPort,
    });

    worker.on("died", () => {
      console.error(`Worker ${worker.pid} died, exiting in 2 seconds...`);
      setTimeout(() => process.exit(1), 2000);
    });

    workers.push(worker);
    console.log(`Created mediasoup Worker with pid ${worker.pid}`);
  }
}

function getMediasoupWorker() {
  return workers[Math.floor(Math.random() * workers.length)];
}

async function createRouter() {
  const worker = getMediasoupWorker();
  const { mediaCodecs } = config.mediasoup.routerOptions;
  // @ts-ignore
  return await worker.createRouter({ mediaCodecs });
}

async function getOrCreateRoom(roomId: string): Promise<Room> {
  let room = rooms.get(roomId);

  if (!room) {
    const router = await createRouter();
    room = {
      id: roomId,
      router,
      peers: new Map(),
      messages: [],
    };
    rooms.set(roomId, room);

    serverEvents.on(`room-empty:${roomId}`, () => {
      if (room && room.peers.size === 0) {
        room.router.close();
        rooms.delete(roomId);
      }
    });
  }

  return room;
}

async function createWebRtcTransport(router: Router) {
  const { listenInfos, initialAvailableOutgoingBitrate } =
    config.mediasoup.webRtcTransportOptions;

  return await router.createWebRtcTransport({
    listenInfos: listenInfos,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
}

function broadcastToRoom(roomId: string, message: any, excludePeerId?: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  const messageStr = JSON.stringify(message);

  for (const [peerId, peer] of room.peers) {
    if (peerId !== excludePeerId) {
      try {
        peer.socket.send(messageStr);
      } catch (err) {
        console.error(`Error sending to peer ${peerId}:`, err);
      }
    }
  }
}

function handleSocketMessage(
  ws: WebSocket<SocketData>,
  message: any,
  isBinary: boolean
) {
  if (isBinary) return;

  try {
    const data = JSON.parse(Buffer.from(message).toString());
    const { type } = data;

    switch (type) {
      case "join-room":
        handleJoinRoom(ws, data);
        break;
      case "create-transport":
        handleCreateTransport(ws, data);
        break;
      case "connect-transport":
        handleConnectTransport(ws, data);
        break;
      case "produce":
        handleProduce(ws, data);
        break;
      case "consume":
        handleConsume(ws, data);
        break;
      case "resume-consumer":
        handleResumeConsumer(ws, data);
        break;
      case "get-producers":
        handleGetProducers(ws, data);
        break;
      case "chat-message":
        handleChatMessage(ws, data);
        break;
      case "get-messages":
        handleGetMessages(ws, data);
        break;
      case "leave-room":
        handleLeaveRoom(ws, data);
        break;
      case "mute-status":
        handleMuteStatus(ws, data);
        break;
      case "speaking":
        handleSpeakingStatus(ws, data);
        break;
        case "video-status":
          handleVideoStatus(ws, data);    
      case "live-stream-state":
        handleLiveStreamState(ws, data);
        break;
      case "get-router-capabilities":
        handleGetRouterCapabilities(ws, data);
     
        break;
      default:
        console.warn(`Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error("Error handling message:", error);
    sendError(ws, "Error processing request");
  }
}

function sendError(ws: WebSocket<SocketData>, message: string) {
  ws.send(
    JSON.stringify({
      type: "error",
      message,
    })
  );
}

async function handleJoinRoom(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, peerName, isHost, isInvitee, rtpCapabilities } = data;

  try {
    const room = await getOrCreateRoom(roomId);

    const peer: Peer = {
      id: peerId,
      name: peerName,
      socket: ws,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      isHost,
      isInvitee,
      // set initial status of audio, and video to false for now
      // this will change based on preference when user join
      status: {
        audioMuted: false,
        videoMuted: false,
        speaking: false,
      },
    };

    room.peers.set(peerId, peer);
    ws.getUserData().peerId = peerId;
    ws.getUserData().roomId = roomId;

    broadcastToRoom(roomId, {
      type: "peer-joined",
      peerId,
      peerName,
      isHost,
      isInvitee,
    });

    const peerInfos = Array.from(room.peers.entries())
      .filter(([id]) => id !== peerId)
      .map(([id, p]) => ({
        id,
        name: p.name,
        isHost: p.isHost,
        isInvitee: p.isInvitee,
      }));

      console.log(JSON.stringify(peerInfos))

    ws.send(
      JSON.stringify({
        type: "room-info",
        roomId,
        peers: peerInfos,
      })
    );

    ws.send(
      JSON.stringify({
        type: "router-capabilities",
        routerCapabilities: room.router.rtpCapabilities,
      })
    );
  } catch (error) {
    console.error("Error joining room:", error);
    sendError(ws, "Error joining room");
  }
}

async function handleCreateTransport(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, direction } = data;
  // const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const transport = await createWebRtcTransport(room.router);

    console.log(
      `Created ${direction} transport ${transport.id} for peer ${peerId}`
    );
    // configuration option for a transport
    // that limits the maximum incoming bitrate the transport can handle - PREMIUM SUBS
    // if (maxIncomingBitrate) {
    //   try {
    //     await transport.setMaxIncomingBitrate(maxIncomingBitrate)
    //   } catch (error) {}
    // }

    //> START  ---> for only streaming
    if (direction === "send" && !peer.isHost && !peer.isInvitee) {
      console.log("Non-host attempted to create send transport");
      throw new Error("Only host can create send transport");
    }
    //> END

    peer.transports.set(transport.id, transport);
    peer.transports.set(direction, transport);

    transport.on("icestatechange", (state) => {
      console.log(`ICE state change for ${peerId}: ${state}`);
    });

    transport.on("dtlsstatechange", (state) => {
      console.log(`DTLS state change for ${peerId}: ${state}`);
    });

    transport.on("routerclose", () => {
      transport.close();
      peer.transports.delete(transport.id);
    });

    ws.send(
      JSON.stringify({
        type: "transport-created",
        direction,
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      })
    );
  } catch (error) {
    console.error("Error creating transport:", error);
    sendError(ws, "Error creating transport");
  }
}

async function handleConnectTransport(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, transportId, dtlsParameters } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const transport = peer.transports.get(transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    await transport.connect({ dtlsParameters });

    ws.send(
      JSON.stringify({
        type: "transport-connected",
        transportId,
      })
    );
  } catch (error) {
    console.error("Error connecting transport:", error);
    sendError(ws, "Error connecting transport");
  }
}

// async function handleReconnectTransport(ws: WebSocket<SocketData>, data: any) {
//     const {roomId, peerId} = data;

// }

async function handleProduce(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, transportId, kind, rtpParameters } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const transport = getTransport(room.peers.get(peerId)!, transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    if (
      kind === "video" &&
      !rtpParameters.codecs.some(
        (c: any) =>
          c.mimeType.toLowerCase().includes("vp8") ||
          c.mimeType.toLowerCase().includes("h264")
      )
    ) {
      throw new Error(
        `Unsupported video codecs: ${rtpParameters.codecs
          .map((c: any) => c.mimeType)
          .join(", ")}`
      );
    }

    const producer = await transport.produce({ kind, rtpParameters });

    if (peer) {
      //> Close existing video producers from same source
      Array.from(peer.producers.values()).forEach(prod => {
        if (prod.kind === kind && prod.appData.source === data.appData?.source) {
          prod.close();
          peer.producers.delete(prod.id);
          
          broadcastToRoom(roomId, {
            type: "producer-closed",
            producerId: prod.id,
            peerId
          });
        }
      });
    }
    peer.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      producer.close();
      peer.producers.delete(producer.id);
    });

    console.log(`Producer created: ${producer.id} (${kind}) by ${peerId}`);

    broadcastToRoom(
      roomId,
      {
        type: "new-producer",
        producerId: producer.id,
        peerId,
        kind,
      source: data.appData?.source || 'webcam'
      },
      peerId
    );

    ws.send(
      JSON.stringify({
        type: "producer-created",
        producerId: producer.id,
      })
    );
  } catch (error) {
    console.error("Error producing:", error);
    sendError(ws, "Error producing");
  }
}

// Consumer
async function handleConsume(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, transportId, producerId, rtpCapabilities } = data;

  console.log(`Consume request from ${peerId} for ${producerId}`);

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const transport = peer.transports.get(transportId) as WebRtcTransport;
    if (!transport) throw new Error(`Transport ${transportId} not found`);

    // Find the producer
    let producer: Producer | null = null;
    let producerPeerId = null;
    let producerPeerName = null;

    for (const [id, p] of room.peers.entries()) {
      if (p.producers.has(producerId)) {
        producer = p.producers.get(producerId)!;
        producerPeerId = id;
        producerPeerName = p.name;
        break;
      }
    }

    if (!producer || !producerPeerId) {
      throw new Error(`Producer ${producerId} not found`);
    }

    // Verify codec compatibility (don't create consumer if not compatible)
    if (
      !rtpCapabilities ||
      !room.router.canConsume({ producerId, rtpCapabilities })
    ) {
      console.warn(`Cannot consume ${producer.kind} - incompatible codecs`);
      return;
    }

    // Create the Consumer in paused mode
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
      enableRtx: true,
      ignoreDtx: true,
    });

    // Store the Consumer
    peer.consumers.set(consumer.id, consumer);

    // Set Consumer event handlers
    consumer.on("transportclose", () => {
      console.log(`Consumer ${consumer.id} transport closed`);
      peer.consumers.delete(consumer.id);
      ws.send(
        JSON.stringify({
          type: "consumer-closed",
          consumerId: consumer.id,
        })
      );
    });

    consumer.on("producerclose", () => {
      console.log(`Consumer ${consumer.id} producer closed`);
      peer.consumers.delete(consumer.id);
      ws.send(
        JSON.stringify({
          type: "consumer-closed",
          consumerId: consumer.id,
        })
      );
    });

    consumer.on("producerpause", () => {
      ws.send(
        JSON.stringify({
          type: "consumer-paused",
          consumerId: consumer.id,
        })
      );
    });

    consumer.on("producerresume", () => {
      ws.send(
        JSON.stringify({
          type: "consumer-resumed",
          consumerId: consumer.id,
        })
      );
    });

    consumer.on("layerschange", (layers) => {
      ws.send(
        JSON.stringify({
          type: "consumer-layers-changed",
          consumerId: consumer.id,
          spatialLayer: layers?.spatialLayer ?? null,
          temporalLayer: layers?.temporalLayer ?? null,
        })
      );
    });

    //> Will be useful for PREMIUM
    if (consumer.type === "simulcast") {
      await consumer.setPreferredLayers({
        spatialLayer: 2,
        temporalLayer: 2,
      });
    }

    // Send consumer parameters to client
    ws.send(
      JSON.stringify({
        type: "consumer-created",
        consumerId: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        producerPeerId,
        consumerType: consumer.type,
        producerPaused: consumer.producerPaused,
        producerPeerName,
      })
    );

    // Now that client has the consumer info, resume it
    await consumer.resume();

    // Send initial score
    ws.send(
      JSON.stringify({
        type: "consumer-score",
        consumerId: consumer.id,
        score: consumer.score,
      })
    );

    console.log(`Consumer created for ${peerId} consuming ${producerId}`);
  } catch (error) {
    console.error("Consume error:", error);
    ws.send(
      JSON.stringify({
        type: "consume-error",
        error: error instanceof Error ? error.message : "Consume failed",
      })
    );
  }
}

async function handleResumeConsumer(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, consumerId } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`);

    await consumer.resume();
  } catch (error) {
    console.error("Error resuming consumer:", error);
    sendError(ws, "Error resuming consumer");
  }
}

async function handleGetProducers(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    ///
    //    .filter(([id]) => id !== peerId)
    // include host producer for all attendee
    // const producers = Array.from(room.peers.entries())
    //   .filter(([id, peer]) => peer.isHost)
    //   .flatMap(([id, peer]) =>
    //     Array.from(peer.producers.entries()).map(([producerId, producer]) => ({
    //       peerId: id,
    //       producerId,
    //       kind: producer.kind,
    //     }))
    //   );

    // const producers = Array.from(room.peers.entries()).flatMap(([id, peer]) =>
    //   Array.from(peer.producers.entries()).map(([producerId, producer]) => ({
    //     peerId: id,
    //     producerId,
    //     kind: producer.kind,
    //   }))
    // );
    console.log("peer", JSON.stringify(room.peers.values()))

    const producers = Array.from(room.peers.values()).flatMap((peer) =>
      Array.from(peer.producers.values()).map((producer) => ({
        peerId: peer.id,
        peerName: peer.name,
        isHost: peer.isHost,
        isInvitee: peer.isInvitee,
        producerId: producer.id,
        kind: producer.kind,
      }))
    );

    console.log(`Sending ${producers.length} producers to ${peerId}`);

    ws.send(
      JSON.stringify({
        type: "producer-list",
        producers,
      })
    );
  } catch (error) {
    console.error("Error getting producers:", error);
    sendError(ws, "Error getting producers");
  }
}

function getTransport(peer: Peer, transportId: string): Transport {
  const transport = peer.transports.get(transportId);
  if (!transport) {
    console.error(
      `Available transports: ${Array.from(peer.transports.keys()).join(", ")}`
    );
    throw new Error(`Transport ${transportId} not found`);
  }
  return transport;
}

async function handleChatMessage(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, peerName, content } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);
    const genId = uuidv4();
    console.log("Before broadcast ");
    const message: Message = {
      id: genId,
      roomId,
      senderId: peerId,
      senderName: peerName,
      content,
      timestamp: new Date().toISOString(),
    };

    //> add message to the room
    room.messages.push(message);

    //> Broadcast the message
    broadcastToRoom(roomId, {
      type: "chat-message",
      message,
    });

    console.log("After broadcast ");
    const streamChat = {
      streamAttendeName: peerName,
      chat: content,
      streamAttendeeId: parseInt(peerId),
      streamAlias: roomId,
      timeStamp: new Date().toISOString(),
      streamChatAlias: genId,
    };
    //> send message to supabase
    const { error, status } = await supabase
      .from("streamChat")
      .upsert(streamChat);

    console.log("Error:  " + JSON.stringify(error));
    console.log("Status" + status);
  } catch (error) {
    console.error("Error sending chat message:", error);
    sendError(ws, "Error sending chat message");
  }
}

function handleGetMessages(ws: WebSocket<SocketData>, data: any) {
  const { roomId } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    ws.send(
      JSON.stringify({
        type: "message-list",
        messages: room.messages,
      })
    );
  } catch (error) {
    console.error("Error getting messages:", error);
    sendError(ws, "Error getting messages");
  }
}

function handleGetRouterCapabilities(ws: WebSocket<SocketData>, data: any) {
  const { roomId } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    ws.send(
      JSON.stringify({
        type: "router-capabilities",
        routerCapabilities: room.router.rtpCapabilities,
      })
    );
  } catch (error) {
    console.error("Error getting router capabilities:", error);
    sendError(ws, "Error getting router capabilities");
  }
}

function handleMuteStatus(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, kind, muted } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    if (kind === "audio") {
      peer.status.audioMuted = muted;
    } else if (kind === "video") {
      peer.status.videoMuted = muted;
    }

    broadcastToRoom(
      roomId,
      {
        type: "mute-status",
        peerId,
        kind,
        muted,
      },
      peerId
    );
  } catch (error) {
    console.error("Error handling mute status:", error);
    sendError(ws, "Error handling mute status");
  }
}

function handleSpeakingStatus(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, speaking } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    const peer = room.peers.get(peerId);
    if (!peer) throw new Error(`Peer ${peerId} not found`);

    peer.status.speaking = speaking;

    broadcastToRoom(
      roomId,
      {
        type: "speaking",
        peerId,
        speaking,
      },
      peerId
    );
  } catch (error) {
    console.error("Error handling speaking status:", error);
    sendError(ws, "Error handling speaking status");
  }
}

function handleVideoStatus(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId, enabled } = data;
  const room = rooms.get(roomId);
  
  try {
    if (room) {
      const peer = room.peers.get(peerId);
      if (peer) {
        peer.status.videoMuted = enabled;
        
        broadcastToRoom(roomId, {
          type: "peer-video-update",
          peerId,
          enabled
        });
      }
    }
  }
  catch(error) {
    console.error("Error handling video status", error);
    sendError(ws, "Error handling video status")
  }
}

async function handleLiveStreamState(ws: WebSocket<SocketData>, data: any) {
  const { roomId, dateString, settings, id } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);

    broadcastToRoom(roomId, {
      type: "live-stream-state",
      isLive: settings?.isLive,
    });

    const data = {
      [settings?.isLive ? "startDateTime" : "endDateTime"]: dateString,
      settings,
    };

    const { error, status } = await supabase
      .from("stream")
      .update(data)
      .eq("id", id);

    console.log("Error:  " + JSON.stringify(error));
  } catch (error) {
    console.error("Error handling live stream status:", error);
    sendError(ws, "Error handling live stream status");
  }
}

function handleLeaveRoom(ws: WebSocket<SocketData>, data: any) {
  const { roomId, peerId } = data;

  try {
    const room = rooms.get(roomId);
    if (!room) return;

    const peer = room.peers.get(peerId);
    if (!peer) return;

    peer.transports.forEach((transport) => transport.close());
    peer.producers.forEach((producer) => producer.close());
    peer.consumers.forEach((consumer) => consumer.close());

    room.peers.delete(peerId);

    broadcastToRoom(roomId, {
      type: "peer-left",
      peerId,
    });

    if (room.peers.size === 0) {
      serverEvents.emit(`room-empty:${roomId}`);
    }
  } catch (error) {
    console.error("Error leaving room:", error);
  }
}

async function startServer() {
  await createWorkers();

  const app = App();

  // Add CORS middleware for HTTP requests
  app.any("/*", (res, req) => {
    res.writeHeader("Access-Control-Allow-Origin", "*");
    res.writeHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.writeHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
  });

  app
    .ws("/ws", {
      compression: DEDICATED_COMPRESSOR_3KB,
      maxPayloadLength: 16 * 1024 * 1024,
      idleTimeout: 60,

      open: (ws) => {
        console.log("WebSocket connection opened");
      },

      message: (ws, message, isBinary) => {
        // @ts-ignore
        handleSocketMessage(ws, message, isBinary);
      },

      close: (ws, code, message) => {
        console.log("WebSocket connection closed");
        const userData = ws.getUserData();

        // @ts-ignore
        if (userData.peerId && userData.roomId) {
          // @ts-ignore
          handleLeaveRoom(ws, {
            // @ts-ignore
            roomId: userData.roomId,
            // @ts-ignore
            peerId: userData.peerId,
          });
        }
      },
    })
    .listen(3000, (token) => {
      if (token) {
        console.log("WebSocket server is running on port 3000");
      }
    });

  app.get("/", (res, _) => {
    res
      .writeStatus("200 OK")
      .writeHeader("Content-Type", "text/plain")
      .end("WebRTC SFU Server");
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, (token) => {
    if (token) {
      console.log(`Server started on port ${port}`);
    } else {
      console.error(`Failed to start server on port ${port}`);
    }
  });
}

startServer().catch(console.error);
