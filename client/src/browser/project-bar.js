import { initializeProjectPlayers } from "./project-players.js";

/** The project dialog belongs to the document shell, including before game startup. */
export function initializeProjectBar() {
  const controller = new AbortController();
  initializeProjectPlayers(controller.signal);
  const dialog = document.querySelector("#project-about");
  function openAbout() {
    dialog.showModal();
  }
  function release() {
    controller.abort();
  }
  document
    .querySelector("#project-about-open")
    .addEventListener("click", openAbout, {
      signal: controller.signal,
    });
  window.addEventListener("pagehide", release, { once: true });
}
