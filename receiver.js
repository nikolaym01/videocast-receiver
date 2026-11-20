// VideoCast's Cast receiver: Google's player framework (CAF) playing into our own <video>, with a faster start,
// our own screens and diagnostics sent back to the Mac. VideoCast loads media with the same LOAD/SEEK messages as on the
// Default Media Receiver, so nothing changes on the sender side.

const NAMESPACE = "urn:x-cast:com.videocast";
const RECEIVER_VERSION = "26";
const STATS_EVERY_MS = 10000;

const context = cast.framework.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
const logger = cast.debug.CastDebugLogger.getInstance();
const idle = document.getElementById("idle");

// Our own <video> instead of Google's <cast-media-player> (ROADMAP, "Our own on-screen interface", step 1,
// receiver 25): CAF keeps its protocol (LOAD / SEEK / status, so VideoCast doesn't change) but draws nothing of
// its own; pause, buffering and errors are ours to show. index.html is cached by the Chromecast, so an old copy
// may still hold Google's element: it goes before CAF starts.
for (const old of document.querySelectorAll("cast-media-player")) old.remove();
const video = document.createElement("video");
video.id = "film";
// Load at once, also paused: a start mid-film loads paused and seeks first, and with the default preload Chrome
// suspended the paused player, so that seek never finished (receiver 25, tv-check 2026-11-20 19:01: no SEEKED,
// no sound until a pause and ▶). Google's element loads the same way.
video.preload = "auto";
document.body.prepend(video);
player.setMediaElement(video);


// Start playing once a few seconds are buffered (the default waits far longer on HLS).
const playback = new cast.framework.PlaybackConfig();
playback.autoResumeDuration = 2;
playback.autoPauseDuration = 1;
playback.initialBandwidth = 8000000;

const options = new cast.framework.CastReceiverOptions();
options.playbackConfig = playback;
options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
options.disableIdleTimeout = false;
options.maxInactivity = 3600;

// MARK: Messages to the Mac

/** Sends to every connected sender (VideoCast is normally the only one). */
function report(type, data) {
  try {
    context.sendCustomMessage(NAMESPACE, undefined, { type, time: Date.now(), ...data });
  } catch (error) {
    // No sender connected (e.g. the Mac is asleep): nothing to tell.
  }
}

// MARK: Picture against sound
// The <video>'s clock follows the sound; requestVideoFrameCallback says which frame is actually shown. Their
// difference is how far the picture is behind the sound (positive) or ahead (negative), sent with the stats.
// Added 2026-11-19 after the sound ran ~2 s behind on "Кит" and nothing in the stats showed it. If the old
// Chromecast lacks the callback or never calls it, avProbe says so and there is no number.
let avVideo = null;
let avSamples = [];
let avProbe = "not started";
function findVideo() {
  return video;
}
function watchFrames() {
  try {
    const video = findVideo();
    if (!video) { if (avProbe === "not started") avProbe = "no video element"; return; }
    if (!video.requestVideoFrameCallback) { avProbe = "no requestVideoFrameCallback"; return; }
    if (video === avVideo) return;
    avVideo = video;
    avProbe = "ok";
    const onFrame = (now, frame) => {
      if (!video.paused && !video.seeking) {
        avSamples.push(video.currentTime - frame.mediaTime);
        if (avSamples.length > 120) avSamples.shift();
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } catch (error) {
    avProbe = "error: " + error.message;
  }
}
// Checked over DevTools on our Chromecast (Chrome 90, CrKey 1.56) on 2026-11-19: the shadow root is open and the
// callback exists, but it never fires while the film plays (the video goes to a hardware plane, past the page's
// compositor). So the probe reports that instead of a number; our own <video> doesn't change that.
function avOffsetMs() {
  if (avProbe === "ok" && avSamples.length === 0 && avVideo && !avVideo.paused && avVideo.currentTime > 0) {
    avProbe = "no frame callbacks (hardware video plane)";
  }
  if (avSamples.length < 10) return null;
  const sorted = avSamples.slice().sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 1000);
}

function snapshot() {
  watchFrames();
  const stats = player.getStats ? player.getStats() : {};
  const media = player.getMediaInformation();
  return {
    state: player.getPlayerState(),
    position: Math.round(player.getCurrentTimeSec() * 10) / 10,
    duration: media ? media.duration : null,
    droppedFrames: stats.droppedFrames,
    decodedFrames: stats.decodedFrames,
    bufferingTime: stats.bufferingTime,
    playTime: stats.playTime,
    width: stats.width,
    height: stats.height,
    bandwidth: stats.estimatedBandwidth,
    avProbe,
    avOffsetMs: avOffsetMs(),
  };
}

setInterval(() => {
  if (player.getPlayerState() !== cast.framework.messages.PlayerState.IDLE) report("stats", snapshot());
}, STATS_EVERY_MS);

const Event = cast.framework.events.EventType;
// TIME_DRIFTED: CAF's reported time doesn't match what state and rate predict (added 2026-11-19, looking for
// what goes wrong when sound and picture part).
for (const type of [Event.BUFFERING, Event.ERROR, Event.MEDIA_FINISHED, Event.SEEKING, Event.SEEKED, Event.REQUEST_LOAD, Event.TIME_DRIFTED].filter(Boolean)) {
  player.addEventListener(type, (event) => {
    const detail = {};
    if (event.isBuffering !== undefined) detail.buffering = event.isBuffering;
    if (event.detailedErrorCode !== undefined) detail.error = event.detailedErrorCode;
    if (event.error) detail.reason = String(event.error.reason || event.error);
    if (event.currentMediaTime !== undefined) detail.mediaTime = event.currentMediaTime;
    report("event", { event: type, ...detail, ...snapshot() });
  });
}

// MARK: Remote control scanner

// The TV's remote reaches the player through HDMI-CEC as media commands; skip buttons arrive only if the
// player says it handles a queue (next/previous), so claim it and report what comes.
// Anything failing here must not stop the receiver from starting: report it instead.
const startupErrors = [];
try {
  const Command = cast.framework.messages.Command;
  player.setSupportedMediaCommands(
    Command.ALL_BASIC_MEDIA | Command.QUEUE_NEXT | Command.QUEUE_PREV | Command.SEEK,
    true,
  );
} catch (error) {
  startupErrors.push("supported commands: " + error);
}
for (const type of ["QUEUE_UPDATE", "QUEUE_NEXT", "QUEUE_PREV", "SKIP_AD"]) {
  try {
    const messageType = cast.framework.messages.MessageType[type];
    if (!messageType) continue;
    player.setMessageInterceptor(messageType, (request) => {
      report("command", { command: type, data: JSON.stringify(request).slice(0, 200) });
      // Nothing queued yet: answer skips without doing anything.
      return null;
    });
  } catch (error) {
    startupErrors.push(type + ": " + error);
  }
}

// Everything a remote can reach the player with: media requests (from VideoCast, from the TV over HDMI-CEC,
// from Google Home) with who sent them, and raw key presses on the page. Reported to the Mac, so we can see
// which buttons of the TV's remote arrive at all.
const Category = cast.framework.events.category;
player.addEventListener(Category.REQUEST, (event) => {
  report("request", {
    request: event.type,
    sender: event.senderId || null,
    data: event.requestData ? JSON.stringify(event.requestData).slice(0, 200) : null,
  });
});
for (const kind of ["keydown", "keyup"]) {
  document.addEventListener(kind, (event) => {
    report("key", { kind, key: event.key, code: event.code, keyCode: event.keyCode });
  }, true);
}

// MARK: ▶ on the TV remote while playing

// The TV's remote reaches us only with ▶ ‖ ■ (HDMI-CEC). ▶ while already playing means "go on": do what the
// prompt on screen says, or, without a prompt, let VideoCast play the next episode. Holding the button repeats
// it every ~0.3 s, so presses within 1.5 s count once. On pause, ▶ resumes as usual.
const prompt = document.getElementById("prompt");
let promptAction = null;
let lastGoOn = 0;

/** A prompt with an action shows the remote's ▶ as its key; one without (e.g. a note) is plain text. */
function showPrompt(text, action) {
  promptAction = text ? action || null : null;
  prompt.replaceChildren();
  if (text) {
    if (promptAction) {
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = "▶";
      prompt.append(key);
    }
    prompt.append(document.createTextNode(text));
  }
  prompt.classList.toggle("plain", !promptAction);
  prompt.classList.toggle("shown", Boolean(text));
}

// MARK: Picking up after a break

// After a long pause, or resuming a film the next day, a few seconds are played again so the scene is fresh
// (VideoCast steps back on resume, we on unpausing), and a quiet note says so, so it doesn't look like a fault.
let pausedAt = 0;
let introEnd = null;
let noteTimer = null;

function stepBack(pause) {
  if (pause < 300000) return 0;
  if (pause < 3600000) return 5;
  if (pause < 86400000) return 10;
  return 20;
}

function showNote(text) {
  showPrompt(text);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    if (!promptAction && prompt.textContent === text) showPrompt(null);
  }, 3500);
}

function rewoundNote(seconds) {
  return `Replaying the last ${seconds} s`;
}

player.addEventListener(Event.PAUSE, () => { pausedAt = Date.now(); });
player.addEventListener(Event.SEEKING, () => { avSamples = []; });
player.addEventListener(Event.REQUEST_LOAD, () => { avSamples = []; });
player.addEventListener(Event.PLAYING, () => watchFrames());
player.addEventListener(Event.PLAYING, () => { pausedAt = 0; });

/** On ▶ after a long pause: step back first, still paused, and play once the seek is done (true if so).
 * Seeking while play starts made the old Chromecast run sound ~2 s behind the picture until the next load
 * (2026-11-19, "Кит", after an 8.7-minute pause: PLAY and SEEK 19 ms apart), as at the start (receiver 18). */
let pickUpTimer = 0;
function pickUp() {
  if (!pausedAt) return false;
  const back = stepBack(Date.now() - pausedAt);
  pausedAt = 0;
  const now = player.getCurrentTimeSec();
  let target = Math.max(0, now - back);
  if (introEnd !== null && now >= introEnd && target < introEnd - 2) target = Math.min(now, introEnd - 2);
  const seconds = Math.round(now - target);
  if (seconds < 1) return false;
  report("remote", { action: "pick-up", seconds });
  pickUpTimer = setTimeout(pickedUp, 4000);
  player.seek(target);
  showNote(rewoundNote(seconds));
  return true;
}

function pickedUp() {
  if (!pickUpTimer) return;
  clearTimeout(pickUpTimer);
  pickUpTimer = 0;
  setTimeout(() => player.play(), 200);
}
player.addEventListener(Event.SEEKED, () => pickedUp());

player.setMessageInterceptor(cast.framework.messages.MessageType.PLAY, (request) => {
  const state = player.getPlayerState();
  if (state === cast.framework.messages.PlayerState.PAUSED && pickUp()) return null;
  if (state !== cast.framework.messages.PlayerState.PLAYING) return request;
  const now = Date.now();
  if (now - lastGoOn > 1500) {
    report("remote", { action: promptAction || "next", prompted: Boolean(promptAction) });
    showPrompt(null);
  }
  lastGoOn = now;
  return null;
});

// MARK: Holding ‖ fast-forwards

// The first ‖ pauses as usual. Held on, the remote repeats it ~3 times a second: after about a second each
// repeat adds time, faster the longer it's held (5 s, then 10 s after 3 s, then 20 s after 8 s). Meanwhile the
// screen shows the timeline with where the film will land and a frame from there (VideoCast makes them). On
// release the film jumps there once (a converted stream restarts on every seek, so not on each repeat) and
// plays on, from the frame that was on screen when the button was let go (the time keeps counting while the
// frame loads, and a release is only noticed when the repeats stop). Held past the end, it lands on the last seconds, so the end is seen; VideoCast then goes on to
// the next episode as at any end.
const HOLD_REPEATS_BEFORE_SEEKING = 3;
const END_SECONDS_SHOWN = 8;
let pauseRepeats = 0;
let lastPause = 0;
let holdStarted = 0;
let holdSeconds = 0;
let holdTimer = null;
let frameTimer = null;
let thumbnails = null;
let frameTime = null;   // the film time of the frame on screen

const seekbar = document.getElementById("seekbar");
const seekFrame = document.getElementById("seek-frame");
const seekTimes = document.getElementById("seek-times");
const seekPlayed = document.getElementById("seek-played");
const seekTarget = document.getElementById("seek-target");
seekFrame.addEventListener("load", () => { frameTime = Number(seekFrame.dataset.time); });

function holdStep(heldFor) {
  if (heldFor < 3000) return 5;
  if (heldFor < 8000) return 10;
  return 20;
}

function clock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Where a fast-forward of `seconds` lands: never past the last few seconds. */
function landing(seconds) {
  const media = player.getMediaInformation();
  const duration = media && media.duration;
  const target = player.getCurrentTimeSec() + seconds;
  return duration ? Math.min(target, Math.max(0, duration - END_SECONDS_SHOWN)) : target;
}

function showSeekbar(seconds) {
  const media = player.getMediaInformation();
  const duration = media && media.duration;
  const now = player.getCurrentTimeSec();
  const target = landing(seconds);
  seekTimes.textContent = duration ? `${clock(target)} / ${clock(duration)}` : clock(target);
  if (duration) {
    seekPlayed.style.width = `${(now / duration) * 100}%`;
    seekTarget.style.left = `${(target / duration) * 100}%`;
    seekFrame.style.left = `${Math.min(Math.max((target / duration) * 100, 12), 88)}%`;
  }
  seekbar.classList.remove("paused");
  seekbar.classList.add("shown");
  // A frame from there, at most four times a second, rounded to 5 s so they're reused.
  if (thumbnails && !frameTimer) {
    frameTimer = setTimeout(() => {
      frameTimer = null;
      const time = Math.round(landing(holdSeconds) / 5) * 5;
      seekFrame.dataset.time = time;
      seekFrame.src = `${thumbnails}t${time}.jpg`;
    }, 250);
  }
}

function hideSeekbar() {
  seekbar.classList.remove("shown");
  clearTimeout(frameTimer);
  frameTimer = null;
  frameTime = null;
  setTimeout(() => seekFrame.removeAttribute("src"), 300);
}

// MARK: Paused

// A stopgap until the pause screen of step 2: the same timeline, at where the film stopped, after a moment (a
// quick ‖ ▶ doesn't flash it). Not over our loading screen, and the fast-forward takes the bar over.
let pausedTimer = null;
function showPaused() {
  clearTimeout(pausedTimer);
  pausedTimer = setTimeout(() => {
    if (player.getPlayerState() !== cast.framework.messages.PlayerState.PAUSED) return;
    if (loading || startPaused || holdSeconds || !idle.classList.contains("hidden")) return;
    const media = player.getMediaInformation();
    const duration = media && media.duration;
    const now = player.getCurrentTimeSec();
    seekTimes.textContent = duration ? `${clock(now)} / ${clock(duration)}` : clock(now);
    seekPlayed.style.width = duration ? `${(now / duration) * 100}%` : "0";
    seekbar.classList.add("paused", "shown");
  }, 600);
}
function hidePaused() {
  clearTimeout(pausedTimer);
  if (seekbar.classList.contains("paused")) seekbar.classList.remove("shown", "paused");
}
player.addEventListener(Event.PAUSE, showPaused);
player.addEventListener(Event.PLAYING, hidePaused);
player.addEventListener(Event.SEEKING, hidePaused);
player.addEventListener(Event.REQUEST_LOAD, hidePaused);
player.addEventListener(Event.MEDIA_FINISHED, hidePaused);

player.setMessageInterceptor(cast.framework.messages.MessageType.PAUSE, (request) => {
  const now = Date.now();
  const repeating = now - lastPause < 700;
  lastPause = now;
  if (!repeating) {
    pauseRepeats = 0;
    holdSeconds = 0;
    holdStarted = now;
    return request;
  }
  pauseRepeats += 1;
  if (pauseRepeats > HOLD_REPEATS_BEFORE_SEEKING) {
    holdSeconds += holdStep(now - holdStarted);
    showSeekbar(holdSeconds);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      const seen = frameTime !== null && frameTime > player.getCurrentTimeSec() ? frameTime : null;
      const target = seen !== null ? Math.min(seen, landing(holdSeconds)) : landing(holdSeconds);
      report("remote", { action: "fast-forward", seconds: holdSeconds, to: target });
      holdSeconds = 0;
      player.seek(target);
      player.play();
      setTimeout(hideSeekbar, 600);
    }, 550);
  }
  return null;
});

// MARK: Idle and loading screens

// Built here rather than in index.html, which the Chromecast caches: "home" (the app's icon and name, drifting a
// little every 30 s so a screen left on doesn't burn in) and "loading" (a dimmed frame from where the film will
// start, its title and what's happening, with a running line).
idle.innerHTML = `
  <div class="home"><img class="logo" src="icon.png?v=${RECEIVER_VERSION}" alt=""><div class="name">VideoCast</div></div>
  <div class="loading">
    <div class="backdrop"></div>
    <div class="caption"><div class="title"></div><div class="detail"></div><div class="running"><div></div></div></div>
  </div>
  <div id="version">r${RECEIVER_VERSION}</div>`;
const home = idle.querySelector(".home");
const backdrop = idle.querySelector(".backdrop");
const loadingTitle = idle.querySelector(".title");
const loadingDetail = idle.querySelector(".detail");

function showHome() {
  idle.className = "mode-home";
}

function showLoading(title, startTime, detail) {
  loadingTitle.textContent = title || "";
  loadingDetail.textContent = detail || (startTime > 1 ? `Resuming at ${clock(startTime)}` : "Starting…");
  backdrop.style.backgroundImage = thumbnails ? `url("${thumbnails}t${Math.round((startTime > 1 ? startTime : 60) / 5) * 5}.jpg")` : "";
  idle.className = "mode-loading";
}

setInterval(() => {
  const x = Math.round((Math.random() - 0.5) * 60);
  const y = Math.round((Math.random() - 0.5) * 40);
  home.style.transform = `translate(${x}px, ${y}px)`;
}, 30000);

showHome();
// The loading screen stays until the picture really moves: resuming, CAF loads from the start, reports PLAYING,
// then seeks and buffers again, and hiding earlier showed Google's spinner and bar in between. So it goes once the
// film's time has run on for a moment while playing.
let rewoundOnLoad = 0;
let loading = false;
let loadingFrom = null;
function loaded(why) {
  if (!loading) return;
  loading = false;
  report("event", { event: "LOADING_SCREEN_HIDDEN", why, mediaTime: player.getCurrentTimeSec() });
  // A cut, not a fade: the old Chromecast redraws the blurred frame in pieces while fading, and the sound has
  // already started.
  idle.classList.add("instant", "hidden");
  backdrop.style.backgroundImage = "";
  setTimeout(() => idle.classList.remove("instant"), 100);
  if (rewoundOnLoad) showNote(rewoundNote(rewoundOnLoad));
  rewoundOnLoad = 0;
}
player.addEventListener(Event.PLAYER_LOAD_COMPLETE, () => { loading = true; loadingFrom = null; });
player.addEventListener(Event.SEEKING, () => { loadingFrom = null; });
// The player's own clock (the event's field isn't filled on every device), checked on its time updates and
// four times a second besides; the state isn't checked: sound already plays while CAF still says BUFFERING.
function checkMoving() {
  if (!loading) return;
  const time = player.getCurrentTimeSec();
  if (typeof time !== "number" || isNaN(time)) return;
  if (loadingFrom === null) loadingFrom = time;
  else if (time - loadingFrom >= 0.2) loaded("moving");
}
player.addEventListener(Event.TIME_UPDATE, checkMoving);
setInterval(checkMoving, 250);
// Loaded paused, nothing moves by itself: show the player.
player.addEventListener(Event.PAUSE, () => { if (!startPaused && !showingPicture) loaded("paused"); });

// Resuming mid-film, CAF starts playing at once and only then seeks there: the old Chromecast played the sound
// ~2 s before the first picture (2026-11-18). So such a load starts paused; once the seek is done (SEEKED; at
// worst after 4 s) the loading screen goes, the frame at the spot shows, and then it plays.
let startPaused = false;
let startTimer = null;
let showingPicture = false;
function startNow(why) {
  if (!startPaused) return;
  startPaused = false;
  clearTimeout(startTimer);
  report("event", { event: "START_AFTER_SEEK", why, mediaTime: player.getCurrentTimeSec() });
  // The picture first: the paused frame at the spot shows, then it plays (by ear the sound still led by 1–2 s
  // when the screen waited for the time to move).
  loaded("seeked");
  setTimeout(() => player.play(), 400);
}
player.addEventListener(Event.SEEKED, () => { if (startPaused) setTimeout(() => startNow("seeked"), 100); });
player.addEventListener(Event.PLAYER_LOAD_COMPLETE, () => {
  if (startPaused) startTimer = setTimeout(() => startNow("timeout"), 4000);
});
// Never stuck behind the loading screen.
player.addEventListener(Event.PLAYER_LOAD_COMPLETE, () => setTimeout(() => { if (!showingPicture) loaded("timeout"); }, 15000));
// Only a real end: replacing the media (VideoCast's preview picture by the stream) "finishes" it too.
player.addEventListener(Event.MEDIA_FINISHED, (event) => {
  if (event && event.endedReason && event.endedReason !== "END_OF_STREAM") return;
  showHome();
});
player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
  showPrompt(null);
  const custom = request.media && request.media.customData;
  thumbnails = (custom && custom.thumbnails) || null;
  rewoundOnLoad = (custom && custom.rewound) || 0;
  introEnd = custom && typeof custom.introEnd === "number" ? custom.introEnd : null;
  pausedAt = 0;
  startPaused = (request.currentTime || 0) > 1 && request.autoplay !== false;
  if (startPaused) request.autoplay = false;
  const title = request.media && request.media.metadata && request.media.metadata.title;
  // A picture is VideoCast's stand-in while it converts the film: our loading screen says so instead, until the
  // stream comes.
  showingPicture = Boolean(request.media && /^image\//.test(request.media.contentType || ""));
  if (showingPicture) startPaused = false;
  showLoading(title, request.currentTime || 0, showingPicture ? "Preparing…" : null);
  return request;
});

// MARK: Commands from the Mac

context.addCustomMessageListener(NAMESPACE, (message) => {
  const data = message.data || {};
  switch (data.type) {
    case "debug":
      // On-screen log of everything the player does, for looking at problems on the TV itself.
      logger.setEnabled(Boolean(data.on));
      logger.showDebugLogs(Boolean(data.on));
      report("debug", { on: Boolean(data.on) });
      break;
    case "prompt":
      // E.g. {text: "Next episode — press ▶", action: "next"}; no text hides it.
      showPrompt(data.text, data.action);
      break;
    case "ping":
      report("pong", { version: RECEIVER_VERSION, ...snapshot() });
      break;
  }
});

// MARK: What this device plays
// Asked of the device itself at start and sent with "ready", so VideoCast keeps a profile of it (REFACTORING.md
// §3) instead of constants. canDisplayType also knows what the TV behind it takes (AC3/E-AC3 passthrough). Added
// in receiver 24.
const CANDIDATES = {
  "h264-1080p": ["video/mp4", "avc1.640028", 1920, 1080, 30],
  "h264-1080p60": ["video/mp4", "avc1.64002A", 1920, 1080, 60],
  "h264-2160p": ["video/mp4", "avc1.640033", 3840, 2160, 30],
  "hevc-1080p": ["video/mp4", "hev1.1.6.L120.90", 1920, 1080, 30],
  "hevc-2160p": ["video/mp4", "hev1.1.6.L150.90", 3840, 2160, 30],
  "hevc-10bit": ["video/mp4", "hev1.2.4.L120.90", 1920, 1080, 30],
  "vp9-1080p": ["video/webm", "vp09.00.40.08", 1920, 1080, 30],
  "av1-1080p": ["video/mp4", "av01.0.08M.08", 1920, 1080, 30],
  "aac": ["audio/mp4", "mp4a.40.2"],
  "ac3": ["audio/mp4", "ac-3"],
  "eac3": ["audio/mp4", "ec-3"],
  "opus": ["audio/webm", "opus"],
  "flac": ["audio/mp4", "flac"],
};
function capabilities() {
  const result = {};
  for (const [name, [mime, codec, width, height, rate]] of Object.entries(CANDIDATES)) {
    try {
      result[name] = width ? context.canDisplayType(mime, codec, width, height, rate) : context.canDisplayType(mime, codec);
    } catch (error) {
      result[name] = null;
    }
  }
  return result;
}

context.addEventListener(cast.framework.system.EventType.READY, () => report("ready", { version: RECEIVER_VERSION, errors: startupErrors, capabilities: capabilities() }));
context.start(options);
