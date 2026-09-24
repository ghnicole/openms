const REFRESH_MS = 10000;
const REQUEST_TIMEOUT_MS = 5000;

/** One bounded request at a time, including on the login screen; teardown aborts pending work. */
export function initializeProjectPlayers(signal) {
  const element = document.querySelector("#project-players");
  if (!element || signal.aborted) return;
  let timer = null;

  function stop() {
    clearTimeout(timer);
  }

  async function refresh() {
    try {
      const response = await fetch("/api/v1/status", {
        cache: "no-store",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) throw new Error("Player count unavailable");
      const { onlinePlayers } = await response.json();
      if (!Number.isSafeInteger(onlinePlayers) || onlinePlayers < 0) {
        throw new Error("Invalid player count");
      }
      if (!signal.aborted) {
        element.textContent = `Players online: ${onlinePlayers}`;
      }
    } catch {
      if (!signal.aborted) element.textContent = "Players online: —";
    } finally {
      if (!signal.aborted) timer = setTimeout(refresh, REFRESH_MS);
    }
  }

  signal.addEventListener("abort", stop, { once: true });
  void refresh();
}
