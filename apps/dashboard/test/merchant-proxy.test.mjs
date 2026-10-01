import assert from "node:assert/strict";
import test from "node:test";
import { merchantProxy } from "../src/lib/merchant-proxy.ts";

const id = "12345678-1234-1234-1234-123456789012";
const token = "Bearer header.payload.signature";
function request(path = "", method = "GET", body, authorization = token) {
  return new Request("http://localhost/api/merchant/" + path, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("proxy rejects absent/invalid credentials without contacting upstream", async () => {
  for (const authorization of [null, "Basic bad", "Bearer invalid"]) {
    const result = await merchantProxy(
      request("visits", "GET", undefined, authorization),
      ["visits"],
      "http://127.0.0.1:3001",
      () => {
        throw new Error("must not fetch");
      },
    );
    assert.equal(result.status, 401);
  }
});
test("proxy allows only the merchant endpoint/method allowlist", async () => {
  for (const [path, method] of [
    ["../me", "GET"],
    ["locations", "POST"],
    ["visits", "POST"],
    [`visits/${id}/delete`, "POST"],
    ["https://attacker.test", "GET"],
  ])
    assert.equal(
      (
        await merchantProxy(
          request(path, method),
          path.split("/"),
          "http://127.0.0.1:3001",
        )
      ).status,
      404,
    );
});
test("client cannot supply upstream URL, user, restaurant, permissions or duplicate filters", async () => {
  for (const query of [
    "url=https://attacker.test",
    "restaurantId=x",
    "userId=x",
    "role=OWNER",
    "status=PENDING&status=VERIFIED",
  ])
    assert.equal(
      (
        await merchantProxy(
          request("visits?" + query),
          ["visits"],
          "http://127.0.0.1:3001",
        )
      ).status,
      400,
    );
});
test("GET forwards only Bearer and approved filters to fixed API and never caches", async () => {
  const result = await merchantProxy(
    request("visits?locationId=" + id + "&status=PENDING&limit=20"),
    ["visits"],
    "http://127.0.0.1:3001",
    async (url, options) => {
      assert.equal(url.origin, "http://127.0.0.1:3001");
      assert.equal(url.pathname, "/merchant/visits");
      assert.equal(url.searchParams.get("locationId"), id);
      assert.equal(options.headers.Authorization, token);
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      assert.equal(options.headers.Cookie, undefined);
      return Response.json({ items: [], nextCursor: null });
    },
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("access-control-allow-origin"), null);
});
test("rejection JSON is passed to NestJS and decision conflicts remain 409", async () => {
  const path = `visits/${id}/reject`;
  const result = await merchantProxy(
    request(path, "POST", { reason: "No corresponde" }),
    path.split("/"),
    "http://127.0.0.1:3001",
    async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { reason: "No corresponde" });
      return Response.json(
        { message: "La visita ya fue resuelta." },
        { status: 409 },
      );
    },
  );
  assert.equal(result.status, 409);
});
test("misconfiguration, network and non-JSON upstream failures return safe errors", async () => {
  assert.equal(
    (await merchantProxy(request("locations"), ["locations"], undefined))
      .status,
    503,
  );
  assert.equal(
    (
      await merchantProxy(
        request("locations"),
        ["locations"],
        "https://user:secret@api.test",
      )
    ).status,
    503,
  );
  const result = await merchantProxy(
    request("locations"),
    ["locations"],
    "http://127.0.0.1:3001",
    async () => {
      throw new Error("private credentials");
    },
  );
  assert.equal(result.status, 503);
  assert.equal((await result.text()).includes("private credentials"), false);
  assert.equal(
    (
      await merchantProxy(
        request("locations"),
        ["locations"],
        "http://127.0.0.1:3001",
        async () => new Response("<html>Error</html>"),
      )
    ).status,
    502,
  );
});
test("streamed oversized JSON and invalid JSON are rejected before proxying", async () => {
  const path = `visits/${id}/reject`;
  assert.equal(
    (
      await merchantProxy(
        request(path, "POST", { reason: "x".repeat(5000) }),
        path.split("/"),
        "http://127.0.0.1:3001",
      )
    ).status,
    413,
  );
  const req = new Request("http://localhost/api/merchant/" + path, {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: "{bad",
  });
  assert.equal(
    (await merchantProxy(req, path.split("/"), "http://127.0.0.1:3001")).status,
    400,
  );
});
