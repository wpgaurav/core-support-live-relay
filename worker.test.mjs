import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker, { Conversation, Desk, runtime, signPublish, verifyToken } from './worker.js';

// Beside the tests in the public repository; in Core Support, shared with PHP under tests/fixtures/live.
const local = new URL('./vectors.json', import.meta.url);
const vectors = JSON.parse(readFileSync(existsSync(local) ? local : new URL('../../tests/fixtures/live/vectors.json', import.meta.url), 'utf8'));

const SECRET = 'synthetic-live-secret-0123456789abcdef';
const NOW = 1790400000;
const SITE = 'example.com';
const THREAD = '0b6f2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DELIVERY = '3f2b8c1e-6d4a-4f7e-9b2c-1a2b3c4d5e6f';

/** A server-side socket as a Durable Object sees it: send, close, attachments and readyState. */
function fakeSocket() {
    return {
        readyState: 1,
        sent: [],
        closed: null,
        attachment: null,
        send(data) {
            if (this.readyState !== 1) throw new TypeError('WebSocket is closed');
            this.sent.push(data);
        },
        close(code, reason) {
            // workerd refuses the reserved codes the way browsers do.
            if (code === 1005 || code === 1006) throw new TypeError('Invalid close code');
            this.readyState = 3;
            this.closed = { code, reason };
        },
        // Attachments are structured clones, so a later change to the object is not seen.
        serializeAttachment(value) { this.attachment = structuredClone(value); },
        deserializeAttachment() { return this.attachment === null ? null : structuredClone(this.attachment); },
        events() { return this.sent.map((data) => JSON.parse(data)); },
    };
}

/** DurableObjectState: hibernatable sockets survive the object; nothing else does. */
function fakeState() {
    const sockets = [];
    return {
        sockets,
        autoResponse: null,
        acceptWebSocket(socket, tags = []) { sockets.push({ socket, tags }); },
        getWebSockets(tag) { return sockets.filter((entry) => tag === undefined || entry.tags.includes(tag)).map((entry) => entry.socket); },
        setWebSocketAutoResponse(pair) { this.autoResponse = pair; },
    };
}

function namespace(Class) {
    const objects = new Map();
    return {
        objects,
        idFromName(name) { return { name }; },
        get(id) {
            if (!objects.has(id.name)) {
                const state = fakeState();
                objects.set(id.name, { state, instance: new Class(state, {}) });
            }
            const entry = objects.get(id.name);
            return { fetch: (input, init) => entry.instance.fetch(input instanceof Request ? input : new Request(input, init)) };
        },
        sockets(name) { return objects.has(name) ? objects.get(name).state.sockets.map((entry) => entry.socket) : []; },
        /** Hibernation: the object is evicted and rebuilt; its sockets stay connected. */
        wake(name) {
            const entry = objects.get(name);
            entry.instance = new Class(entry.state, {});
            return entry.instance;
        },
    };
}

let env;
let clock;
beforeEach(() => {
    env = { LIVE_SECRET: SECRET, CONVERSATIONS: namespace(Conversation), DESKS: namespace(Desk) };
    clock = NOW * 1000;
    runtime.now = () => clock;
    runtime.pair = () => {
        const server = fakeSocket();
        return [{ server }, server];
    };
    runtime.upgrade = (client) => ({ status: 101, webSocket: client });
});

/** Tokens made independently of worker.js, the way WordPress makes them: JSON with non-ASCII escaped. */
function token(claims, secret = SECRET) {
    const json = JSON.stringify(claims).replace(/[\u0080-￿]/g, (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    const payload = Buffer.from(json).toString('base64url');
    return 'v1.' + payload + '.' + createHmac('sha256', secret).update('v1\nsubscribe\n' + payload).digest('hex');
}

const visitor = (overrides = {}) => ({ role: 'visitor', site: SITE, thread: THREAD, origin: 'https://example.com', name: '', exp: NOW + 300, ...overrides });
const agent = (overrides = {}) => ({ role: 'agent', site: SITE, thread: THREAD, origin: 'https://example.com', name: 'Sam', exp: NOW + 300, ...overrides });

async function connect(claims, origin = claims.origin, signed = token(claims)) {
    return worker.fetch(new Request('https://relay.example.com/connect?token=' + encodeURIComponent(signed), { headers: { Upgrade: 'websocket', Origin: origin } }), env);
}

async function publishRequest(event, { site = SITE, secret = SECRET, timestamp = NOW, delivery = DELIVERY, body } = {}) {
    const bytes = body ?? new TextEncoder().encode(JSON.stringify(event));
    return new Request('https://relay.example.com/publish', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Core-Support-Site': site,
            'X-Core-Support-Timestamp': String(timestamp),
            'X-Core-Support-Delivery': delivery,
            'X-Core-Support-Signature': await signPublish(secret, site, timestamp, delivery, bytes),
        },
        body: bytes,
    });
}

async function publish(event, options) {
    return worker.fetch(await publishRequest(event, options), env);
}

const message = { type: 'message', thread: THREAD, data: { message: { id: 41, from: 'agent', name: 'Sam', body: 'Try it again now.', at: '2026-09-26 10:00:00' } } };

for (const vector of vectors.publish) {
    test(`reproduces the publish vector for ${vector.site} and ${vector.delivery_id}`, async () => {
        const body = Uint8Array.from(Buffer.from(vector.body_base64, 'base64'));
        assert.equal(await signPublish(vector.secret, vector.site, vector.timestamp, vector.delivery_id, body), vector.signature);
    });
}

for (const vector of vectors.tokens) {
    test(`accepts the ${vector.claims.role} token vector for ${vector.claims.origin}`, async () => {
        assert.deepEqual(await verifyToken(vector.secret, vector.token, NOW), vector.claims);
        assert.equal(token(vector.claims, vector.secret), vector.token);
    });
}

test('refuses expired, forged, tampered and malformed tokens', async () => {
    const good = token(visitor());
    assert.equal(await verifyToken(SECRET, good, NOW + 301), null, 'expired');
    assert.equal(await verifyToken('another-secret-of-at-least-32-characters', good, NOW), null, 'wrong secret');
    const [, payload, signature] = good.split('.');
    const swapped = Buffer.from(JSON.stringify(visitor({ thread: OTHER }))).toString('base64url');
    assert.equal(await verifyToken(SECRET, `v1.${swapped}.${signature}`, NOW), null, 'claims swapped');
    assert.equal(await verifyToken(SECRET, `v2.${payload}.${signature}`, NOW), null, 'version');
    assert.equal(await verifyToken(SECRET, `v1.${payload}.${signature.toUpperCase()}`, NOW), null, 'signature case');
    for (const claims of [visitor({ thread: '' }), visitor({ role: 'admin' }), visitor({ origin: 'https://example.com/' }), visitor({ exp: '1790400300' }), visitor({ site: 'bad site' })]) {
        assert.equal(await verifyToken(SECRET, token(claims), NOW), null, JSON.stringify(claims));
    }
    assert.equal(await verifyToken(SECRET, 'v1.not-json.' + '0'.repeat(64), NOW), null);
});

test('a signed message reaches the visitor and agents of that conversation only', async () => {
    const mine = (await connect(visitor())).webSocket.server;
    const theirs = (await connect(agent())).webSocket.server;
    const elsewhere = (await connect(visitor({ thread: OTHER }))).webSocket.server;
    const desk = (await connect(agent({ thread: '' }))).webSocket.server;
    [mine, theirs, elsewhere, desk].forEach((socket) => { socket.sent = []; });

    const response = await publish(message);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result, { accepted: true, delivery_id: DELIVERY, delivered: 2 });
    assert.deepEqual(mine.events(), [{ message: message.data.message, type: 'message', thread: THREAD }]);
    assert.deepEqual(theirs.events(), mine.events());
    assert.deepEqual(elsewhere.sent, [], 'another conversation heard it');
    assert.deepEqual(desk.sent, [], 'messages do not go to the queue');
});

test('a status change reaches the conversation and the agents\' queue', async () => {
    const mine = (await connect(visitor())).webSocket.server;
    const desk = (await connect(agent({ thread: '' }))).webSocket.server;
    const result = await (await publish({ type: 'status', thread: THREAD, data: { status: 'live', agent_name: 'Sam' } })).json();
    assert.equal(result.delivered, 2);
    assert.deepEqual(mine.events().at(-1), { status: 'live', agent_name: 'Sam', type: 'status', thread: THREAD });
    assert.deepEqual(desk.events().at(-1), mine.events().at(-1));
});

test('a test event reaches only the queue and reports how many screens heard it', async () => {
    assert.deepEqual(await (await publish({ type: 'test', data: {} })).json(), { accepted: true, delivery_id: DELIVERY, delivered: 0 });
    await connect(agent({ thread: '' }));
    assert.equal((await (await publish({ type: 'test', data: {} })).json()).delivered, 1);
    assert.equal(env.CONVERSATIONS.objects.size, 0);
});

test('publish refuses bad signatures, replays and malformed events', async () => {
    const cases = [
        [await publishRequest(message, { secret: 'another-secret-of-at-least-32-characters' }), 401, 'bad_signature'],
        [await publishRequest(message, { timestamp: NOW - 301 }), 401, 'stale_timestamp'],
        [await publishRequest(message, { timestamp: NOW + 301 }), 401, 'stale_timestamp'],
        [await publishRequest(message, { delivery: 'short' }), 400, 'malformed_headers'],
        [await publishRequest({ ...message, type: 'delete' }), 400, 'invalid_event'],
        [await publishRequest({ ...message, thread: '../desk' }), 400, 'invalid_event'],
        [await publishRequest({ ...message, data: [] }), 400, 'invalid_event'],
        [await publishRequest(null, { body: new TextEncoder().encode('{nope') }), 400, 'invalid_json'],
        [await publishRequest(null, { body: new Uint8Array(64 * 1024 + 1) }), 413, 'too_large'],
    ];
    for (const [request, status, error] of cases) {
        const response = await worker.fetch(request, env);
        assert.equal(response.status, status, error);
        assert.equal((await response.json()).error, error);
    }

    // The signature binds the body and the site: changing either after signing fails.
    const signed = await publishRequest(message);
    const tampered = new Request(signed.url, { method: 'POST', headers: signed.headers, body: JSON.stringify({ ...message, data: { message: { ...message.data.message, body: 'Changed' } } }) });
    assert.equal((await worker.fetch(tampered, env)).status, 401);
    const moved = new Headers(signed.headers);
    moved.set('X-Core-Support-Site', 'example.org');
    assert.equal((await worker.fetch(new Request(signed.url, { method: 'POST', headers: moved, body: JSON.stringify(message) }), env)).status, 401);

    assert.equal((await worker.fetch(new Request('https://relay.example.com/publish'), env)).status, 405);
});

test('an unconfigured or weakly configured Worker refuses to publish or connect', async () => {
    for (const broken of [{ ...env, LIVE_SECRET: 'short' }, { ...env, LIVE_SECRET: undefined }, { ...env, DESKS: undefined }]) {
        assert.equal((await worker.fetch(await publishRequest(message), broken)).status, 503);
        const request = new Request('https://relay.example.com/connect?token=' + token(visitor()), { headers: { Upgrade: 'websocket', Origin: 'https://example.com' } });
        assert.equal((await worker.fetch(request, broken)).status, 503);
    }
    const health = await (await worker.fetch(new Request('https://relay.example.com/health'), { ...env, LIVE_SECRET: 'short' })).json();
    assert.deepEqual(health, { ok: true, service: 'core-support-live-relay', version: 1, configured: false });
});

test('connect checks the token and the Origin without asking WordPress', async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { calls++; throw new Error('No network in the Worker'); };
    try {
        assert.equal((await connect(visitor({ exp: NOW - 1 }))).status, 401, 'expired');
        assert.equal((await connect(visitor(), 'https://evil.example.net')).status, 403, 'wrong origin');
        assert.equal((await connect(visitor(), '')).status, 403, 'no origin');
        assert.equal((await connect(visitor(), 'https://example.com', token(visitor()).slice(0, -1) + '0')).status, 401, 'forged');
        const plain = await worker.fetch(new Request('https://relay.example.com/connect?token=' + token(visitor())), env);
        assert.equal(plain.status, 426);

        // A connected site's token carries that site's origin.
        const shop = await connect(visitor({ origin: 'https://shop.example.net' }), 'https://shop.example.net');
        assert.equal(shop.status, 101);
        assert.equal((await connect(visitor({ origin: 'https://shop.example.net' }), 'https://example.com')).status, 403);
    } finally {
        globalThis.fetch = original;
    }
    assert.equal(calls, 0);
});

test('a token for one thread joins only that thread\'s conversation', async () => {
    await connect(visitor({ thread: OTHER }));
    assert.equal(env.CONVERSATIONS.sockets(`${SITE}#${OTHER}`).length, 1);
    assert.equal(env.CONVERSATIONS.sockets(`${SITE}#${THREAD}`).length, 0);
    // The same thread on another help desk sharing the Worker is a different conversation.
    await connect(visitor({ site: 'example.org' }));
    assert.equal(env.CONVERSATIONS.sockets(`example.org#${THREAD}`).length, 1);
    assert.equal(env.CONVERSATIONS.sockets(`${SITE}#${THREAD}`).length, 0);
});

test('typing goes from visitor to agents and back, throttled and never to the visitor\'s own tabs', async () => {
    const tab = (await connect(visitor())).webSocket.server;
    const otherTab = (await connect(visitor())).webSocket.server;
    const sam = (await connect(agent())).webSocket.server;
    const room = env.CONVERSATIONS.objects.get(`${SITE}#${THREAD}`).instance;
    [tab, otherTab, sam].forEach((socket) => { socket.sent = []; });

    await room.webSocketMessage(tab, JSON.stringify({ type: 'typing', from: 'agent', name: 'Spoofed' }));
    assert.deepEqual(sam.events(), [{ type: 'typing', thread: THREAD, from: 'visitor', name: '' }], 'the role comes from the token');
    assert.deepEqual(otherTab.sent, []);
    assert.deepEqual(tab.sent, []);

    await room.webSocketMessage(tab, JSON.stringify({ type: 'typing' }));
    assert.equal(sam.sent.length, 1, 'not throttled');
    clock += 1000;
    await room.webSocketMessage(tab, JSON.stringify({ type: 'typing' }));
    assert.equal(sam.sent.length, 2);

    await room.webSocketMessage(sam, JSON.stringify({ type: 'typing' }));
    assert.deepEqual(tab.events(), [{ type: 'typing', thread: THREAD, from: 'agent', name: 'Sam' }]);
    assert.deepEqual(otherTab.events(), tab.events());

    // Anything else from a browser is dropped: browsers only carry typing to the Worker.
    for (const data of [JSON.stringify({ type: 'message', body: 'Hi' }), 'x'.repeat(2000), '{', new Uint8Array(4)]) {
        clock += 1000;
        await room.webSocketMessage(tab, data);
    }
    assert.equal(sam.sent.length, 2);
});

test('agents see the visitor come and go', async () => {
    const sam = (await connect(agent())).webSocket.server;
    assert.deepEqual(sam.events(), [{ type: 'presence', visitor: false }]);
    const tab = (await connect(visitor())).webSocket.server;
    const otherTab = (await connect(visitor())).webSocket.server;
    assert.deepEqual(sam.events().slice(1), [{ type: 'presence', visitor: true }, { type: 'presence', visitor: true }]);
    const late = (await connect(agent({ name: 'Alex' }))).webSocket.server;
    assert.deepEqual(late.events(), [{ type: 'presence', visitor: true }]);

    const room = env.CONVERSATIONS.objects.get(`${SITE}#${THREAD}`).instance;
    tab.readyState = 2;
    await room.webSocketClose(tab, 1006, '');
    assert.deepEqual(tab.closed, { code: 1000, reason: '' }, 'a reserved code is not echoed back');
    assert.equal(sam.sent.length, 3, 'one tab is still open');
    otherTab.readyState = 2;
    await room.webSocketClose(otherTab, 1001, 'going away');
    assert.deepEqual(sam.events().at(-1), { type: 'presence', visitor: false });
});

test('an object woken from hibernation still fans out, relays typing and knows who is here', async () => {
    const tab = (await connect(visitor())).webSocket.server;
    const sam = (await connect(agent())).webSocket.server;
    const name = `${SITE}#${THREAD}`;
    const before = env.CONVERSATIONS.objects.get(name).instance;
    const woken = env.CONVERSATIONS.wake(name);
    assert.notEqual(woken, before);
    [tab, sam].forEach((socket) => { socket.sent = []; });

    assert.equal((await (await publish(message)).json()).delivered, 2);
    await woken.webSocketMessage(tab, JSON.stringify({ type: 'typing' }));
    assert.deepEqual(sam.events().map((event) => event.type), ['message', 'typing']);

    const later = (await connect(agent({ name: 'Alex' }))).webSocket.server;
    assert.deepEqual(later.events(), [{ type: 'presence', visitor: true }]);
    tab.readyState = 2;
    await env.CONVERSATIONS.wake(name).webSocketClose(tab, 1000, '');
    assert.deepEqual(sam.events().at(-1), { type: 'presence', visitor: false });
});

test('the runtime answers keep-alive pings without waking the object', () => {
    const original = globalThis.WebSocketRequestResponsePair;
    globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { this.request = request; this.response = response; } };
    try {
        const state = fakeState();
        new Conversation(state, {});
        assert.deepEqual({ ...state.autoResponse }, { request: 'ping', response: 'pong' });
        const desk = fakeState();
        new Desk(desk, {});
        assert.equal(desk.autoResponse.request, 'ping');
    } finally {
        globalThis.WebSocketRequestResponsePair = original;
    }
});

test('a socket is closed once its session runs out, so the browser fetches a new token', async () => {
    const tab = (await connect(visitor())).webSocket.server;
    clock += 60 * 60 * 1000 + 1;
    assert.equal((await (await publish(message, { timestamp: Math.floor(clock / 1000) })).json()).delivered, 0);
    assert.deepEqual(tab.closed, { code: 4001, reason: 'session_expired' });

    const sam = (await connect(agent({ exp: Math.floor(clock / 1000) + 300 }))).webSocket.server;
    clock += 60 * 60 * 1000 + 1;
    await env.CONVERSATIONS.objects.get(`${SITE}#${THREAD}`).instance.webSocketMessage(sam, JSON.stringify({ type: 'typing' }));
    assert.deepEqual(sam.closed, { code: 4001, reason: 'session_expired' });
});

test('health answers GET only, and unknown paths are not found', async () => {
    const response = await worker.fetch(new Request('https://relay.example.com/health'), env);
    assert.deepEqual(await response.json(), { ok: true, service: 'core-support-live-relay', version: 1, configured: true });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await worker.fetch(new Request('https://relay.example.com/health', { method: 'POST' }), env)).status, 405);
    assert.equal((await worker.fetch(new Request('https://relay.example.com/wp-admin'), env)).status, 404);
});

test('a failing Durable Object fails the publish, so WordPress logs it', async () => {
    env.CONVERSATIONS = { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }) };
    const response = await publish(message);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'relay_error' });
});
