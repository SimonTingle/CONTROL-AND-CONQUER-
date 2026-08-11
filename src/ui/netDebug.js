/**
 * A tiny always-on readout for confirming two devices are actually running the
 * same match.
 *
 * The one thing that makes this usable rather than misleading: the hash shown
 * is the **turn-aligned checkpoint**, not a live sample. A state hash changes
 * every simulated tick, so two people comparing phone screens would essentially
 * never be sampling the same instant and would see mismatches that mean
 * nothing. The checkpoint is computed at the start of a specific turn on every
 * client, so two devices showing the same `t<turn>` are describing the same
 * simulated moment and their hashes are directly comparable.
 *
 * Read it as: the SEED must match, the TEAM must differ, and at equal `t` the
 * HASH must match. Everything else is context for why it might not.
 */

let el = null;

function ensureEl() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'net-debug';
  // Styled inline so this stays self-contained and can be deleted in one file
  // when it has served its purpose.
  Object.assign(el.style, {
    position: 'fixed',
    top: '4px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '40',
    font: '10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#5eead4',
    background: 'rgba(3, 8, 12, 0.66)',
    padding: '3px 8px',
    borderRadius: '5px',
    textAlign: 'center',
    whiteSpace: 'pre',
    pointerEvents: 'none', // never steal a tap on a phone
    maxWidth: '96vw',
    overflow: 'hidden',
  });
  document.body.appendChild(el);
  return el;
}

/** Hide it (single player, or once the match ends). */
export function hideNetDebug() {
  if (el) el.style.display = 'none';
}

/**
 * @param {object} s
 * @param {number} s.seed            world seed — must be identical on both devices
 * @param {number} s.teamId          this client's seat — must differ between devices
 * @param {number} s.turn            lockstep turn currently being simulated
 * @param {number} s.simTick         simulated ticks since the match began
 * @param {boolean} s.stalled        waiting on a peer's input
 * @param {boolean} s.begun          has the start barrier released
 * @param {number} s.players         expected roster size
 * @param {boolean} s.connected      socket state
 * @param {{turn:number,hash:string}|null} s.checkpoint last turn-aligned digest
 * @param {number|null} s.desyncTurn turn the server last reported a disagreement
 * @param {number} s.vehicles        live vehicle count
 * @param {number} s.structures      live structure count
 * @param {number[]} s.credits       per-team credits, in team order
 */
export function updateNetDebug(s) {
  const node = ensureEl();
  node.style.display = '';

  // The server compares every client's checkpoint hash and says so when they
  // disagree — a far more trustworthy verdict than two people eyeballing hex.
  const verdict = s.desyncTurn != null
    ? `DESYNC @t${s.desyncTurn}`
    : s.checkpoint
      ? 'SYNC OK'
      : 'no checkpoint yet';
  node.style.color = (s.desyncTurn != null || s.players === undefined) ? '#fca5a5' : '#5eead4';

  const cp = s.checkpoint ? `t${s.checkpoint.turn} ${s.checkpoint.hash}` : '—';
  // `players` is undefined when the server predates the start barrier — show
  // that as its own state rather than rendering the word "undefined".
  const state = !s.connected
    ? 'OFFLINE'
    : s.players === undefined
      ? 'SERVER OUT OF DATE'
      : !s.begun
        ? `waiting ${s.players}p`
        : s.stalled ? 'STALLED' : 'running';

  node.textContent =
    `seed ${s.seed}  ·  team ${s.teamId}  ·  ${state}  ·  ${verdict}\n` +
    `checkpoint ${cp}  ·  turn ${s.turn}  ·  tick ${s.simTick}\n` +
    `veh ${s.vehicles}  ·  str ${s.structures}  ·  cr ${s.credits.join('/')}`;
}
