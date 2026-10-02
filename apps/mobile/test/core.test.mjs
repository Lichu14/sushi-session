import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, createApiClient } from '../src/core/api-client.ts';
import { createSushiApi } from '../src/core/sushi-api.ts';
import { parseCheckInQr } from '../src/core/qr.ts';
import { Counter } from '../src/core/counter.ts';
import { createChunkedStorage } from '../src/core/secure-storage.ts';
import { recentVisitAction } from '../src/core/check-in-recovery.ts';

const initial = () => ({
  id: randomUUID(),
  visitId: randomUUID(),
  pieceCount: 0,
  version: 1,
  status: 'ACTIVE',
  startedAt: new Date().toISOString(),
  endedAt: null,
});
function fixture() {
  let remote = initial();
  const updates = [],
    completions = [];
  const api = {
    async updateSession(id, pieceCount, version) {
      updates.push({ id, pieceCount, version });
      if (version !== remote.version || remote.status !== 'ACTIVE')
        throw new ApiError(409, 'Conflict');
      remote = { ...remote, pieceCount, version: version + 1 };
      return remote;
    },
    async completeSession(id, version) {
      completions.push({ id, version });
      if (version !== remote.version || remote.status !== 'ACTIVE')
        throw new ApiError(409, 'Conflict');
      remote = {
        ...remote,
        version: version + 1,
        status: 'COMPLETED',
        endedAt: new Date().toISOString(),
      };
      return remote;
    },
    async findSession() {
      return remote;
    },
  };
  return {
    api,
    updates,
    completions,
    get remote() {
      return remote;
    },
    change(value) {
      remote = { ...remote, ...value };
    },
  };
}
test('QR versioned JSON: validates shape and never reflects raw data in errors', () => {
  const locationId = randomUUID(),
    token = 'private-token';
  assert.deepEqual(
    parseCheckInQr(JSON.stringify({ v: 1, locationId, token })),
    { locationId, token },
  );
  for (const raw of [
    'https://attacker.test/?token=private-token',
    'private-token',
    JSON.stringify({ v: 2, locationId, token }),
    JSON.stringify({ v: 1, locationId, token, extra: true }),
    JSON.stringify({ v: 1, locationId, token: 'x'.repeat(2049) }),
  ]) {
    assert.throws(
      () => parseCheckInQr(raw),
      (e) => !e.message.includes(token),
    );
  }
});
test('batched taps, limits, and flush-before-complete use latest version', async (t) => {
  const f = fixture(),
    counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(-1);
  assert.equal(counter.getSnapshot().count, 0);
  for (let i = 0; i < 20; i++) counter.tap(1);
  counter.tap(-1);
  assert.equal(f.updates.length, 0);
  assert.equal(counter.getSnapshot().count, 19);
  await counter.finish();
  assert.deepEqual(
    f.updates.map((x) => [x.pieceCount, x.version]),
    [[19, 1]],
  );
  assert.equal(f.completions[0].version, 2);
  assert.equal(counter.getSnapshot().session.status, 'COMPLETED');
  counter.tap(1);
  assert.equal(counter.getSnapshot().count, 19);
});
test('debounce sends once after a burst, max count remains 1000', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(),
    counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  for (let i = 0; i < 1100; i++) counter.tap(1);
  assert.equal(counter.getSnapshot().count, 1000);
  t.mock.timers.tick(599);
  assert.equal(f.updates.length, 0);
  t.mock.timers.tick(1);
  await counter.flush();
  assert.equal(f.updates.length, 1);
});
test('taps during PATCH are retained; finalization waits and sends the last absolute value', async (t) => {
  const f = fixture();
  let release;
  const original = f.api.updateSession;
  f.api.updateSession = async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return original(...args);
  };
  const counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(1);
  const first = counter.flush();
  counter.tap(1);
  counter.tap(1);
  release();
  await first;
  assert.equal(counter.getSnapshot().count, 3);
  assert.equal(f.remote.pieceCount, 1);
  f.api.updateSession = original;
  await counter.finish();
  assert.equal(f.remote.pieceCount, 3);
  assert.deepEqual(
    f.updates.map((x) => x.version),
    [1, 2],
  );
  assert.equal(f.completions[0].version, 3);
});
test('409 reloads and blocks writes until the user chooses the local or remote count', async (t) => {
  const f = fixture(),
    counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(1);
  f.change({ pieceCount: 8, version: 2 });
  await assert.rejects(counter.flush());
  assert.equal(counter.getSnapshot().conflict, true);
  assert.equal(counter.getSnapshot().session.version, 2);
  assert.equal(counter.getSnapshot().count, 1);
  counter.tap(1);
  assert.equal(counter.getSnapshot().count, 1);
  await assert.rejects(counter.finish());
  assert.equal(f.completions.length, 0);
  counter.resolveConflict(true);
  await counter.flush();
  assert.equal(f.remote.pieceCount, 1);
  assert.equal(f.remote.version, 3);
});
test('network failure keeps draft, requires reread, and recovers without blind replay', async (t) => {
  const f = fixture(),
    original = f.api.updateSession;
  f.api.updateSession = async () => {
    throw new ApiError(0, 'Offline');
  };
  const counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(4);
  await assert.rejects(counter.flush());
  assert.equal(counter.getSnapshot().count, 4);
  assert.equal(counter.getSnapshot().needsReload, true);
  f.api.updateSession = original;
  await counter.reload();
  counter.resolveConflict(true);
  await counter.finish();
  assert.equal(f.remote.pieceCount, 4);
});
test('lost completion response reconciles completed state through history', async (t) => {
  const f = fixture(),
    original = f.api.completeSession;
  f.api.completeSession = async (...args) => {
    await original(...args);
    throw new ApiError(0, 'Lost response');
  };
  const counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(5);
  await assert.rejects(counter.finish());
  assert.equal(counter.getSnapshot().session.status, 'COMPLETED');
  assert.equal(counter.getSnapshot().count, 5);
  assert.equal(f.completions.length, 1);
});
test('completion remains unconfirmed while the server reply is pending', async (t) => {
  const f = fixture(),
    original = f.api.completeSession;
  let release;
  f.api.completeSession = async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return original(...args);
  };
  const counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  const finishing = counter.finish();
  assert.equal(counter.getSnapshot().finishing, true);
  assert.equal(counter.getSnapshot().session.status, 'ACTIVE');
  counter.tap(5);
  assert.equal(counter.getSnapshot().count, 0);
  release();
  await finishing;
  assert.equal(counter.getSnapshot().session.status, 'COMPLETED');
  assert.equal(counter.getSnapshot().session.pieceCount, 0);
});
test('lost completion and failed reread show no success until a later confirmed reread', async (t) => {
  const f = fixture(),
    complete = f.api.completeSession,
    read = f.api.findSession;
  f.api.completeSession = async (...args) => {
    await complete(...args);
    throw new ApiError(0, 'Lost response');
  };
  f.api.findSession = async () => {
    throw new ApiError(0, 'Offline');
  };
  const counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(9);
  await assert.rejects(counter.finish());
  assert.equal(f.remote.status, 'COMPLETED');
  assert.equal(counter.getSnapshot().session.status, 'ACTIVE');
  assert.equal(counter.getSnapshot().needsReload, true);
  assert.equal(counter.getSnapshot().count, 9);
  await assert.rejects(counter.finish());
  assert.equal(f.completions.length, 1);
  f.api.findSession = read;
  await counter.reload();
  assert.equal(counter.getSnapshot().session.status, 'COMPLETED');
  assert.equal(counter.getSnapshot().session.pieceCount, 9);
  assert.equal(counter.getSnapshot().error, null);
  counter.tap(1);
  await counter.finish();
  assert.equal(counter.getSnapshot().count, 9);
  assert.equal(f.completions.length, 1);
});
test('failed final save retains draft and never completes the session', async (t) => {
  const f = fixture();
  f.api.updateSession = async () => {
    throw new ApiError(0, 'Offline');
  };
  const counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(3);
  await assert.rejects(counter.finish());
  assert.equal(counter.getSnapshot().session.status, 'ACTIVE');
  assert.equal(counter.getSnapshot().count, 3);
  assert.equal(counter.getSnapshot().conflict, true);
  assert.equal(f.completions.length, 0);
});
test('rereading a remotely completed session replaces a stale local draft with the confirmed result', async (t) => {
  const f = fixture(),
    counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(3);
  f.change({
    status: 'COMPLETED',
    pieceCount: 12,
    version: 3,
    endedAt: new Date().toISOString(),
  });
  await counter.reload();
  assert.equal(counter.getSnapshot().count, 12);
  assert.equal(counter.getSnapshot().session.status, 'COMPLETED');
  assert.equal(counter.getSnapshot().conflict, false);
  assert.equal(f.updates.length, 0);
});
test('closed or disposed counters cannot produce new writes', async () => {
  const f = fixture(),
    counter = new Counter(f.api, { ...f.remote, status: 'COMPLETED' });
  counter.tap(2);
  await counter.finish();
  counter.dispose();
  counter.tap(3);
  await counter.flush();
  assert.equal(f.updates.length, 0);
  assert.equal(f.completions.length, 0);
});
test('API Bearer, a single shared refresh, and one retry per request', async () => {
  let refreshes = 0,
    current = 'old';
  const headers = [];
  const auth = {
    async getSession() {
      return {
        data: { session: { access_token: current, user: { id: 'user-a' } } },
        error: null,
      };
    },
    async refreshSession() {
      refreshes++;
      await new Promise((r) => setTimeout(r, 10));
      current = 'new';
      return this.getSession();
    },
  };
  const request = createApiClient(
    'https://api.test',
    auth,
    async (_url, options) => {
      const token = options.headers.Authorization;
      headers.push(token);
      return token === 'Bearer old'
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true });
    },
  );
  const results = await Promise.all([request('/me'), request('/me')]);
  assert.equal(results[0].ok, true);
  assert.equal(refreshes, 1);
  assert.equal(headers.length, 4);
});
test('API does not send unauthenticated requests or endlessly retry 401', async () => {
  let calls = 0,
    refreshes = 0;
  const none = {
    getSession: async () => ({ data: { session: null }, error: null }),
    refreshSession: async () => {
      throw Error();
    },
  };
  await assert.rejects(
    createApiClient('https://api.test', none, async () => {
      calls++;
    })('/me'),
    (e) => e.status === 401,
  );
  assert.equal(calls, 0);
  const auth = {
    getSession: async () => ({
      data: { session: { access_token: 'x', user: { id: 'u' } } },
      error: null,
    }),
    refreshSession: async () => {
      refreshes++;
      return auth.getSession();
    },
  };
  await assert.rejects(
    createApiClient('https://api.test', auth, async () => {
      calls++;
      return new Response(null, { status: 401 });
    })('/me'),
    (e) => e.status === 401,
  );
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});
test('session lookup scans all history pages; duplicate start recovers by visitId', async () => {
  const target = initial(),
    paths = [];
  const api = createSushiApi(async (path, method) => {
    paths.push(path);
    if (method === 'POST') throw new ApiError(409, 'Duplicate');
    return path.includes('cursor=')
      ? { items: [target], nextCursor: null }
      : { items: [initial()], nextCursor: 'page2' };
  });
  assert.equal((await api.findSession(target.id)).id, target.id);
  assert.equal((await api.startSession(target.visitId)).id, target.id);
  assert.equal(paths.length, 5);
});
test('recent visit recovery reads the exact visit across pages, without writes', async () => {
  for (const [status, action] of [
    ['ACTIVE', 'Continuar conteo'],
    ['COMPLETED', 'Ver resultado'],
    ['CANCELLED', 'Ver sesión cancelada'],
  ]) {
    const target = { ...initial(), status },
      paths = [];
    const api = createSushiApi(async (path, method = 'GET') => {
      assert.equal(method, 'GET');
      paths.push(path);
      return path.includes('cursor=')
        ? { items: [target], nextCursor: null }
        : { items: [initial()], nextCursor: 'older' };
    });
    const recovered = await api.findVisitSession(target.visitId);
    assert.equal(recovered.id, target.id);
    assert.equal(recentVisitAction(recovered), action);
    assert.equal(paths.length, 2);
  }
});
test('recent visit with no session allows start; a failed history read never means no session', async () => {
  const target = initial(),
    writes = [];
  const api = createSushiApi(async (path, method = 'GET') => {
    if (method === 'POST') {
      writes.push(path);
      return target;
    }
    return { items: [initial()], nextCursor: null };
  });
  const recovered = await api.findVisitSession(target.visitId);
  assert.equal(recovered, null);
  assert.equal(recentVisitAction(recovered), 'Iniciar conteo de esta visita');
  assert.equal(writes.length, 0);
  assert.equal((await api.startSession(target.visitId)).id, target.id);
  assert.deepEqual(writes, [`/visits/${target.visitId}/session`]);
  for (const status of [0, 404, 409, 503]) {
    const failed = createSushiApi(async () => {
      throw new ApiError(status, 'Unavailable');
    });
    await assert.rejects(
      failed.findVisitSession(target.visitId),
      (e) => e.status === status,
    );
  }
});
test('only the stable check-in cooldown code with a valid visit ID enables recent-visit recovery', async () => {
  const visitId = randomUUID();
  const auth = {
    getSession: async () => ({
      data: { session: { access_token: 'private', user: { id: 'u' } } },
      error: null,
    }),
    refreshSession: async () => {
      throw Error();
    },
  };
  const cooldown = {
    code: 'CHECK_IN_COOLDOWN',
    visitId,
    message: 'private-response',
  };
  for (const [data, status, path, expected] of [
    [cooldown, 409, '/check-ins', visitId],
    [{ ...cooldown, code: 'OTHER_CONFLICT' }, 409, '/check-ins', undefined],
    [{ message: 'private-response' }, 409, '/check-ins', undefined],
    [{ ...cooldown, visitId: 'invalid' }, 409, '/check-ins', undefined],
    [null, 409, '/check-ins', undefined],
    [cooldown, 400, '/check-ins', undefined],
    [cooldown, 409, '/sessions/example/complete', undefined],
  ]) {
    const request = createApiClient('https://api.test', auth, async () =>
      Response.json(data, { status }),
    );
    await assert.rejects(
      request(path, 'POST', {}),
      (e) =>
        e.status === status &&
        e.cooldownVisitId === expected &&
        !e.message.includes('private'),
    );
  }
  const invalidJson = createApiClient(
    'https://api.test',
    auth,
    async () => new Response('private-response', { status: 409 }),
  );
  await assert.rejects(
    invalidJson('/check-ins', 'POST', {}),
    (e) =>
      e.status === 409 &&
      e.cooldownVisitId === undefined &&
      !e.message.includes('private'),
  );
});
test('secure storage chunks large Unicode sessions, restores and removes all current chunks', async () => {
  const values = new Map();
  const store = {
    getItem: async (k) => values.get(k) ?? null,
    setItem: async (k, v) => {
      assert.ok(Buffer.byteLength(v) <= 2048);
      values.set(k, v);
    },
    removeItem: async (k) => {
      values.delete(k);
    },
  };
  const storage = createChunkedStorage(store, randomUUID),
    text = '🍣'.repeat(3000);
  await storage.setItem('auth', text);
  assert.equal(await storage.getItem('auth'), text);
  await storage.setItem('auth', 'new session');
  assert.equal(await storage.getItem('auth'), 'new session');
  assert.equal(values.size, 2);
  await storage.removeItem('auth');
  assert.equal(values.size, 0);
  assert.equal(await storage.getItem('auth'), null);
});
test('secure storage failed write does not replace existing session', async () => {
  const values = new Map();
  let fail = false;
  const storage = createChunkedStorage(
    {
      getItem: async (k) => values.get(k) ?? null,
      setItem: async (k, v) => {
        if (fail && k.endsWith('.1')) throw Error('device write error');
        values.set(k, v);
      },
      removeItem: async (k) => {
        values.delete(k);
      },
    },
    randomUUID,
  );
  await storage.setItem('auth', 'previous');
  fail = true;
  await assert.rejects(storage.setItem('auth', 'a'.repeat(2000)));
  assert.equal(await storage.getItem('auth'), 'previous');
  assert.equal(values.size, 2);
});

test('continuous taps still flush within two seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(),
    counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  counter.tap(1);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(450);
    counter.tap(1);
  }
  assert.equal(f.updates.length, 0);
  t.mock.timers.tick(200);
  await counter.flush();
  assert.equal(f.updates.length, 1);
  assert.equal(f.remote.pieceCount, 5);
});

test('failed conflict reread blocks further taps and finalization', async (t) => {
  const f = fixture(),
    counter = new Counter(f.api, f.remote);
  t.after(() => counter.dispose());
  f.change({ pieceCount: 7, version: 2 });
  counter.tap(1);
  f.api.findSession = async () => {
    throw new ApiError(0, 'Offline');
  };
  await assert.rejects(counter.flush());
  assert.equal(counter.getSnapshot().needsReload, true);
  counter.tap(1);
  assert.equal(counter.getSnapshot().count, 1);
  await assert.rejects(counter.finish());
  assert.equal(f.completions.length, 0);
});

test('API never replays a write under a different user after refresh', async () => {
  let calls = 0;
  const result = (id) => ({
    data: { session: { access_token: 'token', user: { id } } },
    error: null,
  });
  const auth = {
    getSession: async () => result('first'),
    refreshSession: async () => result('second'),
  };
  const request = createApiClient('https://api.test', auth, async () => {
    calls++;
    return new Response(null, { status: 401 });
  });
  await assert.rejects(
    request('/check-ins', 'POST', {}),
    (e) => e.status === 401,
  );
  assert.equal(calls, 1);
});

test('API timeout and server errors never echo sensitive response content', async () => {
  const auth = {
    getSession: async () => ({
      data: { session: { access_token: 'private', user: { id: 'u' } } },
      error: null,
    }),
    refreshSession: async () => {
      throw Error();
    },
  };
  const request = createApiClient(
    'https://api.test',
    auth,
    async (_url, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener('abort', () =>
          reject(new Error('private')),
        );
      }),
    5,
  );
  await assert.rejects(
    request('/me'),
    (e) => e.status === 0 && !e.message.includes('private'),
  );
  const server = createApiClient(
    'https://api.test',
    auth,
    async () => new Response('private', { status: 500 }),
  );
  await assert.rejects(
    server('/me'),
    (e) => e.status === 500 && !e.message.includes('private'),
  );
});
