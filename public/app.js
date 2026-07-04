const lobby = document.querySelector("#lobby");
const callPanel = document.querySelector("#callPanel");
const createRoomButton = document.querySelector("#createRoomButton");
const joinForm = document.querySelector("#joinForm");
const roomCodeInput = document.querySelector("#roomCode");
const inviteLinkInput = document.querySelector("#inviteLink");
const copyButton = document.querySelector("#copyButton");
const currentRoomCode = document.querySelector("#currentRoomCode");
const statusOrb = document.querySelector("#statusOrb");
const statusTitle = document.querySelector("#statusTitle");
const statusText = document.querySelector("#statusText");
const notice = document.querySelector("#notice");
const muteButton = document.querySelector("#muteButton");
const leaveButton = document.querySelector("#leaveButton");
const remoteAudio = document.querySelector("#remoteAudio");

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

let socket;
let peerConnection;
let localStream;
let roomId;
let pendingCandidates = [];

function makeRoomCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function setNotice(message = "", success = false) {
  notice.textContent = message;
  notice.classList.toggle("success", success);
}

function setCallStatus(title, text, active = false) {
  statusTitle.textContent = title;
  statusText.textContent = text;
  statusOrb.classList.toggle("waiting", !active);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function getMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("이 브라우저에서는 마이크를 사용할 수 없습니다.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
}

function createPeerConnection() {
  if (peerConnection) peerConnection.close();
  pendingCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfig);

  for (const track of localStream.getTracks()) {
    peerConnection.addTrack(track, localStream);
  }

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "ice-candidate", candidate });
  };

  peerConnection.ontrack = ({ streams }) => {
    [remoteAudio.srcObject] = streams;
    remoteAudio.play().catch(() => {
      setNotice("소리가 안 들리면 화면을 한 번 눌러주세요.");
    });
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    if (state === "connected") {
      setCallStatus("통화 연결됨", "친구와 음성으로 연결되었습니다.", true);
      setNotice("");
    } else if (state === "failed") {
      setCallStatus("연결 실패", "네트워크 환경 때문에 직접 연결하지 못했습니다.");
      setNotice("다시 방에 입장하거나 TURN 서버를 설정해 주세요.");
    } else if (state === "disconnected") {
      setCallStatus("연결 확인 중", "친구와의 연결을 다시 확인하고 있습니다.");
    }
  };

  return peerConnection;
}

async function addPendingCandidates() {
  for (const candidate of pendingCandidates) {
    await peerConnection.addIceCandidate(candidate);
  }
  pendingCandidates = [];
}

async function handleSignal(message) {
  if (message.type === "joined") {
    setCallStatus(
      message.waiting ? "친구를 기다리는 중" : "연결 준비 중",
      message.waiting ? "위 링크를 친구에게 보내주세요." : "친구와 연결하고 있습니다."
    );
    return;
  }

  if (message.type === "peer-joined") {
    createPeerConnection();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    send({ type: "offer", sdp: peerConnection.localDescription });
    setCallStatus("친구가 들어왔어요", "음성 연결을 시작하고 있습니다.");
    return;
  }

  if (message.type === "offer") {
    createPeerConnection();
    await peerConnection.setRemoteDescription(message.sdp);
    await addPendingCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    send({ type: "answer", sdp: peerConnection.localDescription });
    return;
  }

  if (message.type === "answer") {
    await peerConnection?.setRemoteDescription(message.sdp);
    await addPendingCandidates();
    return;
  }

  if (message.type === "ice-candidate") {
    if (peerConnection?.remoteDescription) {
      await peerConnection.addIceCandidate(message.candidate);
    } else {
      pendingCandidates.push(message.candidate);
    }
    return;
  }

  if (message.type === "peer-left") {
    peerConnection?.close();
    peerConnection = null;
    remoteAudio.srcObject = null;
    setCallStatus("친구가 나갔어요", "같은 링크로 다시 들어오면 자동으로 연결됩니다.");
    return;
  }

  if (message.type === "room-full" || message.type === "error") {
    setNotice(message.message);
    if (message.type === "room-full") leaveCall(false);
  }
}

async function joinRoom(code) {
  roomId = code.trim();
  if (!/^[a-zA-Z0-9_-]{4,40}$/.test(roomId)) {
    return setNotice("방 코드는 영문, 숫자, -, _만 사용할 수 있습니다.");
  }

  setNotice("");
  createRoomButton.disabled = true;
  try {
    localStream = await getMicrophone();
  } catch (error) {
    createRoomButton.disabled = false;
    return setNotice(error.name === "NotAllowedError"
      ? "통화하려면 마이크 권한을 허용해야 합니다."
      : error.message || "마이크를 열지 못했습니다.");
  }

  lobby.classList.add("hidden");
  callPanel.classList.remove("hidden");
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  history.replaceState(null, "", url);
  inviteLinkInput.value = url.href;
  currentRoomCode.textContent = roomId;
  setCallStatus("서버 연결 중", "잠시만 기다려주세요.");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => send({ type: "join", roomId }));
  socket.addEventListener("message", async (event) => {
    try {
      await handleSignal(JSON.parse(event.data));
    } catch (error) {
      console.error(error);
      setNotice("음성 연결 처리 중 문제가 생겼습니다.");
    }
  });
  socket.addEventListener("close", () => {
    if (!callPanel.classList.contains("hidden")) {
      setCallStatus("서버 연결 끊김", "페이지를 새로고침해 다시 연결해 주세요.");
    }
  });
  socket.addEventListener("error", () => setNotice("서버에 연결하지 못했습니다."));
}

function leaveCall(updateUrl = true) {
  socket?.close();
  socket = null;
  peerConnection?.close();
  peerConnection = null;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  remoteAudio.srcObject = null;
  pendingCandidates = [];
  roomId = null;
  muteButton.setAttribute("aria-pressed", "false");
  muteButton.lastElementChild.textContent = "음소거";
  callPanel.classList.add("hidden");
  lobby.classList.remove("hidden");
  createRoomButton.disabled = false;
  if (updateUrl) history.replaceState(null, "", location.pathname);
}

createRoomButton.addEventListener("click", () => joinRoom(makeRoomCode()));
joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom(roomCodeInput.value);
});

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteLinkInput.value);
    copyButton.textContent = "복사됨";
    setNotice("초대 링크를 복사했습니다.", true);
    setTimeout(() => { copyButton.textContent = "복사"; }, 1500);
  } catch {
    inviteLinkInput.select();
    setNotice("링크를 선택했습니다. 직접 복사해 주세요.");
  }
});

muteButton.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const muted = !track.enabled;
  muteButton.setAttribute("aria-pressed", String(muted));
  muteButton.lastElementChild.textContent = muted ? "음소거 해제" : "음소거";
});

leaveButton.addEventListener("click", () => leaveCall());
window.addEventListener("beforeunload", () => {
  localStream?.getTracks().forEach((track) => track.stop());
});

const sharedRoom = new URLSearchParams(location.search).get("room");
if (sharedRoom) {
  roomCodeInput.value = sharedRoom;
  joinRoom(sharedRoom);
}
