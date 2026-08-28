/**
 * The team radio: who hears it, and what stops it talking over itself.
 *
 * The load-bearing test here is team gating. A line spoken for the wrong team
 * is not a desync — audio is presentation-only and cannot reach `stateHash` —
 * but it is free intelligence about where the enemy is being shot at, which
 * changes how the game is played. That is a design fault, and the only thing
 * preventing it is one comparison.
 *
 * The scheduler tests matter for a less obvious reason: `speechSynthesis.speak`
 * **queues**. It does not drop and it does not interrupt. Without a bounded,
 * dropping, priority-ordered queue in front of it, a thirty-second firefight
 * leaves the browser narrating for a minute afterwards.
 *
 * Dependency-free: `Chatter` takes its `speak` and its clock by injection, so
 * none of this needs a browser, an AudioContext or a voice.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chatter, CHATTER_LINES, referencedVoiceClasses } from '../src/audio/chatter.js';
import { VOICE_CLASSES, voiceClassFor, DEFAULT_VOICE_CLASS } from '../src/audio/radio.js';
import { VEHICLE_CATALOG } from '../src/vehicles/catalog.js';

/** A Chatter wired to a fake radio and a clock the test drives by hand. */
function harness({ autoFinish = true } = {}) {
  const said = [];
  const captions = [];
  let t = 0;
  const chatter = new Chatter({
    clock: () => t,
    onCaption: (line) => captions.push(line),
    speak: (text, opts) => {
      said.push({ text, voiceClass: opts.voiceClass });
      if (autoFinish) opts.onDone?.();
      return true;
    },
  });
  return {
    chatter, said, captions,
    advance: (seconds) => { t += seconds; },
    now: () => t,
  };
}

// --- team gating ----------------------------------------------------------

test('a line for another team is never spoken', () => {
  const h = harness();
  assert.equal(h.chatter.report('contact', { teamId: 1, localTeamId: 0 }), false);
  h.chatter.pump();
  assert.deepEqual(h.said, []);
});

test('a line for your own team is spoken', () => {
  const h = harness();
  assert.equal(h.chatter.report('contact', { teamId: 0, localTeamId: 0 }), true);
  h.chatter.pump();
  assert.ok(h.said.length > 0);
});

test('observe never reports another team’s events', () => {
  // The integration path, not just report(): observe() derives teamId from
  // localTeamId, so this pins that it cannot be handed a foreign team.
  const h = harness();
  h.chatter.observe({ localTeamId: 0, units: 2, structures: 1, dangerZones: 0, dangerNearBase: false, harvestersInDanger: 0 });
  h.chatter.observe({ localTeamId: 0, units: 2, structures: 1, dangerZones: 3, dangerNearBase: false, harvestersInDanger: 0 });
  for (const line of h.said) assert.ok(line.text.length > 0);
  // Switching team resets the baseline rather than reporting a huge delta.
  //
  // The clock is advanced first, and that matters: without it the global gap
  // between lines is what keeps `said` empty, and this assertion passes
  // whether or not the re-baseline exists. A negative control caught exactly
  // that — removing the re-baseline failed nothing until this advance was
  // added.
  h.said.length = 0;
  h.advance(60);
  h.chatter.observe({ localTeamId: 1, units: 99, structures: 99, dangerZones: 0, dangerNearBase: false, harvestersInDanger: 0 });
  assert.deepEqual(h.said, [], 'a team switch must re-baseline, not narrate the difference');
});

// --- the scheduler --------------------------------------------------------

test('a per-event cooldown suppresses a flood', () => {
  const h = harness();
  assert.equal(h.chatter.report('contact', { teamId: 0, localTeamId: 0 }), true);
  for (let i = 0; i < 20; i++) {
    assert.equal(h.chatter.report('contact', { teamId: 0, localTeamId: 0 }), false);
  }
  h.advance(CHATTER_LINES.contact.cooldownSeconds + 1);
  assert.equal(h.chatter.report('contact', { teamId: 0, localTeamId: 0 }), true);
});

test('the queue is bounded and drops the lowest priority, not the newest', () => {
  const h = harness({ autoFinish: false });
  // Fill with routine traffic, then land the one line that matters.
  h.chatter.enqueue({ event: 'unitReady', priority: 1, from: 'combat', text: 'low A' });
  h.chatter.enqueue({ event: 'unitReady', priority: 1, from: 'combat', text: 'low B' });
  h.chatter.enqueue({ event: 'unitReady', priority: 1, from: 'combat', text: 'low C' });
  h.chatter.enqueue({ event: 'baseUnderAttack', priority: 9, from: 'command', text: 'BASE' });

  assert.ok(h.chatter.queue.length <= 3, 'queue must stay bounded');
  assert.ok(h.chatter.queue.some((l) => l.text === 'BASE'), 'the important line must survive');
});

test('the highest priority is spoken first, not the oldest', () => {
  const h = harness();
  h.chatter.enqueue({ event: 'unitReady', priority: 1, from: 'combat', text: 'routine' });
  h.chatter.enqueue({ event: 'baseUnderAttack', priority: 9, from: 'command', text: 'urgent' });
  h.chatter.pump();
  assert.equal(h.said[0].text, 'urgent');
});

test('only one line is spoken at a time', () => {
  const h = harness({ autoFinish: false });
  h.chatter.enqueue({ event: 'a', priority: 5, from: 'command', text: 'first' });
  h.chatter.enqueue({ event: 'b', priority: 4, from: 'command', text: 'second' });
  h.chatter.pump();
  h.chatter.pump();
  assert.equal(h.said.length, 1, 'a second line must wait for the channel');
});

test('a global gap separates consecutive lines', () => {
  const h = harness();
  h.chatter.enqueue({ event: 'a', priority: 5, from: 'command', text: 'first' });
  h.chatter.enqueue({ event: 'b', priority: 4, from: 'command', text: 'second' });
  h.chatter.pump();
  h.chatter.pump(); // immediately after — still inside the gap
  assert.equal(h.said.length, 1);
  h.advance(5);
  h.chatter.pump();
  assert.equal(h.said.length, 2);
});

// --- exchanges ------------------------------------------------------------

test('an event with replies produces a two-part exchange from different crews', () => {
  // The user asked for units that speak *to each other*, which is what makes
  // this a radio net rather than a notification queue.
  const h = harness();
  h.chatter.report('contact', { teamId: 0, localTeamId: 0 });
  h.chatter.pump();
  h.advance(5);
  h.chatter.pump();
  assert.equal(h.said.length, 2, 'a call should be answered');
  assert.notEqual(h.said[0].voiceClass, h.said[1].voiceClass, 'the reply should come from another crew');
});

test('a caption is emitted for every spoken line', () => {
  // With no TTS voice installed the caption is the ONLY carrier of the
  // information, so a line that speaks without captioning is a silent loss.
  const h = harness();
  h.chatter.report('baseUnderAttack', { teamId: 0, localTeamId: 0 });
  h.chatter.pump();
  assert.equal(h.captions.length, h.said.length);
  assert.ok(h.captions[0].speaker);
  assert.ok(h.captions[0].text);
});

// --- data integrity -------------------------------------------------------

test('every line names a real voice class', () => {
  for (const cls of referencedVoiceClasses()) {
    assert.ok(VOICE_CLASSES[cls], `no voice class "${cls}"`);
  }
});

test('every event has calls, a priority and a cooldown', () => {
  for (const [event, spec] of Object.entries(CHATTER_LINES)) {
    assert.ok(spec.calls?.length, `${event} has no lines`);
    assert.equal(typeof spec.priority, 'number', `${event} has no priority`);
    assert.ok(spec.cooldownSeconds > 0, `${event} has no cooldown`);
  }
});

test('base under attack outranks every routine event', () => {
  const base = CHATTER_LINES.baseUnderAttack.priority;
  for (const [event, spec] of Object.entries(CHATTER_LINES)) {
    if (event === 'baseUnderAttack') continue;
    assert.ok(base > spec.priority, `${event} should not outrank the base alarm`);
  }
});

// --- voice classes from data that already exists --------------------------

test('every shipped vehicle resolves to a real voice class', () => {
  for (const def of VEHICLE_CATALOG) {
    const cls = voiceClassFor(def);
    assert.ok(VOICE_CLASSES[cls], `${def.id} resolved to "${cls}"`);
  }
});

test('the scout reads as recon, not as armour', () => {
  // scout-buggy is tagged ['recon', 'combat']; a naive first-match would make
  // it sound like a tank. The preference order lives in radio.js for this.
  const scout = VEHICLE_CATALOG.find((d) => d.id === 'scout-buggy');
  assert.equal(voiceClassFor(scout), 'recon');
});

test('a def with no usable tags falls back rather than throwing', () => {
  assert.equal(voiceClassFor(null), DEFAULT_VOICE_CLASS);
  assert.equal(voiceClassFor({}), DEFAULT_VOICE_CLASS);
  assert.equal(voiceClassFor({ tags: ['nonsense'] }), DEFAULT_VOICE_CLASS);
});
