/**
 * Acquire a held shortcut while making an early key-up safe.
 *
 * Stream Deck events are delivered independently, so keyUp can arrive while
 * the async focus work in keyDown is still running. In that case the release
 * is remembered and performed as soon as acquisition finishes.
 */
export async function startManagedHold(holder, keys, acquire, release) {
  if (holder.holdPending || holder.holding) return false;

  holder.holdPending = true;
  holder.holdReleased = false;
  try {
    await acquire();
    holder.holding = keys;

    if (holder.holdReleased) {
      holder.holding = null;
      holder.holdReleased = false;
      await release(keys);
      return false;
    }
    return true;
  } catch (error) {
    holder.holdReleased = false;
    throw error;
  } finally {
    holder.holdPending = false;
  }
}

/** Release now, or remember the release if acquisition is still pending. */
export async function releaseManagedHold(holder, release) {
  if (holder.holdPending) {
    holder.holdReleased = true;
    return true;
  }

  const keys = holder.holding;
  if (!keys) return false;
  // Clear first so keyUp and the safety timeout cannot release concurrently.
  holder.holding = null;
  holder.holdReleased = false;
  await release(keys);
  return true;
}
