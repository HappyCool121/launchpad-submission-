declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
declare const __ADROUTER_E2E__: boolean;

declare module '*.svg?url' {
  const url: string;
  export default url;
}
