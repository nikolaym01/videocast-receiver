// VideoCast's Cast receiver: Google's player (CAF) with a faster start, a quiet idle screen and
// diagnostics sent back to the Mac. VideoCast loads media with the same LOAD/SEEK messages as on the
// Default Media Receiver, so nothing changes on the sender side.

const NAMESPACE = "urn:x-cast:com.videocast";
const RECEIVER_VERSION = "7";
const STATS_EVERY_MS = 10000;

const context = cast.framework.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
const logger = cast.debug.CastDebugLogger.getInstance();
const idle = document.getElementById("idle");
const idleDetail = document.getElementById("idle-detail");
document.getElementById("version").textContent = `r${RECEIVER_VERSION}`;

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

function showPrompt(text, action) {
  promptAction = text ? action || null : null;
  prompt.textContent = text || "";
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
// repeat adds time, faster the longer it's held (5 s, then 10 s after 3 s, then 20 s after 8 s), shown on
// screen. On release the film jumps there once (a converted stream restarts on every seek, so not on each
// repeat) and plays on. Held past the end, VideoCast goes on to the next episode, or near the end of a film.
const HOLD_REPEATS_BEFORE_SEEKING = 3;
let pauseRepeats = 0;
let lastPause = 0;
let holdStarted = 0;
let holdSeconds = 0;
let holdTimer = null;

function holdStep(heldFor) {
  if (heldFor < 3000) return 5;
  if (heldFor < 8000) return 10;
  return 20;
}

function formatSkip(seconds) {
  if (seconds < 60) return `+${seconds} s`;
  return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
    showPrompt(`⏩ ${formatSkip(holdSeconds)}`);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      const media = player.getMediaInformation();
      const duration = media && media.duration;
      const target = player.getCurrentTimeSec() + holdSeconds;
      const pastEnd = Boolean(duration) && target >= duration - 3;
      report("remote", { action: "fast-forward", seconds: holdSeconds, to: target, pastEnd });
      holdSeconds = 0;
      setTimeout(() => showPrompt(null), 800);
      // Past the end VideoCast decides: the next episode, or near the end of a film.
      if (pastEnd) return;
      player.seek(target);
      player.play();
    }, 700);
  }
  return null;
});

// MARK: Idle screen

player.addEventListener(Event.PLAYER_LOAD_COMPLETE, () => idle.classList.add("hidden"));
player.addEventListener(Event.MEDIA_FINISHED, () => {
  idleDetail.textContent = "";
  idle.classList.remove("hidden");
});
player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (request) => {
  showPrompt(null);
  const title = request.media && request.media.metadata && request.media.metadata.title;
  idleDetail.textContent = title ? `${title}…` : "";
  // A picture (VideoCast's preview frame) shows on the player itself.
  if (request.media && /^image\//.test(request.media.contentType || "")) idle.classList.add("hidden");
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
