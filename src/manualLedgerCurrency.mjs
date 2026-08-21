const manualLedgerSources = new Set(["JOURNAL", "WITHDRAWAL"]);

function normalizedName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function actorNameFromAccount(account) {
  const suffix = " ACTOR_CLEARING";
  const value = String(account || "");
  return value.endsWith(suffix) ? value.slice(0, -suffix.length).trim() : "";
}

function manualLedgerIdentity(line = {}) {
  return [
    line.entryId || "",
    line.journal || "",
    line.source || "",
    line.account || "",
    line.direction || "",
  ].map((value) => String(value)).join(":");
}

function mergedActors(currentState = {}, incomingState = {}, canonicalActors = []) {
  const actorsById = new Map();
  const actorsWithoutIds = [];
  for (const actor of [
    ...(Array.isArray(incomingState?.actors) ? incomingState.actors : []),
    ...(Array.isArray(currentState?.actors) ? currentState.actors : []),
    ...(Array.isArray(canonicalActors) ? canonicalActors : []),
  ]) {
    if (!actor || typeof actor !== "object") continue;
    if (actor.id) {
      actorsById.set(String(actor.id), { ...(actorsById.get(String(actor.id)) || {}), ...actor });
    } else {
      actorsWithoutIds.push(actor);
    }
  }
  return [...actorsById.values(), ...actorsWithoutIds];
}

export function newManualLedgerCurrencyViolations(currentState = {}, incomingState = {}, canonicalActors = []) {
  const existingIdentities = new Set(
    (Array.isArray(currentState?.ledger) ? currentState.ledger : [])
      .filter((line) => manualLedgerSources.has(String(line?.source || "")))
      .map(manualLedgerIdentity)
  );
  const actorsByName = new Map(
    mergedActors(currentState, incomingState, canonicalActors)
      .filter((actor) => actor?.role !== "Master" && actor?.name && actor?.currency)
      .map((actor) => [normalizedName(actor.name), actor])
  );
  const violations = [];

  for (const line of Array.isArray(incomingState?.ledger) ? incomingState.ledger : []) {
    if (!manualLedgerSources.has(String(line?.source || "")) || line?.archived === true) continue;
    if (existingIdentities.has(manualLedgerIdentity(line))) continue;
    const actorName = actorNameFromAccount(line?.account);
    const actor = actorsByName.get(normalizedName(actorName));
    if (!actor || String(line?.currency || "") === String(actor.currency || "")) continue;
    violations.push({
      actor: String(actor.name || actorName),
      source: String(line.source),
      journal: String(line.journal || line.entryId || ""),
      currency: String(line.currency || ""),
      expectedCurrency: String(actor.currency || ""),
    });
  }
  return violations;
}
