'use strict';

/**
 * Aggregate a list of connection statuses into a tray indicator state.
 *
 *   'connecting' - any forward is starting or reconnecting (takes precedence so
 *                  in-flux state is visible even if others are up)
 *   'active'     - at least one forward is running
 *   'idle'       - nothing running
 *
 * @param {string[]} statuses
 * @returns {'connecting'|'active'|'idle'}
 */
function trayState(statuses) {
  if (statuses.some((s) => s === 'starting' || s === 'reconnecting')) return 'connecting';
  if (statuses.some((s) => s === 'running')) return 'active';
  return 'idle';
}

module.exports = { trayState };
