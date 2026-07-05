const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

const port = 10001;
const server = spawn(process.execPath, ["server.js"], {
  cwd: path.join(__dirname, ".."),
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

function nextMessage(socket, type) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      socket.off("message", handler);
      resolve(message);
    };
    socket.on("message", handler);
  });
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function joinRoom() {
  const socket = await openSocket();
  const joined = nextMessage(socket, "joined");
  socket.send(JSON.stringify({ type: "join", roomId: "test-room" }));
  return { socket, joined: await joined };
}

async function run() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("서버 시작 시간 초과")), 5000);
    server.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.once("error", reject);
  });

  const first = await joinRoom();
  const second = await joinRoom();
  const third = await joinRoom();

  if (third.joined.peers.length !== 2) {
    throw new Error("세 번째 참가자가 기존 참가자 2명을 받지 못했습니다.");
  }

  const routedOffer = nextMessage(first.socket, "offer");
  third.socket.send(JSON.stringify({
    type: "offer",
    target: first.joined.peerId,
    sdp: { type: "offer", sdp: "test" }
  }));

  const offer = await routedOffer;
  if (offer.from !== third.joined.peerId) {
    throw new Error("대상 지정 신호의 발신자 정보가 올바르지 않습니다.");
  }

  first.socket.close();
  second.socket.close();
  third.socket.close();
  console.log("3명 입장 및 대상 지정 신호 전달: 정상");
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.kill());
