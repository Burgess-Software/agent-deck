// Stable Stream Deck slot allocation.
//
// A rollout append updates the object already displayed in a slot; it never
// changes that session's position. Only an admission event (a new session ID
// or a new rollout file for a resumed session) may replace one incumbent.

function compareRecent(a, b) {
  const byTime = (Number(b?.ts) || 0) - (Number(a?.ts) || 0);
  return byTime || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

function normalizedCandidates(candidates) {
  const byId = new Map();
  for (const candidate of candidates ?? []) {
    if (!candidate?.id || byId.has(candidate.id)) continue;
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort(compareRecent);
}

function normalizedSlots(slots) {
  const values = [...(slots ?? [])]
    .map((slot) => Number(slot))
    .filter((slot) => Number.isInteger(slot) && slot >= 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

export class StableSessionSlots {
  constructor({ bindings = [], knownRollouts = {}, missingGraceScans = 2 } = {}) {
    const seen = new Set();
    this.bindings = Array.from({ length: bindings.length }, (_, i) => {
      const id = typeof bindings[i] === 'string' && bindings[i] ? bindings[i] : null;
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
    this.knownRollouts = new Map(Object.entries(knownRollouts ?? {})
      .filter(([id, rollout]) => id && typeof rollout === 'string' && rollout));
    this.missingGraceScans = Math.max(1, Math.floor(Number(missingGraceScans) || 1));
    this.bindingMisses = new Map();
    this.knownMisses = new Map();
  }

  snapshot() {
    return {
      version: 1,
      bindings: [...this.bindings],
      knownRollouts: Object.fromEntries(this.knownRollouts),
    };
  }

  reconcile(candidates, activeSlotIndexes, fallbackSlotIndexes = []) {
    const sessions = normalizedCandidates(candidates);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const present = new Set(byId.keys());
    const activeSlots = normalizedSlots(activeSlotIndexes);
    const activeSlotSet = new Set(activeSlots);
    const fallbackSlots = normalizedSlots(fallbackSlotIndexes)
      .filter((slot) => activeSlotSet.has(slot));
    const fallbackSlotSet = new Set(fallbackSlots);
    const regularSlots = activeSlots.filter((slot) => !fallbackSlotSet.has(slot));
    const placementSlots = [...regularSlots, ...fallbackSlots];
    const maxActiveSlot = activeSlots.at(-1) ?? -1;
    while (this.bindings.length <= maxActiveSlot) this.bindings.push(null);

    const before = JSON.stringify(this.snapshot());

    // With no visible agent keys, retain the last bindings and do not consume
    // new/resumed-session admission events. This also handles startup, where
    // the first scan can finish before OpenDeck sends willAppear events.
    if (activeSlots.length === 0) {
      return {
        sessions: this.bindings.map((id) => byId.get(id) ?? null),
        stateChanged: false,
      };
    }

    const bootstrapping = this.knownRollouts.size === 0;

    // Drop an expired/missing binding only after consecutive missing scans.
    // Persisted bindings are validated immediately during bootstrap.
    for (let i = 0; i < this.bindings.length; i++) {
      const id = this.bindings[i];
      if (!id || present.has(id)) {
        if (id) this.bindingMisses.delete(id);
        continue;
      }
      const misses = bootstrapping
        ? this.missingGraceScans
        : (this.bindingMisses.get(id) ?? 0) + 1;
      if (misses >= this.missingGraceScans) {
        this.bindings[i] = null;
        this.bindingMisses.delete(id);
      } else {
        this.bindingMisses.set(id, misses);
      }
    }

    // Only a new ID or a new winning rollout file is an admission. Updating
    // the mtime of a known rollout is deliberately ignored for placement.
    const admissions = bootstrapping ? [] : sessions.filter((session) =>
      this.knownRollouts.get(session.id) !== session.rolloutPath);

    // Only visible bindings count as assigned. A session left on a now-hidden
    // logical slot must be eligible to move into a visible vacancy.
    const assigned = new Set(activeSlots.map((slot) => this.bindings[slot]).filter(Boolean));
    const bind = (slot, id) => {
      for (let i = 0; i < this.bindings.length; i++) {
        if (i !== slot && this.bindings[i] === id) this.bindings[i] = null;
      }
      this.bindings[slot] = id;
    };
    const emptyActiveSlot = () => placementSlots.find((slot) => !this.bindings[slot]);

    // Oldest first means a burst larger than the deck converges on the newest
    // admissions. Existing survivors never move; only victim slots change.
    admissions.sort((a, b) => compareRecent(b, a));
    for (const admission of admissions) {
      if (assigned.has(admission.id)) continue;

      let slot = emptyActiveSlot();
      if (slot === undefined) {
        let victim = null;
        for (const candidateSlot of activeSlots) {
          const incumbent = byId.get(this.bindings[candidateSlot]);
          // Respect the missing-data grace reservation until it is cleared.
          if (!incumbent) continue;
          if (!victim || (Number(incumbent.ts) || 0) < (Number(victim.session.ts) || 0)) {
            victim = { slot: candidateSlot, session: incumbent };
          }
        }
        if (!victim || (Number(admission.ts) || 0) <= (Number(victim.session.ts) || 0)) continue;
        slot = victim.slot;
        assigned.delete(this.bindings[slot]);
      }

      bind(slot, admission.id);
      assigned.add(admission.id);
    }

    // Bootstrap and TTL expiry can leave vacancies. Fill only those holes with
    // the newest overflow sessions; never compact existing bindings.
    const waiting = sessions.filter((session) => !assigned.has(session.id));
    for (const slot of placementSlots) {
      if (this.bindings[slot] || waiting.length === 0) continue;
      const next = waiting.shift();
      bind(slot, next.id);
      assigned.add(next.id);
    }

    // A usage-capable agent key is an elastic final slot. When capacity drops
    // below the number of visible keys, move only its incumbent into an
    // earlier regular vacancy so the fallback display becomes available. This
    // is the sole intentional exception to the no-compaction rule.
    for (const fallbackSlot of fallbackSlots) {
      const id = this.bindings[fallbackSlot];
      if (!id || !byId.has(id)) continue;
      const vacancy = regularSlots.find((slot) => !this.bindings[slot]);
      if (vacancy === undefined) continue;
      bind(vacancy, id);
    }

    // Mark every observed rollout after admissions are handled so one event is
    // consumed once, even if that session remains in overflow.
    for (const session of sessions) {
      this.knownRollouts.set(session.id, session.rolloutPath);
      this.knownMisses.delete(session.id);
    }
    for (const id of [...this.knownRollouts.keys()]) {
      if (present.has(id)) continue;
      const misses = (this.knownMisses.get(id) ?? 0) + 1;
      if (misses >= this.missingGraceScans) {
        this.knownRollouts.delete(id);
        this.knownMisses.delete(id);
      } else {
        this.knownMisses.set(id, misses);
      }
    }

    return {
      sessions: this.bindings.map((id) => byId.get(id) ?? null),
      stateChanged: before !== JSON.stringify(this.snapshot()),
    };
  }
}
