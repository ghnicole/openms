import { expect, test } from "bun:test";
import { GameplayGateway } from "../src/gateway.js";
import { OnlineHttp } from "../src/http.js";

function fixture() {
  const gateway = new GameplayGateway({
    config: {},
    auth: {},
    database: {},
    world: { log() {}, neutralize() {} },
  });
  const http = new OnlineHttp({ config: {}, content: {}, auth: {}, gateway });
  return { gateway, http };
}

test("public player count excludes unauthenticated sockets and disconnected/retiring actors", async () => {
  const { gateway, http } = fixture();
  gateway.sockets.add({ data: { actor: null, closed: false } });
  const first = { connection: { data: { closed: false } } };
  const second = { connection: { data: { closed: false } } };
  gateway.characters.set("first-field", first);
  gateway.characters.set("other-field", second);
  gateway.characters.set("grace", { connection: null });
  gateway.characters.set("closed", {
    connection: { data: { closed: true } },
  });
  gateway.characters.set("retiring", {
    retiring: true,
    connection: { data: { closed: false } },
  });
  const response = await http.handle(
    new Request("http://localhost/api/v1/status"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ onlinePlayers: 2 });
});

test("disconnect and resume change the count without double-counting replacement sockets", () => {
  const { gateway } = fixture();
  const actor = { id: "player" };
  gateway.characters.set(actor.id, actor);
  expect(gateway.onlinePlayerCount()).toBe(0);
  const original = { data: { closed: false } };
  gateway.attach(original, actor);
  expect(gateway.onlinePlayerCount()).toBe(1);
  gateway.closed(original, 1000, "disconnect");
  expect(gateway.onlinePlayerCount()).toBe(0);
  const resumed = { data: { closed: false } };
  gateway.attach(resumed, actor);
  gateway.closed(original, 1000, "late close");
  expect(gateway.onlinePlayerCount()).toBe(1);
  gateway.closed(resumed, 1000, "disconnect");
  expect(gateway.onlinePlayerCount()).toBe(0);
});
