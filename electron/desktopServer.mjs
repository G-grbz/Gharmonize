import path from 'node:path';
import { pathToFileURL } from 'node:url';

// npm start and installed desktop packages run their own backend. Only the
// explicitly requested development window attaches to an external server.
export async function startDesktopServer({
  isPackaged, externalServer, resourcesPath, port, resolvePort, waitForServer,
  importServer = url => import(url), env = process.env
}) {
  if (!isPackaged && externalServer) {
    await waitForServer(port);
    return port;
  }

  const selectedPort = await resolvePort();
  env.PORT = selectedPort;
  const entry = isPackaged
    ? pathToFileURL(path.join(resourcesPath, 'app.asar', 'bootstrap.mjs'))
    : new URL('../bootstrap.mjs', import.meta.url);
  await importServer(entry.href);
  await waitForServer(selectedPort);
  return selectedPort;
}
