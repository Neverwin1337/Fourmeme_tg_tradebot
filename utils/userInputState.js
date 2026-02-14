const state = new Map();

function setUserInputState(userId, newState) {
  state.set(userId, newState);
}

function getUserInputState(userId) {
  return state.get(userId);
}

function clearUserInputState(userId) {
  state.delete(userId);
}

function pruneOldStates(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [userId, s] of state.entries()) {
    if (s && s.timestamp && now - s.timestamp > maxAgeMs) {
      state.delete(userId);
    }
  }
}

module.exports = {
  setUserInputState,
  getUserInputState,
  clearUserInputState,
  pruneOldStates
};
