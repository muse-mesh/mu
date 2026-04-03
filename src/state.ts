// Minimal reactive store (~35 lines, from reference 04-state-management.md)

export function createStore<T>(initialState: T, onChange?: (state: T) => void) {
  let state = initialState;
  const listeners = new Set<(state: T) => void>();

  return {
    getState: () => state,
    setState: (updater: T | ((prev: T) => T)) => {
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(state) : updater;
      if (Object.is(state, next)) return;
      state = next;
      onChange?.(state);
      listeners.forEach(fn => fn(state));
    },
    subscribe: (fn: (state: T) => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
