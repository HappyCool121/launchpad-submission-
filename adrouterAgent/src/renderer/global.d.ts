/// <reference types="vite/client" />

import type { AdrouterApi } from '../shared/contracts';

declare global {
  interface Window {
    adrouter: AdrouterApi;
  }
}
