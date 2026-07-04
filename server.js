const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const rooms = new Map();

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.use((_request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function leaveRoom(socket) {
  if (!socket.roomId) return;

  const room = rooms.get(socket.roomId);
  if (room) {
    room.delete(socket);
    for (const peer of room) send(peer, { type: "peer-left" });
    if (room.size === 0) rooms.delete(socket.roomId);
  }

  socket.roomId = null;
}

wss.on("connection", (socket) => {
  socket.id = crypto.randomUUID();
  socket.isAlive = true;
  socket.roomId = null;

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: "error", message: "잘못된 요청입니다." });
    }

    if (message.type === "join") {
      const roomId = String(message.roomId || "").trim();
      if (!/^[a-zA-Z0-9_-]{4,40}$/.test(roomId)) {
        return send(socket, { type: "error", message: "올바르지 않은 방 코드입니다." });
      }

      leaveRoom(socket);
      const room = rooms.get(roomId) || new Set();
      if (room.size >= 2) {
        return send(socket, { type: "room-full", message: "이미 두 명이 통화 중인 방입니다." });
      }

      socket.roomId = roomId;
      room.add(socket);
      rooms.set(roomId, room);
      send(socket, { type: "joined", peerId: socket.id, waiting: room.size === 1 });

      if (room.size === 2) {
        for (const peer of room) {
          if (peer !== socket) send(peer, { type: "peer-joined" });
        }
      }
      return;
    }

    if (["offer", "answer", "ice-candidate"].includes(message.type) && socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      for (const peer of room) {
        if (peer !== socket) send(peer, message);
      }
    }
  });

  socket.on("close", () => leaveRoom(socket));
  socket.on("error", () => leaveRoom(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));

const port = process.env.PORT || 10000;
server.listen(port, "0.0.0.0", () => {
  console.log(`음성 채팅 서버가 ${port}번 포트에서 실행 중입니다.`);
});
