export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'adrouter_agent_theme_v1';
export const THEME_TRANSITION_CLASS = 'theme-transitioning';
export const THEME_TRANSITION_MS = 320;

let activeThemeTransition: ViewTransition | undefined;
let fallbackCleanupTimer: number | undefined;
let themeTransitionSequence = 0;

export const readStoredTheme = (): Theme => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
};

export const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
};

export const applyStoredTheme = (): Theme => {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
};

export const persistTheme = (theme: Theme): void => {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies for this session when storage is unavailable.
  }
};

const clearFallbackCleanup = (): void => {
  if (fallbackCleanupTimer === undefined) return;
  window.clearTimeout(fallbackCleanupTimer);
  fallbackCleanupTimer = undefined;
};

const reducedMotionRequested = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const transitionToTheme = (theme: Theme): void => {
  const root = document.documentElement;
  const sequence = ++themeTransitionSequence;
  clearFallbackCleanup();

  const interruptedTransition = activeThemeTransition;
  activeThemeTransition = undefined;
  interruptedTransition?.skipTransition();

  if (reducedMotionRequested()) {
    root.classList.remove(THEME_TRANSITION_CLASS);
    persistTheme(theme);
    return;
  }

  root.classList.add(THEME_TRANSITION_CLASS);
  if (typeof document.startViewTransition === 'function') {
    try {
      const transition = document.startViewTransition(() => {
        if (sequence === themeTransitionSequence) persistTheme(theme);
      });
      activeThemeTransition = transition;
      void transition.finished.then(
        () => {
          if (activeThemeTransition !== transition) return;
          activeThemeTransition = undefined;
          root.classList.remove(THEME_TRANSITION_CLASS);
        },
        () => {
          if (activeThemeTransition !== transition) return;
          activeThemeTransition = undefined;
          root.classList.remove(THEME_TRANSITION_CLASS);
        }
      );
      return;
    } catch {
      // Fall back to an immediate theme update with bounded transition styling.
    }
  }

  persistTheme(theme);
  fallbackCleanupTimer = window.setTimeout(() => {
    fallbackCleanupTimer = undefined;
    root.classList.remove(THEME_TRANSITION_CLASS);
  }, THEME_TRANSITION_MS);
};
