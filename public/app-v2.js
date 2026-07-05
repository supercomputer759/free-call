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
const participantCount = document.querySelector("#participantCount");
const notice = document.querySelector("#notice");
const muteButton = document.querySelector("#muteButton");
const speakerMuteButton = document.querySelector("#speakerMuteButton");
const leaveButton = document.querySelector("#leaveButton");
const remoteAudios = document.querySelector("#remoteAudios");
const noiseSuppressionToggle = document.querySelector("#noiseSuppressionToggle");
const sensitivitySlider = document.querySelector("#sensitivitySlider");
const sensitivityValue = document.querySelector("#sensitivityValue");
const micVolumeSlider = document.querySelector("#micVolumeSlider");
const micVolumeValue = document.querySelector("#micVolumeValue");
const speakerVolumeSlider = document.querySelector("#speakerVolumeSlider");
const speakerVolumeValue = document.querySelector("#speakerVolumeValue");
const displayNameInput = document.querySelector("#displayNameInput");
const chatMessages = document.querySelector("#chatMessages");
const emptyChat = document.querySelector("#emptyChat");
const chatForm = document.querySelector("#chatForm");
const chatInput = document.querySelector("#chatInput");
const attachButton = document.querySelector("#attachButton");
const fileInput = document.querySelector("#fileInput");
const fileStatus = document.querySelector("#fileStatus");

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const peers = new Map();
let socket;
let localStream;
let rawMicStream;
let audioContext;
let gateGain;
let micVolumeGain;
let gateAnalyser;
let gateTimer;
let roomId;
let reconnectTimer;
let reconnectAttempts = 0;
let intentionalLeave = false;
let sendingFile = false;
let wakeLockSentinel;

const maxFileSize = 25 * 1024 * 1024;
const fileChunkSize = 16 * 1024;

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

function updateParticipantCount() {
  participantCount.textContent = String(peers.size + 1);
  if (peers.size > 0) {
    setCallStatus("통화 연결됨", `${peers.size + 1}명이 함께 통화 중입니다.`, true);
  }
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function replaceOutgoingAudioTrack(track) {
  if (!track) return;
  const replacements = [];
  for (const { connection } of peers.values()) {
    const sender = connection.getSenders().find((item) => item.track?.kind === "audio");
    if (sender) replacements.push(sender.replaceTrack(track));
  }
  await Promise.allSettled(replacements);
}

async function requestWakeLock() {
  if (wakeLockSentinel || !roomId || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => {
      wakeLockSentinel = null;
    }, { once: true });
  } catch {
    wakeLockSentinel = null;
  }
}

async function releaseWakeLock() {
  const lock = wakeLockSentinel;
  wakeLockSentinel = null;
  await lock?.release().catch(() => {});
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

function getGateThreshold() {
  const strength = Number(sensitivitySlider.value) / 100;
  return -62 + (strength * 37);
}

function updateSensitivityLabel() {
  const value = Number(sensitivitySlider.value);
  sensitivityValue.value = value < 34 ? "약하게" : value < 68 ? "보통" : "강하게";
}

async function createFilteredStream(stream) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return stream;

  audioContext = new AudioContextClass();
  const source = audioContext.createMediaStreamSource(stream);
  const highPass = audioContext.createBiquadFilter();
  const lowPass = audioContext.createBiquadFilter();
  gateAnalyser = audioContext.createAnalyser();
  gateGain = audioContext.createGain();
  micVolumeGain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();

  highPass.type = "highpass";
  highPass.frequency.value = 90;
  lowPass.type = "lowpass";
  lowPass.frequency.value = 7200;
  gateAnalyser.fftSize = 512;
  gateAnalyser.smoothingTimeConstant = 0.35;
  micVolumeGain.gain.value = Number(micVolumeSlider.value) / 100;

  source
    .connect(highPass)
    .connect(lowPass)
    .connect(gateAnalyser)
    .connect(gateGain)
    .connect(micVolumeGain)
    .connect(destination);
  await audioContext.resume().catch(() => {});

  const samples = new Float32Array(gateAnalyser.fftSize);
  gateTimer = setInterval(() => {
    if (!gateAnalyser || !gateGain || !audioContext) return;
    gateAnalyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const decibels = 20 * Math.log10(Math.max(rms, 0.00001));
    const gateOpen = decibels >= getGateThreshold();
    const now = audioContext.currentTime;
    gateGain.gain.cancelScheduledValues(now);
    gateGain.gain.setTargetAtTime(gateOpen ? 1 : 0, now, gateOpen ? 0.008 : 0.09);
  }, 30);

  return destination.stream;
}

function applySpeakerSettings(audio) {
  audio.muted = speakerMuteButton.getAttribute("aria-pressed") === "true";
  audio.volume = Number(speakerVolumeSlider.value) / 100;
}

function getDisplayName() {
  return displayNameInput.value.trim().slice(0, 16) || "익명";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function appendMessage({ name, text, file, mine = false }) {
  emptyChat?.remove();
  const wrapper = document.createElement("article");
  const nameElement = document.createElement("p");
  const content = document.createElement("div");
  wrapper.className = `message${mine ? " mine" : ""}`;
  nameElement.className = "message-name";
  nameElement.textContent = name;
  content.className = "message-content";

  if (text) {
    content.textContent = text;
  } else if (file) {
    const url = URL.createObjectURL(file.blob);
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = file.name;
      content.append(image);
    } else if (file.type.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.preload = "metadata";
      content.append(video);
    } else if (file.type.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.src = url;
      audio.controls = true;
      audio.preload = "metadata";
      content.append(audio);
    }

    if (file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/")) {
      const caption = document.createElement("div");
      caption.className = "media-caption";
      caption.textContent = `${file.name} · ${formatBytes(file.size)}`;
      content.append(caption);
    } else {
      const card = document.createElement("div");
      const info = document.createElement("span");
      const title = document.createElement("strong");
      const size = document.createElement("small");
      const download = document.createElement("a");
      card.className = "file-card";
      title.textContent = file.name;
      size.textContent = formatBytes(file.size);
      download.href = url;
      download.download = file.name;
      download.textContent = "저장";
      info.append(title, size);
      card.append(info, download);
      content.append(card);
    }
  }

  wrapper.append(nameElement, content);
  chatMessages.append(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setupDataChannel(peer, channel) {
  peer.dataChannel = channel;
  channel.binaryType = "arraybuffer";

  channel.onmessage = ({ data }) => {
    if (typeof data === "string") {
      const message = JSON.parse(data);
      if (message.type === "chat") {
        appendMessage({ name: message.name, text: message.text });
      } else if (message.type === "file-start") {
        peer.incomingFile = { ...message, chunks: [], received: 0 };
        fileStatus.textContent = `${message.name} 받는 중…`;
      } else if (message.type === "file-end" && peer.incomingFile?.id === message.id) {
        const incoming = peer.incomingFile;
        const blob = new Blob(incoming.chunks, { type: incoming.fileType });
        appendMessage({
          name: incoming.sender,
          file: { name: incoming.name, type: incoming.fileType, size: incoming.size, blob }
        });
        peer.incomingFile = null;
        fileStatus.textContent = "";
      }
      return;
    }

    if (peer.incomingFile) {
      peer.incomingFile.chunks.push(data);
      peer.incomingFile.received += data.byteLength;
      const progress = Math.min(100, Math.round((peer.incomingFile.received / peer.incomingFile.size) * 100));
      fileStatus.textContent = `${peer.incomingFile.name} 받는 중 ${progress}%`;
    }
  };
}

function getOpenDataChannels() {
  return [...peers.values()]
    .map((peer) => peer.dataChannel)
    .filter((channel) => channel?.readyState === "open");
}

function broadcastJson(message) {
  const channels = getOpenDataChannels();
  const payload = JSON.stringify(message);
  for (const channel of channels) channel.send(payload);
  return channels.length;
}

async function waitForChannelBuffer(channel) {
  if (channel.bufferedAmount < 512 * 1024) return;
  await new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.addEventListener("bufferedamountlow", resolve, { once: true });
  });
}

async function sendFile(file) {
  if (sendingFile) return setNotice("다른 파일을 전송하고 있습니다.");
  if (file.size > maxFileSize) return setNotice("파일은 최대 25MB까지 전송할 수 있습니다.");

  const channels = getOpenDataChannels();
  if (channels.length === 0) return setNotice("파일을 받을 참가자가 아직 연결되지 않았습니다.");

  sendingFile = true;
  const id = crypto.randomUUID();
  const metadata = {
    type: "file-start",
    id,
    sender: getDisplayName(),
    name: file.name,
    fileType: file.type || "application/octet-stream",
    size: file.size
  };

  for (const channel of channels) channel.send(JSON.stringify(metadata));
  try {
    for (let offset = 0; offset < file.size; offset += fileChunkSize) {
      const chunk = await file.slice(offset, offset + fileChunkSize).arrayBuffer();
      for (const channel of channels) {
        await waitForChannelBuffer(channel);
        channel.send(chunk);
      }
      fileStatus.textContent = `${file.name} 보내는 중 ${Math.round(((offset + chunk.byteLength) / file.size) * 100)}%`;
    }
    for (const channel of channels) channel.send(JSON.stringify({ type: "file-end", id }));
    appendMessage({
      name: getDisplayName(),
      mine: true,
      file: { name: file.name, type: file.type || "application/octet-stream", size: file.size, blob: file }
    });
    fileStatus.textContent = "파일 전송 완료";
  } catch {
    setNotice("파일 전송 중 연결이 끊겼습니다.");
  } finally {
    sendingFile = false;
    fileInput.value = "";
    setTimeout(() => { fileStatus.textContent = ""; }, 2000);
  }
}

function playJoinSound() {
  if (!audioContext || speakerMuteButton.getAttribute("aria-pressed") === "true") return;

  audioContext.resume().then(() => {
    const now = audioContext.currentTime;
    const volume = Number(speakerVolumeSlider.value) / 100;
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.14), now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    gain.connect(audioContext.destination);

    [620, 880].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(now + (index * 0.1));
      oscillator.stop(now + 0.32);
    });
  }).catch(() => {});
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.connection.close();
  peer.audio.remove();
  peers.delete(peerId);
  updateParticipantCount();
}

function clearPeers() {
  for (const peerId of [...peers.keys()]) removePeer(peerId);
}

function createPeerConnection(peerId, createsDataChannel = false) {
  removePeer(peerId);

  const connection = new RTCPeerConnection(rtcConfig);
  const audio = document.createElement("audio");
  const peer = { connection, audio, pendingCandidates: [], dataChannel: null, incomingFile: null };
  audio.autoplay = true;
  audio.dataset.peerId = peerId;
  applySpeakerSettings(audio);
  remoteAudios.append(audio);
  peers.set(peerId, peer);
  updateParticipantCount();

  for (const track of localStream.getTracks()) {
    connection.addTrack(track, localStream);
  }

  connection.onicecandidate = ({ candidate }) => {
    if (candidate) send({ type: "ice-candidate", target: peerId, candidate });
  };

  connection.ontrack = ({ streams }) => {
    [audio.srcObject] = streams;
    audio.play().catch(() => {
      setNotice("소리가 안 들리면 화면을 한 번 눌러주세요.");
    });
  };

  connection.ondatachannel = ({ channel }) => setupDataChannel(peer, channel);
  if (createsDataChannel) setupDataChannel(peer, connection.createDataChannel("chat", { ordered: true }));

  connection.onconnectionstatechange = () => {
    const state = connection.connectionState;
    if (state === "connected") {
      updateParticipantCount();
      setNotice("");
    } else if (state === "failed") {
      setNotice("일부 참가자와 연결하지 못했습니다. 재접속하면 다시 연결됩니다.");
      removePeer(peerId);
    }
  };

  return peer;
}

async function addPendingCandidates(peer) {
  for (const candidate of peer.pendingCandidates) {
    await peer.connection.addIceCandidate(candidate);
  }
  peer.pendingCandidates.length = 0;
}

async function createOfferFor(peerId) {
  const peer = createPeerConnection(peerId, true);
  const offer = await peer.connection.createOffer();
  await peer.connection.setLocalDescription(offer);
  send({ type: "offer", target: peerId, sdp: peer.connection.localDescription });
}

async function handleSignal(message) {
  if (message.type === "joined") {
    reconnectAttempts = 0;
    setCallStatus(
      message.peers.length ? "참가자 연결 중" : "친구를 기다리는 중",
      message.peers.length ? "방의 참가자들과 연결하고 있습니다." : "위 링크를 친구들에게 보내주세요."
    );
    for (const peerId of message.peers) await createOfferFor(peerId);
    return;
  }

  if (message.type === "peer-joined") {
    playJoinSound();
    setCallStatus("새 참가자가 들어왔어요", "음성 연결을 준비하고 있습니다.");
    return;
  }

  if (message.type === "offer") {
    const peer = createPeerConnection(message.from);
    await peer.connection.setRemoteDescription(message.sdp);
    await addPendingCandidates(peer);
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    send({ type: "answer", target: message.from, sdp: peer.connection.localDescription });
    return;
  }

  if (message.type === "answer") {
    const peer = peers.get(message.from);
    if (!peer) return;
    await peer.connection.setRemoteDescription(message.sdp);
    await addPendingCandidates(peer);
    return;
  }

  if (message.type === "ice-candidate") {
    const peer = peers.get(message.from);
    if (!peer) return;
    if (peer.connection.remoteDescription) {
      await peer.connection.addIceCandidate(message.candidate);
    } else {
      peer.pendingCandidates.push(message.candidate);
    }
    return;
  }

  if (message.type === "peer-left") {
    removePeer(message.peerId);
    if (peers.size === 0) {
      setCallStatus("친구를 기다리는 중", "같은 링크로 들어오면 자동으로 연결됩니다.");
    }
    return;
  }

  if (message.type === "error") setNotice(message.message);
}

function connectSignalSocket() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.addEventListener("open", () => {
    send({ type: "join", roomId });
    if (reconnectAttempts > 0) setNotice("서버에 다시 연결했습니다.", true);
  });

  socket.addEventListener("message", async (event) => {
    try {
      await handleSignal(JSON.parse(event.data));
    } catch (error) {
      console.error(error);
      setNotice("음성 연결 처리 중 문제가 생겼습니다.");
    }
  });

  socket.addEventListener("close", () => {
    if (intentionalLeave || !roomId) return;
    clearPeers();
    reconnectAttempts += 1;
    const delay = Math.min(1000 * (2 ** (reconnectAttempts - 1)), 15_000);
    setCallStatus("서버 재연결 중", `${Math.ceil(delay / 1000)}초 뒤 자동으로 다시 연결합니다.`);
    reconnectTimer = setTimeout(connectSignalSocket, delay);
  });

  socket.addEventListener("error", () => {
    setNotice("서버 연결이 불안정합니다. 자동으로 재시도합니다.");
  });
}

async function joinRoom(code) {
  roomId = code.trim();
  if (!/^[a-zA-Z0-9_-]{4,40}$/.test(roomId)) {
    roomId = null;
    return setNotice("방 코드는 영문, 숫자, -, _만 사용할 수 있습니다.");
  }

  setNotice("");
  createRoomButton.disabled = true;
  intentionalLeave = false;
  try {
    rawMicStream = await getMicrophone();
    localStream = await createFilteredStream(rawMicStream);
  } catch (error) {
    roomId = null;
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
  participantCount.textContent = "1";
  setCallStatus("서버 연결 중", "잠시만 기다려주세요.");
  requestWakeLock();
  connectSignalSocket();
}

function leaveCall(updateUrl = true) {
  intentionalLeave = true;
  releaseWakeLock();
  clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
  clearPeers();
  localStream?.getTracks().forEach((track) => track.stop());
  rawMicStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  rawMicStream = null;
  clearInterval(gateTimer);
  gateTimer = null;
  gateAnalyser = null;
  gateGain = null;
  micVolumeGain = null;
  audioContext?.close();
  audioContext = null;
  roomId = null;
  reconnectAttempts = 0;
  muteButton.setAttribute("aria-pressed", "false");
  muteButton.lastElementChild.textContent = "음소거";
  speakerMuteButton.setAttribute("aria-pressed", "false");
  speakerMuteButton.firstElementChild.textContent = "🔊";
  speakerMuteButton.lastElementChild.textContent = "스피커 끄기";
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
  const rawTrack = rawMicStream?.getAudioTracks()[0];
  if (rawTrack) rawTrack.enabled = track.enabled;
  const muted = !track.enabled;
  muteButton.setAttribute("aria-pressed", String(muted));
  muteButton.lastElementChild.textContent = muted ? "음소거 해제" : "음소거";
});

speakerMuteButton.addEventListener("click", () => {
  const muted = speakerMuteButton.getAttribute("aria-pressed") !== "true";
  speakerMuteButton.setAttribute("aria-pressed", String(muted));
  speakerMuteButton.firstElementChild.textContent = muted ? "🔇" : "🔊";
  speakerMuteButton.lastElementChild.textContent = muted ? "스피커 켜기" : "스피커 끄기";
  for (const { audio } of peers.values()) applySpeakerSettings(audio);
});

noiseSuppressionToggle.addEventListener("change", async () => {
  const track = rawMicStream?.getAudioTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: noiseSuppressionToggle.checked,
      autoGainControl: noiseSuppressionToggle.checked
    });
    setNotice(noiseSuppressionToggle.checked ? "잡음 억제를 켰습니다." : "잡음 억제를 껐습니다.", true);
  } catch {
    setNotice("이 브라우저에서는 잡음 억제 설정 변경을 지원하지 않습니다.");
  }
});

sensitivitySlider.addEventListener("input", updateSensitivityLabel);
micVolumeSlider.addEventListener("input", () => {
  const volume = Number(micVolumeSlider.value);
  micVolumeValue.value = `${volume}%`;
  if (micVolumeGain) micVolumeGain.gain.value = volume / 100;
});
speakerVolumeSlider.addEventListener("input", () => {
  speakerVolumeValue.value = `${speakerVolumeSlider.value}%`;
  for (const { audio } of peers.values()) applySpeakerSettings(audio);
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const name = getDisplayName();
  if (broadcastJson({ type: "chat", name, text }) === 0) {
    return setNotice("메시지를 받을 참가자가 아직 연결되지 않았습니다.");
  }
  appendMessage({ name, text, mine: true });
  chatInput.value = "";
});

attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) sendFile(file);
});

updateSensitivityLabel();
document.addEventListener("pointerdown", () => {
  audioContext?.resume();
  for (const { audio } of peers.values()) audio.play().catch(() => {});
}, { passive: true });

document.addEventListener("visibilitychange", () => {
  if (!roomId || intentionalLeave) return;

  if (document.visibilityState !== "visible") {
    const processedTrack = localStream?.getAudioTracks()[0];
    const rawTrack = rawMicStream?.getAudioTracks()[0];
    if (rawTrack) {
      rawTrack.enabled = processedTrack?.enabled ?? true;
      replaceOutgoingAudioTrack(rawTrack);
    }
    return;
  }

  requestWakeLock();
  audioContext?.resume().then(() => {
    replaceOutgoingAudioTrack(localStream?.getAudioTracks()[0]);
  }).catch(() => {});
  for (const { audio } of peers.values()) audio.play().catch(() => {});

  if (!socket || socket.readyState === WebSocket.CLOSED) {
    clearTimeout(reconnectTimer);
    setCallStatus("통화 복구 중", "서버와 참가자들에게 다시 연결하고 있습니다.");
    connectSignalSocket();
  }
});

leaveButton.addEventListener("click", () => leaveCall());
window.addEventListener("beforeunload", () => {
  intentionalLeave = true;
  releaseWakeLock();
  localStream?.getTracks().forEach((track) => track.stop());
  rawMicStream?.getTracks().forEach((track) => track.stop());
});

const sharedRoom = new URLSearchParams(location.search).get("room");
if (sharedRoom) {
  roomCodeInput.value = sharedRoom;
  joinRoom(sharedRoom);
}
