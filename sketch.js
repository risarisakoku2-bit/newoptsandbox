// Gravity Sandbox - p5.js
// Multi-touch gravity wells pull particles; long press and pressure increase strength.

let particles = [];
let wells = {}; // id -> {x,y,strength, startTime, osc, env}
let audioAllowed = false; // set true after a user gesture resumes AudioContext
let testTonePlayed = false;
let waAudioCtx = null; // fallback WebAudio AudioContext
let startTimes = {}; // touch id -> timestamp for long-press
let virtualMouseX = 0;
let virtualMouseY = 0;
let pointerLocked = false;
const DEFAULT_PARTICLE_COUNT = 600;
let particleCount = DEFAULT_PARTICLE_COUNT;
let maxWells = 6;
let idleNoiseScale = 0.002;
// spring constant controlling how quickly particles return to their home position
// smaller -> slower return
const HOME_SPRING_K = 0.0002;
// swirl factor adds perpendicular component to force so particles spiral (reduces strict axis-aligned motion)
const SWIRL_FACTOR = 0.45;
// Limits and damping to avoid strong pure-vertical/horizontal motion
const MAX_COMPONENT_SPEED = 2.0; // clamp per-component velocity
const AXIS_DAMPING_RATIO = 1.6; // how much larger one component must be to trigger damping
const AXIS_DAMPING_FACTOR = 0.55; // factor to reduce dominant axis velocity

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSB, 360, 100, 100, 100);
  initParticles(particleCount);
  background(0);
  noStroke();
  // hide system pointer (p5 helper)
  try { noCursor(); } catch (e) {}

  // Attempt to request Pointer Lock on first user gesture (helps hide system cursor in Chrome)
  try {
    const canvasEl = document.querySelector('canvas');
    if (canvasEl) {
      const requestLock = (e) => {
        try {
          if (canvasEl.requestPointerLock) {
            canvasEl.requestPointerLock();
            console.log('[pointer] requested pointer lock');
          }
        } catch (err) {
          console.warn('[pointer] requestPointerLock failed', err);
        }
      };
      // Use pointerdown to capture touch/pen/mouse; run once on first gesture
      canvasEl.addEventListener('pointerdown', requestLock, { once: true });

      // Log lock state changes
      document.addEventListener('pointerlockchange', () => {
        const locked = document.pointerLockElement === canvasEl;
        pointerLocked = locked;
        console.log('[pointer] pointerLock change: locked=', locked);
        // ensure cursor CSS hidden as well
        if (locked) {
          document.documentElement.style.cursor = 'none';
          canvasEl.style.cursor = 'none';
          // initialize virtual mouse at current mouse position or center
          virtualMouseX = (typeof mouseX === 'number') ? mouseX : width / 2;
          virtualMouseY = (typeof mouseY === 'number') ? mouseY : height / 2;
        } else {
          document.documentElement.style.cursor = '';
          canvasEl.style.cursor = '';
        }
      });

      // When pointer is locked, mousemove events provide relative movement (movementX/movementY)
      canvasEl.addEventListener('mousemove', (e) => {
        if (pointerLocked) {
          // update virtual pointer and clamp to canvas
          virtualMouseX = Math.max(0, Math.min(width, virtualMouseX + (e.movementX || 0)));
          virtualMouseY = Math.max(0, Math.min(height, virtualMouseY + (e.movementY || 0)));
        }
      });
    }
  } catch (e) {
    console.warn('[pointer] pointer lock setup failed', e);
  }
}

function initParticles(n) {
  particles = [];
  for (let i = 0; i < n; i++) {
    let px = random(width);
    let py = random(height);
    particles.push({
      x: px,
      y: py,
      vx: random(-0.5, 0.5),
      vy: random(-0.5, 0.5),
      hue: random(180, 300),
      age: random(0, 100),
      homeX: px, // original/home position
      homeY: py
    });
  }
}

function draw() {
  // Fade with a translucent rectangle to leave trails
  fill(0, 0, 0, 6);
  rect(0, 0, width, height);

  // Update wells from touches & mouse
  // wells already updated via touch handlers; but ensure mouse fallback
  if (touches.length === 0 && (mouseIsPressed)) {
    // If pointer is locked use virtualMouseX/Y (relative movement), otherwise use mouseX/mouseY
    const px = pointerLocked ? virtualMouseX : mouseX;
    const py = pointerLocked ? virtualMouseY : mouseY;
    wells['mouse'] = { x: px, y: py, strength: mouseIsPressed ? 3.0 : 0, startTime: millis() };
  }

  // particle physics
  for (let p of particles) {
    // idle motion when no wells
    if (Object.keys(wells).length === 0) {
      // small Perlin noise so particles don't look static
      let n = noise(p.x * idleNoiseScale, p.y * idleNoiseScale, frameCount * 0.002);
      p.vx += map(n, 0, 1, -0.02, 0.02);
      p.vy += map(n, 0, 1, -0.02, 0.02);

      // gentle restoring spring force toward home position
      // this makes particles drift back to initial layout naturally
      let dxh = p.homeX - p.x;
      let dyh = p.homeY - p.y;
      // spring coefficient (small) and damping based on distance
      let distHome2 = dxh * dxh + dyh * dyh;
      if (distHome2 > 0.01) {
        // apply gentle spring toward home; HOME_SPRING_K controls speed
        p.vx += dxh * HOME_SPRING_K;
        p.vy += dyh * HOME_SPRING_K;
      }
    }

    for (let id in wells) {
      let gw = wells[id];
      let dx = gw.x - p.x;
      let dy = gw.y - p.y;
      let d2 = dx * dx + dy * dy + 400; // softening constant to avoid huge forces
      let invDist = 1 / sqrt(d2);
  // direction unit vector
  let dirx = dx * invDist;
  let diry = dy * invDist;
  // perpendicular (rotational) unit vector to induce swirl: (-diry, dirx)
  let perpX = -diry;
  let perpY = dirx;
  // strength scales with well.strength and optionally particle mass (mass=1)
  let force = (gw.strength) / d2;
  // apply scaled force (small multiplier to keep stable)
  // main attraction
  p.vx += force * dirx * 150;
  p.vy += force * diry * 150;
  // swirl/rotational component to avoid purely axis-aligned motion
  p.vx += force * perpX * 40 * SWIRL_FACTOR;
  p.vy += force * perpY * 40 * SWIRL_FACTOR;
    }

    // damping
    p.vx *= 0.995;
    p.vy *= 0.995;

    // Prevent excessively axis-aligned fast motion:
    // 1) Clamp each velocity component so no large pure-axis spikes occur
    if (abs(p.vx) > MAX_COMPONENT_SPEED) p.vx = (p.vx > 0 ? MAX_COMPONENT_SPEED : -MAX_COMPONENT_SPEED);
    if (abs(p.vy) > MAX_COMPONENT_SPEED) p.vy = (p.vy > 0 ? MAX_COMPONENT_SPEED : -MAX_COMPONENT_SPEED);

    // 2) If one component is much larger than the other (axis-dominated), damp it
    let avx = abs(p.vx);
    let avy = abs(p.vy);
    if (avx > avy * AXIS_DAMPING_RATIO && avx > 0.4) {
      p.vx *= AXIS_DAMPING_FACTOR;
    }
    if (avy > avx * AXIS_DAMPING_RATIO && avy > 0.4) {
      p.vy *= AXIS_DAMPING_FACTOR;
    }

    // update
    p.x += p.vx;
    p.y += p.vy;

    // wrap
    if (p.x < 0) p.x += width;
    if (p.x > width) p.x -= width;
    if (p.y < 0) p.y += height;
    if (p.y > height) p.y -= height;

    // draw particle
    fill(p.hue, 80, 90, 85);
    circle(p.x, p.y, 2.2);
    p.age += 1;
  }

  // Update audio parameters for wells (frequency by x, amp by strength)
  for (let id in wells) {
    let g = wells[id];
    if (g.osc) {
      // map x to frequency range
      let freq = constrain(map(g.x, 0, width, 120, 1200), 80, 2000);
      // optionally modulate with y (adds timbral movement)
      let yMod = map(g.y, 0, height, 0.8, 1.2);
      let finalFreq = freq * yMod;
      try {
        g.osc.freq(finalFreq, 0.05);
        let amp = constrain(map(g.strength, 0, 6, 0, 0.6), 0, 0.8);
        g.osc.amp(amp, 0.08);
      } catch (e) {
        // ignore audio errors
      }
    } else if (g.waOsc && waAudioCtx) {
      // update WebAudio fallback: set freq and gain
      try {
        let freq = constrain(map(g.x, 0, width, 120, 1200), 80, 2000);
        g.waOsc.frequency.setTargetAtTime(freq, waAudioCtx.currentTime, 0.05);
        let amp = constrain(map(g.strength, 0, 6, 0, 0.6), 0, 0.8);
        // set gain with small smoothing
        g.waGain.gain.exponentialRampToValueAtTime(Math.max(amp, 0.0001), (waAudioCtx.currentTime || 0) + 0.05);
      } catch (e) {
        // ignore
      }
    }
  }

  // draw wells (visual feedback)
  // Wells affect particles but are intentionally not drawn (touch points invisible)
}

// Handle touches: create/update wells. Use identifier fallback.
function updateWellsFromTouches() {
  // Rebuild wells map, but limit number of wells
  let newWells = {};
  let count = 0;
  for (let i = 0; i < touches.length; i++) {
    if (count >= maxWells) break;
    let t = touches[i];
    // id fallback
    let id = (t.id !== undefined) ? t.id : (t.identifier !== undefined ? t.identifier : `${t.x}-${t.y}-${i}`);
    // compute base strength from pressure/force or duration
    let duration = 0;
    if (startTimes[id]) duration = (millis() - startTimes[id]) / 1000.0; // seconds
    let base = 2.0;
    // if force available (Safari on iOS supports force), use it
    let forceVal = (t.force !== undefined) ? t.force : 0;
    let strength = base + constrain(duration * 2.5, 0, 4) + (forceVal * 3.0);
    // reuse existing oscillator/env if present
    if (wells[id] && wells[id].osc) {
      newWells[id] = wells[id];
      newWells[id].x = t.x;
      newWells[id].y = t.y;
      newWells[id].strength = strength;
    } else {
      newWells[id] = { x: t.x, y: t.y, strength: strength, startTime: startTimes[id] || millis() };
      // create audio oscillator for this well only if audioAllowed; otherwise defer
      if (audioAllowed) {
        tryCreateOscillator(id, newWells[id]);
      } else {
        // mark that oscillator is pending
        newWells[id].osc = null;
        newWells[id].waOsc = null;
        console.log('[audio] oscillator deferred for', id);
      }
    }
    count++;
  }

  // Determine removed wells and stop their oscillators
  for (let oldId in wells) {
    if (!newWells[oldId]) {
      // stop oscillator gracefully
      if (wells[oldId].osc) {
        try {
          wells[oldId].osc.amp(0, 0.25);
          let stopOsc = wells[oldId].osc;
          setTimeout(() => { try { stopOsc.stop(); } catch (e) {} }, 300);
        } catch (e) {}
      }
      // stop WebAudio fallback
      if (wells[oldId].waOsc) {
        try {
          wells[oldId].waGain.gain.exponentialRampToValueAtTime(0.0001, (waAudioCtx.currentTime || 0) + 0.15);
          wells[oldId].waOsc.stop((waAudioCtx.currentTime || 0) + 0.2);
        } catch (e) {}
      }
    }
  }

  // assign newWells to wells
  wells = newWells;
}

// Create an oscillator and attach it to the well object
function tryCreateOscillator(id, wellObj) {
  // ensure AudioContext is started on user gesture (caller should have attempted resume)
  try {
    if (typeof p5 !== 'undefined' && typeof p5.Oscillator === 'function') {
      // p5.sound available
      try {
        let osc = new p5.Oscillator('sine');
        osc.start();
        osc.amp(0);
        // small envelope to smooth amplitude
        let env = new p5.Envelope();
        env.setADSR(0.01, 0.1, 0.2, 0.2);
        env.setRange(1.0, 0);
        wellObj.osc = osc;
        wellObj.env = env;
        console.log('[audio] created p5 oscillator for', id);
        return;
      } catch (e) {
        console.warn('[audio] p5 oscillator creation failed', e);
      }
    }
    // Fallback: use Web Audio API directly
    try {
      if (!waAudioCtx) {
        waAudioCtx = (window.AudioContext || window.webkitAudioContext) ? new (window.AudioContext || window.webkitAudioContext)() : null;
        if (waAudioCtx) console.log('[audio] created WebAudio AudioContext fallback');
      }
      if (waAudioCtx) {
        let oscNode = waAudioCtx.createOscillator();
        let gainNode = waAudioCtx.createGain();
        oscNode.type = 'sine';
        gainNode.gain.value = 0.0001;
        oscNode.connect(gainNode);
        gainNode.connect(waAudioCtx.destination);
        // start immediately (will be silent until gain raised)
        oscNode.start();
        wellObj.waOsc = oscNode;
        wellObj.waGain = gainNode;
        console.log('[audio] created WebAudio oscillator for', id);
        return;
      }
    } catch (e) {
      console.warn('[audio] WebAudio fallback failed', e);
    }
  } catch (e) {
    console.warn('[audio] tryCreateOscillator unexpected error', e);
  }
  // if all failed, leave oscillator fields null
  wellObj.osc = null;
  wellObj.waOsc = null;
}

function touchStarted() {
  // mark start times for long press
  for (let i = 0; i < touches.length; i++) {
    let t = touches[i];
    let id = (t.id !== undefined) ? t.id : (t.identifier !== undefined ? t.identifier : `${t.x}-${t.y}-${i}`);
    if (!startTimes[id]) startTimes[id] = millis();
  }

  // Try to enable audio on the first user gesture (some browsers block AudioContext)
  try {
    if (typeof userStartAudio === 'function') {
      // p5.sound helper that resumes audio
      userStartAudio();
      audioAllowed = true;
      console.log('[audio] userStartAudio() called - audioAllowed=', audioAllowed);
    } else if (typeof getAudioContext === 'function') {
      let ac = getAudioContext();
      if (ac && ac.state !== 'running') {
        // resume returns a promise; create oscillators after resume completes
        ac.resume().then(() => { audioAllowed = true; console.log('[audio] AudioContext resumed'); createOscForExistingWells(); if (!testTonePlayed) { playTestTone(); testTonePlayed = true; } }).catch((e) => { audioAllowed = false; console.warn('[audio] resume failed', e); });
      } else if (ac && ac.state === 'running') {
        audioAllowed = true;
        console.log('[audio] AudioContext already running');
        if (!testTonePlayed) { playTestTone(); testTonePlayed = true; }
      }
    }
  } catch (e) {
    audioAllowed = false;
  }

  // Ensure wells physics/state are updated; oscillator creation will occur if/when audioAllowed
  updateWellsFromTouches();
  return false; // prevent default
}

// Play a short test tone to confirm audio is enabled (no visual changes)
function playTestTone() {
  try {
    if (typeof p5 !== 'undefined' && typeof p5.Oscillator === 'function') {
      let osc = new p5.Oscillator('sine');
      let env = new p5.Envelope();
      env.setADSR(0.01, 0.05, 0.1, 0.1);
      env.setRange(0.6, 0);
      osc.start();
      osc.freq(440);
      env.play(osc);
      // stop oscillator after envelope
      setTimeout(() => { try { osc.stop(); } catch (e) {} }, 300);
      console.log('[audio] played test tone (p5)');
    } else if (waAudioCtx) {
      // WebAudio fallback
      try {
        let o = waAudioCtx.createOscillator();
        let g = waAudioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = 440;
        g.gain.value = 0.0001;
        o.connect(g);
        g.connect(waAudioCtx.destination);
        o.start();
        // ramp gain up and down
        let now = waAudioCtx.currentTime || 0;
        g.gain.exponentialRampToValueAtTime(0.6, now + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        setTimeout(() => { try { o.stop(); } catch (e) {} }, 350);
        console.log('[audio] played test tone (WebAudio)');
      } catch (e) {
        console.warn('[audio] test tone WebAudio failed', e);
      }
    } else {
      console.warn('[audio] cannot play test tone, no audio API available');
    }
  } catch (e) {
    console.warn('[audio] test tone failed', e);
  }
}

// Create oscillators for wells that don't have one yet (called after AudioContext resumes)
function createOscForExistingWells() {
  for (let id in wells) {
    if (!wells[id].osc) {
      tryCreateOscillator(id, wells[id]);
    }
  }
}

function touchMoved() {
  updateWellsFromTouches();
  return false;
}

function touchEnded() {
  // Clear startTimes for ended touches (we'll rebuild wells next)
  // Build a set of current ids
  let currentIds = new Set();
  for (let i = 0; i < touches.length; i++) {
    let t = touches[i];
    let id = (t.id !== undefined) ? t.id : (t.identifier !== undefined ? t.identifier : `${t.x}-${t.y}-${i}`);
    currentIds.add(id);
  }
  // remove any startTimes that are not current
  for (let k in startTimes) {
    if (!currentIds.has(k)) delete startTimes[k];
  }

  updateWellsFromTouches();
  return false;
}

// Mouse support for desktop testing
function mousePressed() {
  // simulate a long press start
  startTimes['mouse'] = millis();
}

function mouseReleased() {
  delete startTimes['mouse'];
  delete wells['mouse'];
}

function windowResized() {
  // preserve relative positions by scaling
  let oldW = width;
  let oldH = height;
  resizeCanvas(windowWidth, windowHeight);
  let sx = width / oldW;
  let sy = height / oldH;
  for (let p of particles) {
    p.x *= sx;
    p.y *= sy;
  }
}

// Optional helpers to change particle count at runtime
function keyPressed() {
  if (key === '1') { particleCount = 200; initParticles(particleCount); }
  if (key === '2') { particleCount = 400; initParticles(particleCount); }
  if (key === '3') { particleCount = 600; initParticles(particleCount); }
  if (key === '4') { particleCount = 1000; initParticles(particleCount); }
}
