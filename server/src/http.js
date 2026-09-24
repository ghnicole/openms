import {
  decodeJson,
  closedRecord,
  protocolError,
} from "../../shared/protocol.js";
import { getInteractionContent } from "./interactions.js";
import { logPrefix } from "../../shared/development-log.js";
import { prepareCreatedCharacter } from "./character-creation.js";
import { issueCreationRoll, admitCreationRoll } from "./creation-roll.js";
import { DEVELOPMENT_JSON } from "../../shared/development.js";
import { CONTENT_HTTP_PREFIX } from "./content-http.js";
import { worldResourceResponse } from "./world-content.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_BODY_CHUNKS = 64;
const CHARACTER_PATH = "/api/v1/characters/";
const CHARACTER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR_STATUS = new Map([
  ["UNAUTHENTICATED", 401],
  ["SESSION_EXPIRED", 401],
  ["NOT_ALLOWED", 403],
  ["NOT_FOUND", 404],
  ["CHARACTER_BUSY", 409],
  ["NAME_TAKEN", 409],
  ["CHARACTER_LIMIT", 409],
  ["STALE_CONNECTION", 409],
  ["STALE_FIELD", 409],
  ["STALE_REVISION", 409],
  ["RATE_LIMITED", 429],
  ["SERVER_BUSY", 503],
]);

function response(value, status = 200, cookie = null) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(value), { status, headers });
}

function admitBodyHeaders(request, maxBytes) {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    throw protocolError("INVALID_MESSAGE");
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw protocolError("INVALID_MESSAGE");
  }
}

async function requestBody(request, limits = { maxBytes: MAX_BODY_BYTES }) {
  admitBodyHeaders(request, limits.maxBytes);
  const reader = request.body?.getReader();
  if (!reader) throw protocolError("INVALID_MESSAGE");
  const buffer = new Uint8Array(limits.maxBytes);
  let size = 0;
  let finished = false;
  try {
    for (let count = 0; count < MAX_BODY_CHUNKS; count++) {
      const part = await reader.read();
      if (part.done) {
        finished = true;
        return decodeJson(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, size),
          ),
          limits,
        );
      }
      if (part.value.length > limits.maxBytes - size) {
        throw protocolError("INVALID_MESSAGE");
      }
      buffer.set(part.value, size);
      size += part.value.length;
    }
    throw protocolError("INVALID_MESSAGE");
  } finally {
    if (!finished) await reader.cancel("Body limit exceeded");
    reader.releaseLock();
  }
}

/** Browser-only authenticated endpoints. No forwarded-IP/header trust on the public listener. */
export class OnlineHttp {
  constructor({
    config,
    content,
    auth,
    gateway,
    log = null,
    contentHttp = null,
  }) {
    this.config = config;
    this.content = content;
    this.auth = auth;
    this.gateway = gateway;
    this.database = gateway.database;
    this.contentHttp = contentHttp;
    this.log = log;
  }

  async fetch(request, server) {
    const started = performance.now();
    const path = new URL(request.url).pathname;
    let result;
    try {
      result = await this.handle(request, server);
      return result;
    } finally {
      this.log?.("http", {
        method: request.method,
        path,
        status: result?.status ?? 101,
        ms: Math.round(performance.now() - started),
      });
    }
  }

  async handle(request, server) {
    try {
      const url = new URL(request.url);
      if (url.search || request.headers.get("content-length")?.length > 20) {
        throw protocolError("INVALID_MESSAGE");
      }
      if (url.pathname.startsWith(CONTENT_HTTP_PREFIX) && this.contentHttp) {
        return await this.contentHttp.fetch(
          request,
          url.pathname.slice(CONTENT_HTTP_PREFIX.length),
        );
      }
      if (url.pathname === "/api/v1/play") {
        if (request.method !== "GET") throw protocolError("INVALID_MESSAGE");
        return this.gateway.upgrade(
          request,
          server,
          server.requestIP(request)?.address ?? "unknown",
        );
      }
      return await this.route(request, url.pathname, server);
    } catch (error) {
      return this.failedRequest(request, error);
    }
  }

  failedRequest(request, error) {
    const code = error.code ?? "SERVER_BUSY";
    this.log?.("http.rejected", {
      method: request.method,
      path: new URL(request.url).pathname,
      code,
      reason: error.reason,
      origin: request.headers.get("origin"),
    });
    if (!error.code) {
      console.error(logPrefix("server"), "Online HTTP failure:", error.message);
    }
    return response({ code }, ERROR_STATUS.get(code) ?? 400);
  }

  route(request, path, server) {
    if (request.method === "GET" && path !== "/api/v1/challenge") {
      return this.readRoute(request, path);
    }
    if (request.method === "GET" && path === "/api/v1/challenge") {
      const { cookie, ...challenge } = this.auth.challenge(
        request,
        server.requestIP(request)?.address ?? "unknown",
      );
      return response(challenge, 200, cookie);
    }
    if (request.method === "POST") {
      return this.writeRoute(request, path, server);
    }
    if (request.method === "DELETE" && path === "/api/v1/session") {
      return this.logout(request);
    }
    if (request.method === "DELETE" && path.startsWith(CHARACTER_PATH)) {
      return this.deleteCharacter(request, path.slice(CHARACTER_PATH.length));
    }
    return response({ code: "NOT_FOUND" }, 404);
  }

  async readRoute(request, path) {
    if (path === "/api/v1/status") {
      return response({ onlinePlayers: this.gateway.onlinePlayerCount() });
    }
    if (path.startsWith("/api/v1/world-content/")) {
      return worldResourceResponse(
        this.content,
        path.slice("/api/v1/world-content/".length),
      );
    }
    if (path === "/api/v1/config") return this.configuration(request);
    if (path === "/api/v1/characters") {
      const session = this.auth.session(request);
      return response({
        characters: await this.database.listCharacters(session.accountId),
      });
    }
    if (/^\/api\/v1\/content\/[a-f0-9]{64}$/.test(path)) {
      return this.dialogue(request, path.slice(-64));
    }
    return response({ code: "NOT_FOUND" }, 404);
  }

  async writeRoute(request, path, server) {
    if (path === "/api/v1/session" || path === "/api/v1/accounts") {
      return this.authenticate(request, path, server);
    }
    if (path === "/api/v1/characters") return this.createCharacter(request);
    if (path === "/api/v1/character-roll") return this.rollCharacter(request);
    if (path === "/api/v1/play-ticket") {
      return response(
        await this.auth.ticket(request, await requestBody(request)),
      );
    }
    if (path === "/api/v1/development" && this.config.development) {
      return this.develop(request);
    }
    return response({ code: "NOT_FOUND" }, 404);
  }

  async authenticate(request, path, server) {
    const body = await requestBody(request);
    const address = server.requestIP(request)?.address ?? "unknown";
    const result =
      path === "/api/v1/accounts"
        ? await this.auth.register(request, body, address)
        : await this.auth.login(request, body, address);
    const { csrfToken, expiresAt, role } = result.session;
    return response({ csrfToken, expiresAt, role }, 200, result.cookie);
  }

  async rollCharacter(request) {
    this.auth.origin(request);
    const body = await requestBody(request);
    closedRecord(body, ["csrfToken"]);
    const session = this.auth.session(request);
    this.auth.csrf(session, body.csrfToken);
    return response(issueCreationRoll(session));
  }

  async createCharacter(request) {
    this.auth.origin(request);
    const body = await requestBody(request);
    const session = this.auth.session(request);
    this.auth.csrf(session, body.csrfToken);
    admitCreationRoll(session, body);
    const profile = await prepareCreatedCharacter(this.content, body);
    const character = await this.database.createAccountCharacter(
      session.accountId,
      profile,
      () => {
        this.auth.csrf(session, body.csrfToken);
        admitCreationRoll(session, body);
      },
    );
    return response({ character });
  }

  /** Deletion is a durable account-scoped state change; the session CSRF token is
   * required in the header because the request carries no body. */
  async deleteCharacter(request, characterId) {
    this.auth.origin(request);
    const session = this.auth.session(request);
    this.auth.csrf(session, request.headers.get("x-csrf-token"));
    if (!CHARACTER_ID.test(characterId)) {
      return response({ code: "NOT_FOUND" }, 404);
    }
    return response({
      deleted: await this.database.deleteCharacter(
        session.accountId,
        characterId,
      ),
    });
  }

  configuration(request) {
    const { cookie, ...session } = this.auth.bootstrap(request);
    return response(
      {
        v: 1,
        assetBuildId: this.content.assetBuildId,
        rulesHash: this.content.rulesHash,
        catalogHash: this.content.catalogHash,
        worldContent: this.content.worldContent ?? null,
        development: this.config.development,
        ...session,
      },
      200,
      cookie,
    );
  }

  async logout(request) {
    this.auth.origin(request);
    const session = this.auth.session(request);
    this.auth.csrf(session, request.headers.get("x-csrf-token"));
    this.auth.revoke(session);
    await this.gateway.logout(session);
    return response(
      { code: "OK" },
      200,
      this.auth.cookie("openms_session", "", 0),
    );
  }

  activeActor(session) {
    const actor = this.gateway.accounts.get(session.accountId);
    if (
      !actor?.connection ||
      actor.sessionId !== session.id ||
      actor.connection.data.closed
    ) {
      throw protocolError("NOT_ALLOWED");
    }
    return actor;
  }

  dialogue(request, hash) {
    const actor = this.activeActor(this.auth.session(request));
    const content = getInteractionContent(this.gateway.world, actor, hash);
    if (!content) throw protocolError("NOT_FOUND");
    return response(content);
  }

  admitDevelopment(request, body) {
    this.auth.origin(request);
    const session = this.auth.session(request);
    closedRecord(body, [
      "csrfToken",
      "connectionEpoch",
      "operationId",
      "action",
    ]);
    this.auth.csrf(session, body.csrfToken);
    if (!this.config.development || session.role !== "developer") {
      throw protocolError("NOT_ALLOWED");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        body.operationId,
      )
    ) {
      throw protocolError("INVALID_MESSAGE");
    }
    const actor = this.activeActor(session);
    const socket = actor.connection;
    if (socket.data.epoch !== body.connectionEpoch) {
      throw protocolError("STALE_CONNECTION");
    }
    if (!socket.data.ready) throw protocolError("NOT_ALLOWED");
    if (!socket.data.devRate.take()) throw protocolError("RATE_LIMITED");
    return actor;
  }

  async develop(request) {
    const body = await requestBody(request, DEVELOPMENT_JSON);
    const actor = this.admitDevelopment(request, body);
    const audit = {
      accountId: actor.accountId,
      characterId: actor.id,
      operationId: body.operationId,
      action: body.action,
    };
    await this.database.auditDevelopment({
      ...audit,
      status: "requested",
      code: "OK",
    });
    let result;
    try {
      result = await this.gateway.world.develop(actor, body);
    } catch (error) {
      this.logDevelopment(actor, body, {
        status: "rejected",
        code: error.code ?? "SERVER_BUSY",
      });
      await this.database.auditDevelopment({
        ...audit,
        status: "rejected",
        code: error.code ?? "SERVER_BUSY",
      });
      return response({
        status: "rejected",
        code: error.code ?? "SERVER_BUSY",
        operationId: body.operationId,
        domainRevision: actor.revision,
        transactionId: null,
      });
    }
    // A failed post-commit audit must not manufacture a rejected transaction receipt.
    this.logDevelopment(actor, body, result);
    await this.database.auditDevelopment({
      ...audit,
      status: result.status ?? "committed",
      code: result.code ?? "OK",
    });
    return response({ ...result, operationId: body.operationId });
  }

  logDevelopment(actor, body, result) {
    this.log?.("development.result", {
      character: actor.id,
      operation: body.operationId,
      action: body.action?.kind,
      map: actor.field.mapId,
      status: result.status,
      code: result.code,
    });
  }
}
