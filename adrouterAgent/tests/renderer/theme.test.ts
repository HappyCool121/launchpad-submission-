import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStoredTheme,
  persistTheme,
  readStoredTheme,
  THEME_STORAGE_KEY,
  THEME_TRANSITION_CLASS,
  THEME_TRANSITION_MS,
  transitionToTheme,
} from '@/renderer/theme';

const storedValues = new Map<string, string>();
const originalMatchMedia = window.matchMedia;
const originalStartViewTransition = document.startViewTransition;

beforeEach(() => {
  storedValues.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => storedValues.clear(),
      getItem: (key: string) => storedValues.get(key) ?? null,
      removeItem: (key: string) => storedValues.delete(key),
      setItem: (key: string, value: string) => storedValues.set(key, value),
    },
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove(THEME_TRANSITION_CLASS);
  document.documentElement.style.colorScheme = '';
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: originalMatchMedia,
  });
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: originalStartViewTransition,
  });
});

describe('renderer theme', () => {
  it('starts light and persists an explicit dark selection', () => {
    expect(readStoredTheme()).toBe('light');
    expect(applyStoredTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');

    persistTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('keeps fallback transition styling for the complete theme crossfade', () => {
    vi.useFakeTimers();

    transitionToTheme('dark');
    expect(document.documentElement).toHaveClass(THEME_TRANSITION_CLASS);
    expect(document.documentElement.dataset.theme).toBe('dark');

    vi.advanceTimersByTime(THEME_TRANSITION_MS - 1);
    expect(document.documentElement).toHaveClass(THEME_TRANSITION_CLASS);
    vi.advanceTimersByTime(1);
    expect(document.documentElement).not.toHaveClass(THEME_TRANSITION_CLASS);
  });

  it('restarts transition cleanup after rapid theme toggles', () => {
    vi.useFakeTimers();

    transitionToTheme('dark');
    vi.advanceTimersByTime(THEME_TRANSITION_MS / 2);
    transitionToTheme('light');
    vi.advanceTimersByTime(THEME_TRANSITION_MS / 2);

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement).toHaveClass(THEME_TRANSITION_CLASS);
    vi.advanceTimersByTime(THEME_TRANSITION_MS / 2);
    expect(document.documentElement).not.toHaveClass(THEME_TRANSITION_CLASS);
  });

  it('cleans up a document view transition after it finishes', async () => {
    let finishTransition: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      finishTransition = resolve;
    });
    const startViewTransition = vi.fn((update: ViewTransitionUpdateCallback) => {
      void update();
      return {
        finished,
        ready: Promise.resolve(),
        skipTransition: vi.fn(),
        types: new Set<string>(),
        updateCallbackDone: Promise.resolve(),
      } as unknown as ViewTransition;
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });

    transitionToTheme('dark');

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement).toHaveClass(THEME_TRANSITION_CLASS);
    finishTransition?.();
    await finished;
    await Promise.resolve();
    expect(document.documentElement).not.toHaveClass(THEME_TRANSITION_CLASS);
  });

  it('ignores stale document updates when a theme transition is interrupted', async () => {
    const updates: ViewTransitionUpdateCallback[] = [];
    const finishers: Array<() => void> = [];
    const skipTransitions = [vi.fn(), vi.fn()];
    const startViewTransition = vi.fn((update: ViewTransitionUpdateCallback) => {
      const index = updates.push(update) - 1;
      const finished = new Promise<void>((resolve) => finishers.push(resolve));
      return {
        finished,
        ready: Promise.resolve(),
        skipTransition: skipTransitions[index],
        types: new Set<string>(),
        updateCallbackDone: Promise.resolve(),
      } as unknown as ViewTransition;
    });
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });
    applyStoredTheme();

    transitionToTheme('dark');
    transitionToTheme('light');

    expect(skipTransitions[0]).toHaveBeenCalledOnce();
    await updates[0]?.();
    expect(document.documentElement.dataset.theme).toBe('light');
    await updates[1]?.();
    expect(document.documentElement.dataset.theme).toBe('light');
    finishers.forEach((finish) => {
      finish();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement).not.toHaveClass(THEME_TRANSITION_CLASS);
  });

  it('applies the selected theme immediately when reduced motion is requested', () => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    transitionToTheme('dark');

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement).not.toHaveClass(THEME_TRANSITION_CLASS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
