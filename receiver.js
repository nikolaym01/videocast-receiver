// VideoCast's Cast receiver: Google's player (CAF) with a faster start, a quiet idle screen and
// diagnostics sent back to the Mac. VideoCast loads media with the same LOAD/SEEK messages as on the
// Default Media Receiver, so nothing changes on the sender side.

const NAMESPACE = "urn:x-cast:com.videocast";
const RECEIVER_VERSION = "11";
const STATS_EVERY_MS = 10000;

const context = cast.framework.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
const logger = cast.debug.CastDebugLogger.getInstance();
const idle = document.getElementById("idle");


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

function snapshot() {
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
  };
}

setInterval(() => {
  if (player.getPlayerState() !== cast.framework.messages.PlayerState.IDLE) report("stats", snapshot());
}, STATS_EVERY_MS);

const Event = cast.framework.events.EventType;
for (const type of [Event.BUFFERING, Event.ERROR, Event.MEDIA_FINISHED, Event.SEEKING, Event.SEEKED, Event.REQUEST_LOAD]) {
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

player.setMessageInterceptor(cast.framework.messages.MessageType.PLAY, (request) => {
  const state = player.getPlayerState();
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
const castPlayer = document.querySelector("cast-media-player");
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
  seekbar.classList.add("shown");
  // Google's own paused bar would show under ours.
  castPlayer.classList.add("seeking");
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
  setTimeout(() => {
    seekFrame.removeAttribute("src");
    castPlayer.classList.remove("seeking");
  }, 300);
}

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

function showLoading(title, startTime) {
  loadingTitle.textContent = title || "";
  loadingDetail.textContent = startTime > 1 ? `Resuming at ${clock(startTime)}` : "Starting…";
  backdrop.style.backgroundImage = thumbnails ? `url("${thumbnails}t${Math.round((startTime > 1 ? startTime : 60) / 5) * 5}.jpg")` : "";
  idle.className = "mode-loading";
}

setInterval(() => {
  const x = Math.round((Math.random() - 0.5) * 60);
  const y = Math.round((Math.random() - 0.5) * 40);
  home.style.transform = `translate(${x}px, ${y}px)`;
}, 30000);

showHome();
player.addEventListener(Event.PLAYER_LOAD_COMPLETE, () => idle.classList.add("hidden"));
player.addEventListener(Event.MEDIA_FINISHED, showHome);
player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
  showPrompt(null);
  const custom = request.media && request.media.customData;
  thumbnails = (custom && custom.thumbnails) || null;
  const title = request.media && request.media.metadata && request.media.metadata.title;
  // A picture (VideoCast's preview frame while converting) shows on the player itself.
  if (request.media && /^image\//.test(request.media.contentType || "")) {
    idle.classList.add("hidden");
  } else {
    showLoading(title, request.currentTime || 0);
  }
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

context.addEventListener(cast.framework.system.EventType.READY, () => report("ready", { version: RECEIVER_VERSION, errors: startupErrors }));
context.start(options);
