import { spawn } from 'node:child_process';

// Best-effort: open a URL in the user's default browser. The device-login
// page must reach the user even when the chat client never renders the URL
// the agent was asked to relay. Returns true if the open was attempted.
// Disabled via GROK_BRIDGE_NO_BROWSER=1 (tests, CI, headless machines).
export function openBrowser(url) {
  if (process.env.GROK_BRIDGE_NO_BROWSER) return false;
  try {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
