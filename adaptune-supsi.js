// index2.js
// Plain & simple mode (NO scene-context cues):
// - Scenarios: office, workout, date
// - Scenario decided by posture_hint + motion_level (local) + an optional pose check for workout resting
// - Workout moods: cardio, resting
// - Office/Date moods: model chooses from enums with confidence + notes
//
// Changes requested:
// 1) Workout: cardio/resting.
//    - AI detected: if arms are raised, it's a workout.
// 2) Avoid re-pasting API key: saved in localStorage (and optional embedded key constant).
// 3) Office: base mood chill; tense only when angry. Anti-flip so tense doesn't trigger too easily.

const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const PERF = {
  checkEveryMs: IS_MOBILE ? 1200 : 1500,
  camWidth: IS_MOBILE ? 640 : 1280,
  camHeight: IS_MOBILE ? 360 : 720,
  burstCount: IS_MOBILE ? 2 : 3,
  burstSpacingMs: IS_MOBILE ? 220 : 550,
  jpegQuality: IS_MOBILE ? 0.62 : 0.82,
  maxCapWidth: IS_MOBILE ? 640 : 1280,
  maxCapHeight: IS_MOBILE ? 360 : 720
};

const CHECK_EVERY_MS = PERF.checkEveryMs;

// ---- OPTIONAL (LOCAL-ONLY) EMBEDDED KEY ----
// Paste here ONLY for local demos. Do NOT commit this to a public repo.
const EMBEDDED_API_KEY = "sk....."; // 

// Mood labels
const OFFICE_MOODS = ["focused", "break"];
const DATE_MOODS = ["romantic", "date-gone-wrong"];
const WORKOUT_MOODS = ["active", "resting"];

// ----- DOM -----
const video = document.getElementById("video");
// apiKeyInput, rememberKey, showKey are removed from HTML as we use embedded key

const statusText = document.getElementById("statusText");
const countdownText = document.getElementById("countdownText");
const scenarioOut = document.getElementById("scenarioOut");
const moodOut = document.getElementById("moodOut");
const notesOut = document.getElementById("notesOut");
const confFill = document.getElementById("confFill");
const confText = document.getElementById("confText");
const hintText = document.getElementById("hintText");

// Pupils removed in Big Eye design
const buddyContainer = document.querySelector(".buddyContainer");

const blobBody = document.getElementById("blobBody");

const debugDrawer = document.getElementById("debugDrawer");
const drawerPanel = document.getElementById("drawerPanel");
const drawerToggle = document.getElementById("drawerToggle");

const permissionOverlay = document.getElementById("permissionOverlay");
const allowBtn = document.getElementById("allowBtn");

// ----- State -----
let stream = null;
let isSending = false;

let lastScenario = null;
let lastMood = null;

// (Motion streaks removed)

// ----- Soundtrack Manager -----
class SoundtrackManager {
  constructor() {
    this.tracks = {
      'office_focus': 'assets/sounds/office-focus.mp3',
      'office_chill': 'assets/sounds/office-break.mp3',
      'date_romantic': 'assets/sounds/Date_romantic.mp3',
      'date_awkward': 'assets/sounds/date-gone-wrong.mp3',
      'workout_active': 'assets/sounds/Workout_active.mp3',
      'workout_rest': 'assets/sounds/workout-rest.mp3'
    };
    this.audioObjects = {};
    this.currentTrackKey = null;
    this.fadeDuration = 2000; // 2 seconds
    this.fadeIntervals = {};
    this.fadeRaf = {};            // key -> requestAnimationFrame id
    this.transitionToken = 0;     // increments each transition
    this.crossfadeMs = 1200;      // crossfade duration (tweakable)
    this.lastSwitchAt = 0;
    this.switchCooldownMs = 1500;
  }

  preload() {
    for (const [key, path] of Object.entries(this.tracks)) {
      const audio = new Audio(path);
      audio.loop = true;
      audio.volume = 0;
      this.audioObjects[key] = audio;
      console.log(`[Soundtrack] Preloaded: ${key} (${path})`);
    }
  }

  async unlock() {
    console.log("[Soundtrack] Unlocking audio for mobile...");
    const promises = Object.values(this.audioObjects).map(audio => {
      audio.muted = true;
      return audio.play().then(() => {
        audio.pause();
        audio.muted = false;
        audio.currentTime = 0;
      }).catch(e => {
        console.warn("[Soundtrack] Unlock failed for a track:", e);
      });
    });
    await Promise.all(promises);
    console.log("[Soundtrack] Audio unlocked.");
  }

  getTrackKey(scenario, mood) {
    if (scenario === 'office') {
      if (mood === 'focused' || mood === 'tense') return 'office_focus';
      return 'office_chill';
    }
    if (scenario === 'date') {
      return (mood === 'romantic') ? 'date_romantic' : 'date_awkward';
    }
    if (scenario === 'workout') {
      if (mood === 'active') return 'workout_active';
      return 'workout_rest';
    }
    return null;
  }

  stopAllExcept(keepKey) {
    for (const [k, audio] of Object.entries(this.audioObjects)) {
      if (keepKey && k === keepKey) continue;

      // cancel animation frame fades
      if (this.fadeRaf[k]) {
        cancelAnimationFrame(this.fadeRaf[k]);
        delete this.fadeRaf[k];
      }

      // stop audio immediately
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 0;
      } catch (e) { }

      // clear any running fade intervals (legacy)
      if (this.fadeIntervals[k]) {
        clearInterval(this.fadeIntervals[k]);
        delete this.fadeIntervals[k];
      }
    }
  }

  fadeTrack(key, targetVolume, pauseAtEnd = false, token = null) {
    const audio = this.audioObjects[key];
    if (!audio) return;

    if (this.fadeRaf[key]) {
      cancelAnimationFrame(this.fadeRaf[key]);
      delete this.fadeRaf[key];
    }

    const startVol = Number.isFinite(audio.volume) ? audio.volume : 0;
    const startTime = performance.now();
    const duration = this.crossfadeMs;
    const myToken = token;

    const tick = (now) => {
      if (myToken !== null && myToken !== this.transitionToken) return;

      const t = Math.min(1, (now - startTime) / duration);
      const v = startVol + (targetVolume - startVol) * t;
      audio.volume = Math.max(0, Math.min(1, v));

      if (t < 1) {
        this.fadeRaf[key] = requestAnimationFrame(tick);
      } else {
        delete this.fadeRaf[key];
        if (pauseAtEnd && targetVolume === 0) {
          try { audio.pause(); audio.currentTime = 0; } catch (e) { }
          audio.volume = 0;
        }
      }
    };

    this.fadeRaf[key] = requestAnimationFrame(tick);
  }

  async transitionTo(key) {
    if (!key) return;
    if (this.currentTrackKey === key) return;

    const now = Date.now();
    if (now - this.lastSwitchAt < this.switchCooldownMs) return;
    this.lastSwitchAt = now;

    const oldKey = this.currentTrackKey;
    this.currentTrackKey = key;

    this.transitionToken++;
    const token = this.transitionToken;

    if (oldKey) this.stopAllExcept(oldKey);
    else this.stopAllExcept(null);

    const newAudio = this.audioObjects[key];
    const oldAudio = oldKey ? this.audioObjects[oldKey] : null;

    if (newAudio) {
      try {
        // Skip silent intro for office_focus track (starts at 20s)
        newAudio.currentTime = (key === 'office_focus') ? 20 : 0;
        newAudio.volume = 0;
        await newAudio.play();
      } catch (e) {
        console.warn("[Soundtrack] play() failed:", e);
      }
      this.fadeTrack(key, 1, false, token); // fade in
    }

    // In case oldKey somehow still exists, ensure it's not playing.
    if (oldAudio && oldKey && oldKey !== key) {
      // fade out (pause at end), but stopAllExcept already prevents stacking
      this.fadeTrack(oldKey, 0, true, token);
    }
  }
}

const soundtrack = new SoundtrackManager();
soundtrack.preload();

let nextCheckAt = Date.now() + CHECK_EVERY_MS;
let countdownTimer = null;
let checkTimer = null;

// Offscreen capture canvas (for sending frames to API)
const capCanvas = document.createElement("canvas");
const capCtx = capCanvas.getContext("2d");

// (Tiny canvases for heuristics removed)

// ----- Helpers -----
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function setStatus(text) {
  if (statusText) statusText.textContent = text;
}
function setCountdown(sec) {
  if (countdownText) countdownText.textContent = sec > 0 ? `00:${sec < 10 ? '0' : ''}${Math.floor(sec)}` : "Ready";
}
function setConfidence(conf01) {
  // Confidence bar removed in Korean Aurora redesign
}
function setResult({ scenario, mood, confidence, notes }) {
  if (scenarioOut) scenarioOut.textContent = scenario ?? "…";
  if (moodOut) moodOut.textContent = mood ?? "…";
  if (notesOut) notesOut.textContent = notes ?? "";

  // Set scenario on blobBody for color coding (Blue/Red/Green)
  if (blobBody) {
    blobBody.setAttribute("data-scenario", scenario ?? "unknown");
  }

  setConfidence(confidence);
}

// Pupil tracking removed for Big Eye aesthetic

// Buddy skin toggle logic removed - always blob now

// ----- Debug drawer -----
// ----- Debug drawer -----
function setDrawerOpen(open) {
  if (!drawerPanel) return;
  drawerPanel.classList.toggle("open", !!open);
  localStorage.setItem("debug_open", open ? "1" : "0");
}
drawerToggle?.addEventListener("click", () => {
  const open = !drawerPanel.classList.contains("open");
  setDrawerOpen(open);
});
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "d") {
    const open = !drawerPanel.classList.contains("open");
    setDrawerOpen(open);
  }
});

// ----- API key persistence -----
function loadSavedKey() {
  // Use embedded key primarily. LocalStorage is fallback for manual testing.
}
// UI persistence removed as UI elements are gone

// ----- Camera -----
async function ensureWebcamOn() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: PERF.camWidth, height: PERF.camHeight },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function grabFrameJpegDataUrl(quality = PERF.jpegQuality) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return "";

  // Compute scale so output fits within PERF.maxCapWidth/maxCapHeight
  const scale = Math.min(1, PERF.maxCapWidth / w, PERF.maxCapHeight / h);
  const outW = Math.floor(w * scale);
  const outH = Math.floor(h * scale);

  if (capCanvas.width !== outW || capCanvas.height !== outH) {
    capCanvas.width = outW;
    capCanvas.height = outH;
  }

  capCtx.drawImage(video, 0, 0, outW, outH);
  return capCanvas.toDataURL("image/jpeg", quality);
}

async function grabFrameBurst(count = PERF.burstCount, spacingMs = PERF.burstSpacingMs) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const url = grabFrameJpegDataUrl();
    if (url) frames.push(url);
    if (i < count - 1) await sleep(spacingMs);
  }
  return frames;
}

// ----- Motion + posture heuristics (no semantic context) -----
// (Heuristics removed - relying on OpenAI)

// (Local scenario logic removed)

// ----- OpenAI response parsing -----
function getResponseText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
            return c.text.trim();
          }
        }
      }
    }
  }
  return "";
}

// ----- Schema: social (office/date) -----
function buildSocialSchema() {
  const socialMoods = [...OFFICE_MOODS, ...DATE_MOODS];
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      scenario: { type: "string", enum: ["office", "date", "workout"] },
      mood: { type: "string", enum: [...OFFICE_MOODS, ...DATE_MOODS, ...WORKOUT_MOODS] },
      angry: { type: "boolean" }, // used to gate "tense"
      confidence: { type: "number", minimum: 0, maximum: 1 },
      notes: { type: "string" },
    },
    required: ["scenario", "mood", "angry", "confidence", "notes"],
  };
}

function buildInstructionTextForSocial() {
  return (
    `You are classifying a short webcam burst (3 frames). You MUST ignore all room/object context.\n` +
    `Use ONLY facial/body vibe and interaction cues.\n\n` +
    `Task:\n` +
    `Choose scenario "office", "date", or "workout", then choose ONE mood for that scenario.\n\n` +
    `OFFICE moods (STRICTLY for EXACTLY ONE person and focused/relaxed pose):\n${OFFICE_MOODS.map(t => `- ${t}`).join("\n")}\n` +
    `DATE moods (STRICTLY for EXACTLY TWO people):\n${DATE_MOODS.map(t => `- ${t}`).join("\n")}\n` +
    `WORKOUT moods (STRICTLY for EXACTLY ONE person doing physical activity):\n${WORKOUT_MOODS.map(t => `- ${t}`).join("\n")}\n\n` +
    `Rules:\n` +
    `- "workout": **STRICTLY ONE PERSON ONLY.**\n` +
    `  - **CRITICAL AUTOMATIC RULE: If the user has their arms raised (above head or out wide like a jump), it is AUTOMATICALLY "workout".**\n` +
    `  - "active": Performing intensive exercise (jumping, fast arms, arms raised).\n` +
    `  - "resting": Standing/looking tired after exercise, hands on hips (arms akimbo), catching breath.\n` +
    `- "office": **STRICTLY ONE PERSON ONLY.**\n` +
    `  - "focused": Concentrated, seated, still.\n` +
    `  - "break": drinking water or coffee. (Not intensive exercise). If hands on hips, it's not office break, but workout rest!\n` +
    `- "date": **STRICTLY EXACTLY TWO PEOPLE.**\n` +
    `- **CRITICAL DISAMBIGUATION**:\n` +
    `  - If arms are raised => ALWAYS "workout".\n` +
    `  - If 2 people => ALWAYS "date".\n` +
    `- Write the 'notes' in a fun, casual, and informal tone. Emojis welcome! Keep it short and cheeky.\n` +
    `Return ONLY JSON matching the schema.`
  );
}

// (Resting pose check removed)

async function callOpenAI({ apiKey, schemaObj, instructionText, frames, model = "gpt-4.1-mini" }) {
  const imageParts = frames.map((u) => ({ type: "input_image", image_url: u }));

  const payload = {
    model,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: instructionText }, ...imageParts],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "out",
        schema: schemaObj,
        strict: true,
      },
    },
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error("OpenAI error payload:", data);
    throw new Error(data?.error?.message || `HTTP ${resp.status}`);
  }

  const t = getResponseText(data);
  if (!t) throw new Error("No output text in response.");
  try {
    return JSON.parse(t);
  } catch {
    throw new Error("Model output was not valid JSON.");
  }
}

function applyResult({ scenario, mood, confidence, notes }) {
  const changed = lastScenario !== null && (scenario !== lastScenario || mood !== lastMood);
  lastScenario = scenario;
  lastMood = mood;

  setResult({
    scenario,
    mood: changed ? `${mood} (changed)` : mood,
    confidence,
    notes,
  });

  // Update buddy scenario & mood classes for specific eye expressions
  if (buddyContainer) {
    buddyContainer.className = `buddyContainer buddy ${scenario} ${mood}`;
  }

  // Track Transition
  const trackKey = soundtrack.getTrackKey(scenario, mood);
  if (trackKey) soundtrack.transitionTo(trackKey);

  setStatus("...");
  if (hintText) hintText.textContent = `Next check in ~${(CHECK_EVERY_MS / 1000).toFixed(0)}s.`;
}

// ----- Main loop -----
async function classifyOnce() {
  if (isSending) return;
  isSending = true;

  // API key source: embedded -> localStorage
  const apiKeyFromStorage = (localStorage.getItem("OPENAI_API_KEY") || "").trim();
  const apiKey = (EMBEDDED_API_KEY || apiKeyFromStorage).trim();

  if (!apiKey) {
    setStatus("Error: No API Key");
    if (hintText) hintText.textContent = "Please set EMBEDDED_API_KEY in the script file.";
    isSending = false;
    return;
  }

  // Remove UI syncing logic as inputs are gone
  // persistKeyMaybe();

  try {
    await ensureWebcamOn();
  } catch {
    setStatus("Camera blocked");
    if (hintText) hintText.textContent = "Click anywhere to allow camera access (browser permission).";
    isSending = false;
    return;
  }

  try {
    const frames = await grabFrameBurst(3, 550);
    if (!frames.length) {
      setStatus("Warming up");
      if (hintText) hintText.textContent = "Waiting for camera frames…";
      isSending = false;
      return;
    }

    setStatus("Thinking...");

    const parsed = await callOpenAI({
      apiKey,
      schemaObj: buildSocialSchema(),
      instructionText: buildInstructionTextForSocial(),
      frames,
    });

    console.log("parsed", parsed);

    if (parsed.scenario !== "office" && parsed.scenario !== "date" && parsed.scenario !== "workout") {
      throw new Error(`Invalid scenario from model: ${parsed.scenario}`);
    }

    // Ensure mood matches chosen scenario
    if (parsed.scenario === "office" && !OFFICE_MOODS.includes(parsed.mood)) {
      throw new Error(`Invalid office mood: ${parsed.mood}`);
    }
    if (parsed.scenario === "date" && !DATE_MOODS.includes(parsed.mood)) {
      throw new Error(`Invalid date mood: ${parsed.mood}`);
    }
    if (parsed.scenario === "workout" && !WORKOUT_MOODS.includes(parsed.mood)) {
      throw new Error(`Invalid workout mood: ${parsed.mood}`);
    }

    // Office Bias/Gate: tense only if angry
    let mood = parsed.mood;
    let scenario = parsed.scenario;

    if (scenario === "office") {
      const angry = !!parsed.angry;
      if (mood === "tense") {
        if (!angry || (parsed.confidence ?? 0) < 0.65) mood = "break";
      }
    }

    console.log(`[AI Decision] Scenario: ${scenario}, Mood: ${mood} (Conf: ${parsed.confidence.toFixed(2)})`);
    console.log(`[AI Reasoning] ${parsed.notes}`);

    applyResult({
      scenario: scenario,
      mood,
      confidence: parsed.confidence,
      notes: parsed.notes,
    });
  } catch (err) {
    setStatus("Error");
    const msg = String(err?.message || err);
    if (hintText) hintText.textContent = msg;
    if (notesOut) notesOut.textContent = msg;
  } finally {
    isSending = false;
  }
}

function scheduleLoop() {
  if (countdownTimer) clearInterval(countdownTimer);
  if (checkTimer) clearTimeout(checkTimer);

  async function scheduleNextCheck() {
    nextCheckAt = Date.now() + CHECK_EVERY_MS;
    try {
      await classifyOnce();
    } catch (e) {
      console.error("[Loop] classifyOnce error:", e);
    }
    // Self-scheduling loop: ensures stability and prevents accumulation on slow phones
    checkTimer = setTimeout(scheduleNextCheck, CHECK_EVERY_MS);
  }

  // UI countdown timer (independent of when classifyOnce finishes)
  countdownTimer = setInterval(() => {
    setCountdown(Math.max(0, (nextCheckAt - Date.now()) / 1000));
  }, 100);

  scheduleNextCheck();
}

async function boot() {
  setStatus("...");
  setCountdown(CHECK_EVERY_MS / 1000);
  setResult({ scenario: "…", mood: "…", confidence: 0, notes: "..." });

  // Restore UI prefs
  loadSavedKey();
  const debugOpen = (localStorage.getItem("debug_open") || "0") === "1";
  setDrawerOpen(debugOpen);

  const startApp = async () => {
    try {
      if (permissionOverlay) permissionOverlay.style.display = 'none';
      setStatus("Starting...");

      // CRITICAL: Unlock audio FIRST while we are still in the synchronous 
      // block of the user gesture (the button click).
      await soundtrack.unlock();
      await ensureWebcamOn();

      setStatus("...");
      if (hintText) hintText.textContent = "Camera is live. Mood checks running.";

      await classifyOnce();
      scheduleLoop();
    } catch (e) {
      console.error("[Boot] Start failed:", e);
      setStatus("Error");
      if (hintText) hintText.textContent = "Permission denied or error: " + e.message;
    }
  };

  if (allowBtn) {
    allowBtn.addEventListener("click", startApp);
  } else {
    // Fallback if UI is missing
    window.addEventListener("pointerdown", startApp, { once: true });
    window.addEventListener("keydown", startApp, { once: true });
  }
}

boot();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    soundtrack.stopAllExcept(null); // stop everything
    soundtrack.currentTrackKey = null;
  }
});
