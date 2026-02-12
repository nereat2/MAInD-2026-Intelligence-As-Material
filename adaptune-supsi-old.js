// index2.js
// Plain & simple mode (NO scene-context cues):
// - Scenarios: office, workout, date
// - Scenario decided by posture_hint + motion_level (local) + an optional pose check for workout resting
// - Workout moods: cardio, resting
// - Office/Date moods: model chooses from enums with confidence + notes
//
// Changes requested:
// 1) Workout: only cardio/resting. Fix resting being misrouted into office.
//    - If standing => workout always.
//    - If unknown posture + low motion => try "resting pose" quick check; if positive => workout/resting.
//    - Otherwise social.
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
const EVIDENCE_SLEEP = IS_MOBILE ? 120 : 250;

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

// Tense gating memory (prevents quick flip to tense)
let lastOfficeAngry = false;

// Streak for local workout trigger
let workoutMotionStreak = 0;
const STREAK_THRESHOLD = 2; // Need 2 consecutive 'high' motion hits (~3 seconds)

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

// Tiny canvases for motion/posture heuristics
const tinyA = document.createElement("canvas");
const tinyB = document.createElement("canvas");
const tinyCtxA = tinyA.getContext("2d", { willReadFrequently: true });
const tinyCtxB = tinyB.getContext("2d", { willReadFrequently: true });

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
function computeMotionScoreBetweenCanvases(ctx1, ctx2, w, h) {
  const a = ctx1.getImageData(0, 0, w, h).data;
  const b = ctx2.getImageData(0, 0, w, h).data;
  let sum = 0;
  const n = w * h;

  for (let i = 0; i < a.length; i += 4) {
    const y1 = (a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114);
    const y2 = (b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114);
    sum += Math.abs(y1 - y2);
  }
  return sum / (n * 255);
}

function estimatePostureFromDiff(ctx1, ctx2, w, h) {
  const a = ctx1.getImageData(0, 0, w, h).data;
  const b = ctx2.getImageData(0, 0, w, h).data;

  let total = 0;
  let yMoment = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const y1 = (a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114);
      const y2 = (b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114);
      const d = Math.abs(y1 - y2);
      total += d;
      yMoment += d * y;
    }
  }

  if (total < w * h * 1.5) {
    return { posture_hint: "unknown", posture_confidence: 0.2 };
  }

  const centroidY = yMoment / total;
  const normY = centroidY / h;

  let hint = "unknown";
  let conf = 0.35;

  if (normY < 0.52) {
    hint = "seated";
    conf = clamp((0.52 - normY) / 0.20, 0.35, 0.95);
  } else if (normY > 0.60) {
    hint = "standing";
    conf = clamp((normY - 0.60) / 0.25, 0.35, 0.95);
  } else {
    hint = "unknown";
    conf = 0.35;
  }

  return { posture_hint: hint, posture_confidence: conf };
}

async function computeEvidence() {
  const W = 96, H = 54;
  tinyA.width = W; tinyA.height = H;
  tinyB.width = W; tinyB.height = H;

  tinyCtxA.drawImage(video, 0, 0, W, H);
  await sleep(EVIDENCE_SLEEP);
  tinyCtxB.drawImage(video, 0, 0, W, H);

  const s1 = computeMotionScoreBetweenCanvases(tinyCtxA, tinyCtxB, W, H);
  const p1 = estimatePostureFromDiff(tinyCtxA, tinyCtxB, W, H);

  await sleep(EVIDENCE_SLEEP);
  tinyCtxA.drawImage(video, 0, 0, W, H);

  const s2 = computeMotionScoreBetweenCanvases(tinyCtxB, tinyCtxA, W, H);
  const p2 = estimatePostureFromDiff(tinyCtxB, tinyCtxA, W, H);

  const motion_score = (s1 + s2) / 2;

  let motion_level = "low";
  if (motion_score > 0.14) motion_level = "high"; // Balanced: sensitive but requires real effort
  else if (motion_score > 0.07) motion_level = "medium";

  console.log(`[Motion] score=${motion_score.toFixed(4)}, level=${motion_level}`);

  let posture_hint = "unknown";
  let posture_confidence = 0.2;

  if (p1.posture_hint !== "unknown" && p1.posture_confidence >= p2.posture_confidence) {
    posture_hint = p1.posture_hint;
    posture_confidence = p1.posture_confidence;
  } else if (p2.posture_hint !== "unknown") {
    posture_hint = p2.posture_hint;
    posture_confidence = p2.posture_confidence;
  } else {
    posture_hint = "unknown";
    posture_confidence = Math.max(p1.posture_confidence, p2.posture_confidence);
  }

  return { motion_score, motion_level, posture_hint, posture_confidence };
}

// ----- Scenario selection (no semantic context) -----
// Standing (confident) => workout always
// Seated (confident) => social
// Unknown:
//   - medium/high motion => workout (cardio)
//   - low motion => ambiguous: might be workout resting OR social chill
//
// To make workout/resting reachable & stable:
//   - If unknown+low, we run a quick "resting pose" check using the model.
//     If it sees "hands on hips / arms open / athletic rest stance", we treat as workout/resting.
function decideScenarioFromEvidence(ev) {
  // Always social if seated confidently
  if (ev.posture_hint === "seated" && ev.posture_confidence >= 0.45) {
    workoutMotionStreak = 0;
    return "social";
  }

  // Handle Workout Streak for fast (but consistent) local override
  if (ev.motion_level === "high") {
    workoutMotionStreak++;
  } else {
    workoutMotionStreak = 0;
  }

  // Only jump straight to workout if movement is intense AND consistent (> 2 seconds)
  if (workoutMotionStreak >= STREAK_THRESHOLD) {
    return "workout";
  }

  // Everything else (standing, moving, unknown) requires full AI semantic check to avoid confusion
  return "ambiguous_low";
}

function workoutMoodFromMotion(motion_level) {
  // Only high motion is active; medium/low is resting
  if (motion_level === "high") return "active";
  return "resting";
}

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

      motion_level: { type: "string", enum: ["low", "medium", "high"] },
      motion_score: { type: "number" },
      posture_hint: { type: "string", enum: ["seated", "standing", "unknown"] },
      posture_confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["scenario", "mood", "angry", "confidence", "notes", "motion_level", "motion_score", "posture_hint", "posture_confidence"],
  };
}

function buildInstructionTextForSocial(ev) {
  const ms = Number.isFinite(ev.motion_score) ? ev.motion_score.toFixed(4) : String(ev.motion_score);
  const pc = Number.isFinite(ev.posture_confidence) ? ev.posture_confidence.toFixed(2) : String(ev.posture_confidence);

  return (
    `You are classifying a short webcam burst (3 frames). You MUST ignore all room/object context.\n` +
    `Use ONLY facial/body vibe and interaction cues.\n\n` +
    `Measured by browser:\n` +
    `- motion_level="${ev.motion_level}", motion_score=${ms}\n` +
    `- posture_hint="${ev.posture_hint}", posture_confidence=${pc}\n\n` +
    `Task:\n` +
    `Choose scenario "office", "date", or "workout", then choose ONE mood for that scenario.\n\n` +
    `OFFICE moods (STRICTLY for EXACTLY ONE person and LOW/MEDIUM motion only):\n${OFFICE_MOODS.map(t => `- ${t}`).join("\n")}\n` +
    `DATE moods (STRICTLY for EXACTLY TWO people):\n${DATE_MOODS.map(t => `- ${t}`).join("\n")}\n` +
    `WORKOUT moods (STRICTLY for EXACTLY ONE person and HIGH motion active):\n${WORKOUT_MOODS.map(t => `- ${t}`).join("\n")}\n\n` +
    `Rules:\n` +
    `- "office": **STRICTLY ONE PERSON ONLY AND LOW/MEDIUM MOTION.**\n` +
    `  - "focused": ONE person, seated, still, concentrated. FAST arm movements or jumping are NOT office-focused.\n` +
    `  - "break": ONE person, stretching arms, drinking, or looking around. LOW/MEDIUM motion only. **CRITICAL: If you see INTENSIVE movement, it is NOT an office break.**\n` +
    `- "date": **STRICTLY EXACTLY TWO PEOPLE.**\n` +
    `- "workout": **STRICTLY ONE PERSON ONLY AND HIGH MOTION.**\n` +
    `  - "active": ONE person performing intensive exercise (jumping, fast arms).\n` +
    `- **CRITICAL DISAMBIGUATION**:\n` +
    `  - HIGH MOTION (score > 0.14) is ALWAYS "workout".\n` +
    `  - LOW/MEDIUM MOTION is "office" or "workout-resting".\n` +
    `  - If 1 person => Use ONLY "office" or "workout". Use "office-break" for stretching/drinking/looking around.\n` +
    `  - If 2 people => Use ONLY "date". Do NOT choose "office" or "workout" for 2 people.\n` +
    `  - If 3+ people => Default to "date" (group social) or "workout" if applicable, but never "office".\n` +
    `- Write the 'notes' in a fun, casual, and informal tone. Emojis welcome! Keep it short and cheeky.\n` +
    `- Copy motion_level, motion_score, posture_hint, posture_confidence exactly into JSON.\n` +
    `Return ONLY JSON matching the schema.`
  );
}

// ----- Schema: resting pose check (workout resting trigger) -----
function buildRestPoseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      resting_pose: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      notes: { type: "string" }
    },
    required: ["resting_pose", "confidence", "notes"]
  };
}

function buildInstructionTextForRestPose() {
  return (
    `You are checking a single webcam frame.\n` +
    `Ignore all room/object context.\n` +
    `Question: is the person STANDING UP and with their hands on their hips (arms akimbo)?\n` +
    `- If yes, set resting_pose=true.\n` +
    `- If not sure or seated, set resting_pose=false.\n` +
    `Write the 'notes' in a fun, casual style (e.g., "Catching a breather! ✨").\n` +
    `Return ONLY JSON.`
  );
}

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
    const ev = await computeEvidence();
    const frames = await grabFrameBurst(3, 550);
    if (!frames.length) {
      setStatus("Warming up");
      if (hintText) hintText.textContent = "Waiting for camera frames…";
      isSending = false;
      return;
    }

    const gate = decideScenarioFromEvidence(ev);
    setStatus("Thinking...");

    // --- WORKOUT ---
    if (gate === "workout") {
      // Use motion_score directly for mood to be more precise
      const mood = ev.motion_score > 0.12 ? "active" : "resting";
      const notes = mood === "active"
        ? "Look at you go! Absolute legend mode active. 🔥"
        : "Taking a well-deserved breather, I see. Rest is key! ✨";

      const conf =
        (ev.posture_hint === "standing" ? clamp(ev.posture_confidence, 0, 1) : 0.50) +
        (ev.motion_level === "high" ? 0.20 : ev.motion_level === "medium" ? 0.10 : 0);

      applyResult({
        scenario: "workout",
        mood,
        confidence: clamp(conf, 0, 1),
        notes,
      });

      isSending = false;
      return;
    }

    // --- AMBIGUOUS LOW MOTION: try resting pose to keep workout/resting reachable ---
    if (gate === "ambiguous_low") {
      if (hintText) hintText.textContent = "Low motion… checking for workout resting pose.";
      // Use just one fresh frame for the pose check
      const single = [frames[frames.length - 1]];
      const pose = await callOpenAI({
        apiKey,
        schemaObj: buildRestPoseSchema(),
        instructionText: buildInstructionTextForRestPose(),
        frames: single,
      });

      const restingPose = !!pose.resting_pose && (pose.confidence ?? 0) >= 0.55;
      if (restingPose) {
        const notes =
          `Resting pose detected (${Math.round((pose.confidence || 0) * 100)}%). ` +
          `posture=${ev.posture_hint}(${ev.posture_confidence.toFixed(2)}), motion=${ev.motion_level}(${ev.motion_score.toFixed(4)}).`;

        applyResult({
          scenario: "workout",
          mood: "resting",
          confidence: clamp(0.65 + (pose.confidence || 0) * 0.25, 0, 1),
          notes,
        });

        isSending = false;
        return;
      }

      // If not resting pose, treat as social (office/date)
      if (hintText) hintText.textContent = "Pose not detected. Deciding office vs date.";
    }

    // --- SOCIAL: model decides office vs date ---
    const parsed = await callOpenAI({
      apiKey,
      schemaObj: buildSocialSchema(),
      instructionText: buildInstructionTextForSocial(ev),
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

    // Office Bias/Gate: 
    // 1) tense only if angry
    // 2) NO break if motion is high (prevent confusion with workout)
    let mood = parsed.mood;
    let scenario = parsed.scenario;

    if (scenario === "office") {
      const angry = !!parsed.angry;
      lastOfficeAngry = angry;

      if (mood === "tense") {
        if (!angry || (parsed.confidence ?? 0) < 0.65) mood = "break";
      }

      // Safeguard: if AI says office-break but motion is high, it's a workout
      if (mood === "break" && ev.motion_level === "high") {
        console.log("[Gate] Overriding office-break to workout-active due to high motion.");
        scenario = "workout";
        mood = "active";
      }
    }

    console.log(`[AI Decision] Scenario: ${parsed.scenario}, Mood: ${mood} (Conf: ${parsed.confidence.toFixed(2)})`);
    console.log(`[AI Reasoning] ${parsed.notes}`);

    const notes =
      `${parsed.notes} ` +
      `(angry=${String(parsed.angry)}, posture=${ev.posture_hint}(${ev.posture_confidence.toFixed(2)}), ` +
      `motion=${ev.motion_level}(${ev.motion_score.toFixed(4)}))`;

    applyResult({
      scenario: scenario,
      mood,
      confidence: parsed.confidence,
      notes,
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
