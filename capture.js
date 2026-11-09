const PHOTO_LIMIT = 10;
const VIDEO_LIMIT = 3;
const DATABASE_NAME = "snapora-captures";
const STORE_NAME = "media";

const cameraPreview = document.querySelector("#camera-preview");
const cameraEmpty = document.querySelector("#camera-empty");
const cameraToggle = document.querySelector("#camera-toggle");
const cameraStatus = document.querySelector("#camera-status");
const cameraError = document.querySelector("#camera-error");
const captureAction = document.querySelector("#capture-action");
const photoMode = document.querySelector("#photo-mode");
const videoMode = document.querySelector("#video-mode");
const recordingIndicator = document.querySelector("#recording-indicator");
const galleryGrid = document.querySelector("#gallery-grid");
const galleryStatus = document.querySelector("#gallery-status");
const galleryError = document.querySelector("#storage-error");
const deleteSelected = document.querySelector("#delete-selected");
const showPhotos = document.querySelector("#show-photos");
const showVideos = document.querySelector("#show-videos");

let database;
let cameraStream;
let microphoneStream;
let recorder;
let recordingChunks = [];
let media = [];
let selectedMedia = new Set();
let activeKind = "photo";
let galleryKind = "photo";
let objectUrls = [];
let sessionId;

function getSessionId() {
  let sessionId = localStorage.getItem("snapora-session-id");
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("snapora-session-id", sessionId);
  }
  return sessionId;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("sessionId", "sessionId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local storage."));
    request.onblocked = () => reject(new Error("Local storage is busy in another Snapora tab. Close that tab and try again."));
  });
}

function storeRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    let result;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error || new Error("Could not access your saved captures."));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("Could not access your saved captures."));
    transaction.onabort = () => reject(transaction.error || new Error("The capture could not be saved."));
  });
}

function currentCount(kind) {
  return media.filter((item) => item.kind === kind).length;
}

function updateQuotas() {
  const photoCount = currentCount("photo");
  const videoCount = currentCount("video");
  document.querySelector("#photo-count").textContent = String(photoCount);
  document.querySelector("#video-count").textContent = String(videoCount);
  document.querySelector("#photo-gallery-count").textContent = String(photoCount);
  document.querySelector("#video-gallery-count").textContent = String(videoCount);
  document.querySelector("#photo-progress").style.setProperty("--progress", photoCount / PHOTO_LIMIT);
  document.querySelector("#video-progress").style.setProperty("--progress", videoCount / VIDEO_LIMIT);

  const limit = activeKind === "photo" ? PHOTO_LIMIT : VIDEO_LIMIT;
  const full = currentCount(activeKind) >= limit;
  if (recorder?.state === "recording") {
    captureAction.textContent = "Stop video";
    captureAction.disabled = false;
  } else {
    captureAction.textContent = activeKind === "photo" ? "Take photo" : "Start video";
    captureAction.disabled = !database || !cameraStream || full;
  }
}

function setCameraError(message) {
  cameraError.textContent = message;
  cameraError.hidden = !message;
}

function describeCameraError(error) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return "Camera access needs a secure connection. Open Snapora over HTTPS and try again.";
  }
  if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
    return "Camera access was blocked. Allow camera access in your browser settings, then try again.";
  }
  if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
    return "No camera was found on this device. Connect a camera or use another device.";
  }
  if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
    return "The camera is in use by another app. Close that app and try again.";
  }
  return "The camera could not start. Check your browser permissions and try again.";
}

async function startCamera() {
  cameraToggle.disabled = true;
  cameraStatus.textContent = "Waiting for camera permission.";
  setCameraError("");

  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Secure camera access is unavailable.");
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    cameraPreview.srcObject = cameraStream;
    cameraPreview.hidden = false;
    cameraEmpty.hidden = true;
    cameraToggle.textContent = "Turn camera off";
    cameraStatus.textContent = "Camera is ready. Choose photo or video.";
    await cameraPreview.play();
    updateQuotas();
  } catch (error) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraPreview.srcObject = null;
    cameraPreview.hidden = true;
    cameraEmpty.hidden = false;
    cameraToggle.textContent = "Allow camera";
    cameraStatus.textContent = "Camera is off.";
    setCameraError(describeCameraError(error));
  } finally {
    cameraToggle.disabled = false;
  }
}

function stopCamera() {
  if (recorder?.state === "recording") recorder.stop();
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }
  cameraPreview.srcObject = null;
  cameraPreview.hidden = true;
  cameraEmpty.hidden = false;
  cameraToggle.textContent = "Allow camera";
  cameraStatus.textContent = "Camera is off. Tap Allow camera when you are ready.";
  updateQuotas();
}

function setMode(kind) {
  if (recorder?.state === "recording") return;
  activeKind = kind;
  photoMode.classList.toggle("is-active", kind === "photo");
  videoMode.classList.toggle("is-active", kind === "video");
  photoMode.setAttribute("aria-pressed", String(kind === "photo"));
  videoMode.setAttribute("aria-pressed", String(kind === "video"));
  updateQuotas();
}

function addMedia(kind, blob) {
  return new Promise((resolve, reject) => {
    // The readwrite transaction serializes this check with other tabs using the same store.
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.index("sessionId").getAll(sessionId);
    const limit = kind === "photo" ? PHOTO_LIMIT : VIDEO_LIMIT;
    let id;
    let limitError;

    request.onsuccess = () => {
      const count = request.result.filter((item) => item.kind === kind).length;
      if (count >= limit) {
        limitError = new Error(`The ${kind} limit is full.`);
        limitError.name = "QuotaExceededError";
        transaction.abort();
        return;
      }

      id = crypto.randomUUID();
      store.add({
        id,
        sessionId,
        kind,
        blob,
        createdAt: new Date().toISOString(),
      });
    };
    request.onerror = () => reject(request.error || new Error("Could not check the capture limit."));
    transaction.oncomplete = () => resolve(id);
    transaction.onerror = () => reject(limitError || transaction.error || new Error("The capture could not be saved."));
    transaction.onabort = () => reject(limitError || transaction.error || new Error("The capture could not be saved."));
  });
}

async function takePhoto() {
  if (!cameraStream || cameraPreview.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    cameraStatus.textContent = "The camera preview is not ready yet. Wait a moment and try again.";
    return;
  }
  if (currentCount("photo") >= PHOTO_LIMIT) {
    cameraStatus.textContent = "Your 10-photo limit is full. Delete a photo to make room.";
    updateQuotas();
    return;
  }

  captureAction.disabled = true;
  cameraStatus.textContent = "Saving your photo.";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = cameraPreview.videoWidth;
    canvas.height = cameraPreview.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo capture is unavailable.");
    context.drawImage(cameraPreview, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("The photo could not be created."));
      }, "image/jpeg", 0.92);
    });
    await addMedia("photo", blob);
    await loadMedia();
    cameraStatus.textContent = `Photo saved. ${currentCount("photo")} of ${PHOTO_LIMIT} photos used.`;
  } catch {
    if (error?.name === "QuotaExceededError") {
      await refreshAfterQuota("photo");
    } else {
      cameraStatus.textContent = "The photo could not be saved. Check available browser storage and try again.";
    }
  } finally {
    updateQuotas();
  }
}

function supportedVideoType() {
  if (!window.MediaRecorder) return "";
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  if (!cameraStream) return;
  if (currentCount("video") >= VIDEO_LIMIT) {
    cameraStatus.textContent = "Your 3-video limit is full. Delete a video to make room.";
    updateQuotas();
    return;
  }
  if (!window.MediaRecorder) {
    setCameraError("Video recording is not supported by this browser. You can still take photos.");
    return;
  }

  captureAction.disabled = true;
  cameraStatus.textContent = "Waiting for microphone permission.";
  setCameraError("");
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const stream = new MediaStream([
      ...cameraStream.getVideoTracks(),
      ...microphoneStream.getAudioTracks(),
    ]);
    const type = supportedVideoType();
    recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    recordingChunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordingChunks.push(event.data);
    });
    recorder.addEventListener("stop", saveRecording, { once: true });
    recorder.start();
    recordingIndicator.hidden = false;
    cameraStatus.textContent = "Recording video. Tap Stop video when you are done.";
    updateQuotas();
  } catch (error) {
    if (microphoneStream) microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
    recorder = null;
    setCameraError(error?.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow microphone access to record video, then try again."
      : "Video could not start. Check camera and microphone access, then try again.");
    cameraStatus.textContent = "Video is not recording.";
    updateQuotas();
  }
}

async function saveRecording() {
  recordingIndicator.hidden = true;
  if (microphoneStream) {
    microphoneStream.getTracks().forEach((track) => track.stop());
    microphoneStream = null;
  }
  const activeRecorder = recorder;
  recorder = null;
  if (!recordingChunks.length) {
    cameraStatus.textContent = "No video was recorded. Try again when ready.";
    updateQuotas();
    return;
  }

  const blob = new Blob(recordingChunks, { type: activeRecorder?.mimeType || "video/webm" });
  recordingChunks = [];
  if (currentCount("video") >= VIDEO_LIMIT) {
    cameraStatus.textContent = "Your 3-video limit is full. Delete a video to make room.";
    updateQuotas();
    return;
  }
  try {
    await addMedia("video", blob);
    await loadMedia();
    cameraStatus.textContent = `Video saved. ${currentCount("video")} of ${VIDEO_LIMIT} videos used.`;
  } catch (error) {
    if (error?.name === "QuotaExceededError") {
      await refreshAfterQuota("video");
    } else {
      cameraStatus.textContent = "The video could not be saved. Check available browser storage and try again.";
    }
  }
  updateQuotas();
}

function setGalleryKind(kind) {
  galleryKind = kind;
  showPhotos.classList.toggle("is-active", kind === "photo");
  showVideos.classList.toggle("is-active", kind === "video");
  showPhotos.setAttribute("aria-pressed", String(kind === "photo"));
  showVideos.setAttribute("aria-pressed", String(kind === "video"));
  renderGallery();
}

function revokeObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
}

function renderGallery() {
  revokeObjectUrls();
  galleryGrid.replaceChildren();
  const entries = media
    .filter((item) => item.kind === galleryKind)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-gallery";
    const message = document.createElement("p");
    message.textContent = galleryKind === "photo"
      ? "No photos yet. Allow camera access and take your first photo."
      : "No videos yet. Choose Video above and start recording when you are ready.";
    empty.append(message);
    galleryGrid.append(empty);
  }

  for (const item of entries) {
    const url = URL.createObjectURL(item.blob);
    objectUrls.push(url);
    const card = document.createElement("article");
    card.className = "media-card";
    card.setAttribute("aria-label", galleryKind === "photo" ? "Captured photo" : "Captured video");

    let preview;
    if (item.kind === "photo") {
      preview = document.createElement("img");
      preview.alt = "Photo captured in this Snapora session";
      preview.width = 720;
      preview.height = 960;
    } else {
      preview = document.createElement("video");
      preview.controls = true;
      preview.muted = true;
      preview.playsInline = true;
      preview.width = 720;
      preview.height = 960;
      preview.setAttribute("aria-label", "Captured video");
    }
    preview.className = "media-card__preview";
    preview.src = url;

    const meta = document.createElement("div");
    meta.className = "media-card__meta";
    const label = document.createElement("label");
    label.className = "media-card__select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedMedia.has(item.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedMedia.add(item.id);
      else selectedMedia.delete(item.id);
      updateSelection();
    });
    const selectionText = document.createElement("span");
    selectionText.textContent = "Select this capture";
    label.append(checkbox, selectionText);

    const saveLink = document.createElement("a");
    saveLink.className = "media-card__save";
    saveLink.href = url;
    saveLink.download = `snapora-${item.kind}-${item.id}.${fileExtension(item.blob.type, item.kind)}`;
    saveLink.textContent = item.kind === "photo" ? "Save photo" : "Save video";
    meta.append(label, saveLink);
    card.append(preview, meta);
    galleryGrid.append(card);
  }
  updateSelection();
}

function fileExtension(type, kind) {
  if (kind === "photo") return "jpg";
  if (type.includes("mp4")) return "mp4";
  return "webm";
}

function updateSelection() {
  const availableIds = new Set(media.map((item) => item.id));
  selectedMedia = new Set([...selectedMedia].filter((id) => availableIds.has(id)));
  deleteSelected.disabled = selectedMedia.size === 0;
  deleteSelected.textContent = selectedMedia.size
    ? `Delete selected (${selectedMedia.size})`
    : "Delete selected";
}

async function loadMedia() {
  const items = await storeRequest("readonly", (store) => store.getAll());
  media = items.filter((item) => item.sessionId === sessionId);
  updateQuotas();
  renderGallery();
}

async function removeSelected() {
  if (!selectedMedia.size) return;
  deleteSelected.disabled = true;
  const ids = [...selectedMedia];
  try {
    await Promise.all(ids.map((id) => storeRequest("readwrite", (store) => store.delete(id))));
    selectedMedia.clear();
    await loadMedia();
    galleryStatus.textContent = `${ids.length} capture${ids.length === 1 ? "" : "s"} deleted. You can capture again.`;
  } catch {
    galleryError.textContent = "Selected captures could not be deleted. Try again.";
    galleryError.hidden = false;
    deleteSelected.disabled = selectedMedia.size === 0;
  }
}

function setStorageError(message) {
  galleryError.textContent = message;
  galleryError.hidden = false;
  galleryStatus.textContent = "Your saved captures could not be loaded.";
}

async function refreshAfterQuota(kind) {
  try {
    await loadMedia();
  } catch (error) {
    setStorageError(error?.message || "Your saved captures could not be loaded.");
  }
  cameraStatus.textContent = kind === "photo"
    ? "Your 10-photo limit is full. Delete a photo to make room."
    : "Your 3-video limit is full. Delete a video to make room.";
}

cameraToggle.addEventListener("click", () => {
  if (cameraStream) stopCamera();
  else startCamera();
});

photoMode.addEventListener("click", () => setMode("photo"));
videoMode.addEventListener("click", () => setMode("video"));
captureAction.addEventListener("click", () => {
  if (recorder?.state === "recording") recorder.stop();
  else if (activeKind === "photo") takePhoto();
  else startRecording();
});
showPhotos.addEventListener("click", () => setGalleryKind("photo"));
showVideos.addEventListener("click", () => setGalleryKind("video"));
deleteSelected.addEventListener("click", removeSelected);

async function initialize() {
  try {
    sessionId = getSessionId();
    if (!window.indexedDB) throw new Error("This browser does not support local media storage.");
    database = await openDatabase();
    await loadMedia();
    galleryStatus.textContent = media.length
      ? `${media.length} capture${media.length === 1 ? "" : "s"} saved in this session.`
      : "Your captures will appear here.";
  } catch (error) {
    setStorageError(error?.message || "Local storage is unavailable. Try another browser.");
    cameraToggle.disabled = true;
  }
  updateQuotas();
}

window.addEventListener("pagehide", () => {
  if (recorder?.state === "recording") recorder.stop();
  stopCamera();
  revokeObjectUrls();
});

initialize();
