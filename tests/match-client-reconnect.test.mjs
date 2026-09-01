/**
 * `MatchClient`'s bounded reconnect on an abnormal mid-match close.
 *
 * Found in a real production log: two genuinely distinct players, both
 * already past `[match] agreed ... at turn 0`, had their sockets closed with
 * `code=1006` (abnormal — no close frame, the connection itself was cut) —
 * one 1.7s after agreeing in one match, both players within ~20s in another.
 * No `4009` (the server's own deliberate same-user-replace close) appeared
 * anywhere in that log, ruling out the earlier reload/rejoin investigation's
 * mechanism as the cause here. Before this, `onClose` fired immediately on
 * *any* close and ended the match — a transient drop, which is exactly what
 * a flaky connection produces, had the identical outcome as a deliberate
 * kick: instant, with no attempt to recover.
 *
 * A fake WebSocket, not a real one — `MatchClient` only ever touches the
 * `WebSocket` constructor and the four event names, so a minimal stand-in
 * keeps this dependency-free (no jsdom, no real network) while still driving
 * the actual reconnect state machine in matchClient.js, not a copy of it.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__API_URL__ = 'http://api.example.test';

const { MatchClient, PROTOCOL_VERSION } = await import('../src/net/matchClient.js');

/**
 * Each `new FakeWebSocket(...)` call is recorded on `sockets`, so a test can
 * reach in and drive whichever one is "current" — exactly the ambiguity a
 * real reconnect has to resolve by always using `this.socket`, which this
 * exercises for real.
 */
function installFakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 1; // OPEN — these tests drive messages directly, no real handshake
      this.listeners = {};
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.emit('close', { code: 1000, reason: 'client close', wasClean: true });
    }
    emit(type, detail) {
      for (const fn of this.listeners[type] ?? []) fn(detail);
    }
    message(payload) {
      this.emit('message', { data: JSON.stringify(payload) });
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  return sockets;
}

function welcomeFor(overrides = {}) {
  return { t: 'welcome', matchId: 'm1', protocolVersion: PROTOCOL_VERSION, releasedTurn: -1, ...overrides };
}

test('connects, then survives an abnormal close by reconnecting', async () => {
  const sockets = installFakeWebSocket();
  const client = new MatchClient('m1', {});

  const connectPromise = client.connect();
  sockets[0].emit('open');
  sockets[0].message(welcomeFor());
  await connectPromise;

  assert.equal(sockets.length, 1);

  // Abnormal close — not the player's doing, not the server's.
  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false });

  // The retry is scheduled behind a timer (backoff), not immediate.
  assert.equal(sockets.length, 1, 'reconnect must not happen synchronously inside the close handler');

  await new Promise((r) => setTimeout(r, 1100)); // first attempt waits 1x base delay

  assert.equal(sockets.length, 2, 'a new socket should have been opened');
  assert.equal(client.socket, sockets[1], 'the client must be driving the new socket, not the dead one');
  client.close();
});

test('a resumed welcome after reconnect does not call onClose', async () => {
  const sockets = installFakeWebSocket();
  const closes = [];
  const client = new MatchClient('m1', { onClose: (ev) => closes.push(ev) });

  const connectPromise = client.connect();
  sockets[0].emit('open');
  sockets[0].message(welcomeFor());
  await connectPromise;

  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sockets.length, 2);

  sockets[1].emit('open');
  sockets[1].message(welcomeFor({ releasedTurn: 40 })); // the reconnect's own welcome

  assert.deepEqual(closes, [], 'a successful reconnect must never have surfaced onClose');
  client.close();
});

test('main.js\'s onWelcome contract: a reconnect welcome is usable to refresh match state', async () => {
  const sockets = installFakeWebSocket();
  const welcomes = [];
  const client = new MatchClient('m1', { onWelcome: (msg) => welcomes.push(msg) });

  const connectPromise = client.connect();
  sockets[0].emit('open');
  sockets[0].message(welcomeFor({ releasedTurn: -1 }));
  await connectPromise;

  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false });
  await new Promise((r) => setTimeout(r, 1100));
  sockets[1].emit('open');
  sockets[1].message(welcomeFor({ releasedTurn: 40 }));

  assert.equal(welcomes.length, 2, 'onWelcome must fire again on reconnect, not only once');
  assert.equal(welcomes[1].releasedTurn, 40, 'the reconnect welcome carries the fresh releasedTurn');
  client.close();
});

test('a clean close (1000) is never retried', async () => {
  const sockets = installFakeWebSocket();
  const closes = [];
  const client = new MatchClient('m1', { onClose: (ev) => closes.push(ev) });

  const connectPromise = client.connect();
  sockets[0].emit('open');
  sockets[0].message(welcomeFor());
  await connectPromise;

  sockets[0].emit('close', { code: 1000, reason: 'player left', wasClean: true });
  await new Promise((r) => setTimeout(r, 1100));

  assert.equal(sockets.length, 1, 'a clean close must not open a new socket');
  assert.equal(closes.length, 1, 'onClose must fire immediately for a clean close');
  client.close();
});

test('the server\'s own deliberate codes (4001/4003/4008/4009/4010) are never retried', async () => {
  for (const code of [4001, 4003, 4008, 4009, 4010]) {
    const sockets = installFakeWebSocket();
    const closes = [];
    const client = new MatchClient('m1', { onClose: (ev) => closes.push(ev) });

    const connectPromise = client.connect();
    sockets[0].emit('open');
    sockets[0].message(welcomeFor());
    await connectPromise;

    sockets[0].emit('close', { code, reason: 'server said so', wasClean: false });
    await new Promise((r) => setTimeout(r, 1100));

    assert.equal(sockets.length, 1, `code ${code} must not trigger a reconnect`);
    assert.equal(closes.length, 1, `code ${code} must surface onClose immediately`);
    client.close();
  }
});

test('giving up after the retry budget still calls onClose', async () => {
  const sockets = installFakeWebSocket();
  const closes = [];
  const client = new MatchClient('m1', { onClose: (ev) => closes.push(ev) });

  const connectPromise = client.connect();
  sockets[0].emit('open');
  sockets[0].message(welcomeFor());
  await connectPromise;

  // Every reconnect attempt itself fails abnormally too — a genuinely dead
  // match, not a one-off blip. Backoff is 1x/2x/3x the base delay per
  // attempt, so each wait below is sized to outlast that attempt's delay.
  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false });
  await new Promise((r) => setTimeout(r, 1100)); // attempt 1: 1000ms
  assert.equal(sockets.length, 2);

  sockets[1].emit('close', { code: 1006, reason: '', wasClean: false });
  await new Promise((r) => setTimeout(r, 2100)); // attempt 2: 2000ms
  assert.equal(sockets.length, 3);

  sockets[2].emit('close', { code: 1006, reason: '', wasClean: false });
  await new Promise((r) => setTimeout(r, 3100)); // attempt 3: 3000ms
  assert.equal(sockets.length, 4);
  assert.equal(closes.length, 0, 'the budget is not exhausted until this fourth socket also fails');

  sockets[3].emit('close', { code: 1006, reason: '', wasClean: false }); // attempt 4 — over budget
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(sockets.length, 4, 'no further reconnect once the budget is spent');
  assert.equal(closes.length, 1, 'onClose must fire exactly once, after the budget is exhausted');
  client.close();
});

test('a close before the very first welcome is never retried — it rejects connect() instead', async () => {
  const sockets = installFakeWebSocket();
  const closes = [];
  const client = new MatchClient('m1', { onClose: (ev) => closes.push(ev) });

  const connectPromise = client.connect();
  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false }); // never even opened

  await assert.rejects(connectPromise);
  await new Promise((r) => setTimeout(r, 1100));

  assert.equal(sockets.length, 1, 'a handshake failure must not retry — connect() already reports it');
  assert.equal(closes.length, 0, 'onClose is for a match already joined, not a failed handshake');
  client.close();
});

test('close() cancels a pending reconnect', async () => {
  const sockets = installFakeWebSocket();
  const client = new MatchClient('m1', {});

  const connectPromise = client.connect();
  sockets[0].emit('open');
  sockets[0].message(welcomeFor());
  await connectPromise;

  sockets[0].emit('close', { code: 1006, reason: '', wasClean: false });
  client.close(); // the player leaves (or the page is reloading) before the retry fires
  await new Promise((r) => setTimeout(r, 1500));

  assert.equal(sockets.length, 1, 'a cancelled reconnect must not open a socket after close()');
});
