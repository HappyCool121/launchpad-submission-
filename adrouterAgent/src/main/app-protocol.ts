import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol, session } from 'electron';

const appHost = 'renderer';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

const isContained = (root: string, candidate: string): boolean => {
  const pathRelative = relative(root, candidate);
  return (
    pathRelative === '' ||
    (!pathRelative.startsWith('..') &&
      !pathRelative.startsWith('/') &&
      !pathRelative.includes('/../'))
  );
};

export const registerAppProtocol = (rendererRoot: string): void => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== appHost || url.port || url.username || url.password) {
      return new Response('Not found', { status: 404 });
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (pathname.includes('\0')) {
      return new Response('Invalid path', { status: 400 });
    }

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const target = new URL(pathname.slice(1) + url.search, `${MAIN_WINDOW_VITE_DEV_SERVER_URL}/`);
      return net.fetch(target.toString());
    }

    const root = await realpath(rendererRoot);
    const target = resolve(root, `.${pathname}`);
    if (!isContained(root, target) || !existsSync(target)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  const rendererDevSocket = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? `ws://${new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).host}`
    : undefined;
  const contentSecurityPolicy = rendererDevSocket
    ? `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws://renderer ${rendererDevSocket}; form-action 'none'`
    : "default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('app://')) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [contentSecurityPolicy],
        },
      });
      return;
    }
    callback({ responseHeaders: details.responseHeaders });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
};

export const rendererUrl = 'app://renderer/index.html';
