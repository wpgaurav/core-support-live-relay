/** Customer-owned Cloudflare Worker for Core Support live chat. See README.md for the contract. */
const MAX_PUBLISH_BYTES = 64 * 1024;
const MAX_SOCKET_MESSAGE = 1024;
const TOLERANCE_SECONDS = 300;
/** A socket lives at most this long; the browser then asks WordPress for a new token and reconnects. */
const SESSION_MS = 60 * 60 * 1000;
const TYPING_EVERY_MS = 1000;
const OPEN = 1;
const EVENTS = ['message', 'status', 'test'];
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SITE = /^[A-Za-z0-9._~:/-]{1,200}$/;
const DELIVERY = /^[A-Za-z0-9-]{16,64}$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;

/**
 * What tests replace. workerd's Response accepts status 101 with a webSocket and has
 * WebSocketPair; Node has neither.
 */
export const runtime = {
    now: () => Date.now(),
    pair: () => {
        const pair = new WebSocketPair();
        return [pair[0], pair[1]];
    },
    upgrade: (client) => new Response(null, { status: 101, webSocket: client }),
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            if (url.pathname === '/' || url.pathname === '/health') {
                return request.method === 'GET' ? json({ ok: true, service: 'core-support-live-relay', version: 1, configured: configured(env) }) : json({ error: 'method_not_allowed' }, 405);
            }
            if (url.pathname === '/publish') return await publish(request, env);
            if (url.pathname === '/connect') return await connect(request, env, url);
            return json({ error: 'not_found' }, 404);
        } catch {
            return json({ error: 'relay_error' }, 500);
        }
    },
};

/** WordPress → Worker: one signed event after a write, fanned out to the sockets that need it. */
export async function publish(request, env) {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!configured(env)) return json({ error: 'not_configured' }, 503);
    const body = await readLimited(request, MAX_PUBLISH_BYTES);
    if (body === null) return json({ error: 'too_large' }, 413);
    const site = request.headers.get('X-Core-Support-Site') || '';
    const timestamp = request.headers.get('X-Core-Support-Timestamp') || '';
    const delivery = request.headers.get('X-Core-Support-Delivery') || '';
    const signature = request.headers.get('X-Core-Support-Signature') || '';
    if (!SITE.test(site) || !/^\d{1,12}$/.test(timestamp) || !DELIVERY.test(delivery) || !signature.startsWith('v1=')) {
        return json({ error: 'malformed_headers' }, 400);
    }
    if (Math.abs(Math.floor(runtime.now() / 1000) - Number(timestamp)) > TOLERANCE_SECONDS) return json({ error: 'stale_timestamp' }, 401);
    if (!(await verifyHex(env.LIVE_SECRET, publishPayload(site, Number(timestamp), delivery, await sha256(body)), signature.slice(3)))) {
        return json({ error: 'bad_signature' }, 401);
    }
    let event;
    try { event = JSON.parse(new TextDecoder().decode(body)); } catch { return json({ error: 'invalid_json' }, 400); }
    if (!event || !EVENTS.includes(event.type) || !isObject(event.data) || (event.type !== 'test' && !THREAD.test(event.thread))) {
        return json({ error: 'invalid_event' }, 400);
    }
    const thread = event.type === 'test' ? '' : event.thread;
    const message = JSON.stringify({ ...event.data, type: event.type, thread });
    let delivered = 0;
    // Messages reach the conversation only; status changes also reach the agents' queue.
    if (thread !== '') delivered += await deliver(env.CONVERSATIONS, site + '#' + thread, message);
    if (event.type !== 'message') delivered += await deliver(env.DESKS, site, message);
    return json({ accepted: true, delivery_id: delivery, delivered });
}

/** Browser → Worker: a WebSocket for one conversation, or for the agents' queue, checked without asking WordPress. */
export async function connect(request, env, url) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'upgrade_required' }, 426);
    if (!configured(env)) return json({ error: 'not_configured' }, 503);
    const claims = await verifyToken(env.LIVE_SECRET, url.searchParams.get('token') || '', Math.floor(runtime.now() / 1000));
    if (claims === null) return json({ error: 'invalid_token' }, 401);
    if ((request.headers.get('Origin') || '') !== claims.origin) return json({ error: 'origin_not_allowed' }, 403);
    const namespace = claims.thread !== '' ? env.CONVERSATIONS : env.DESKS;
    const name = claims.thread !== '' ? claims.site + '#' + claims.thread : claims.site;
    const headers = new Headers(request.headers);
    // Only the Worker reaches a Durable Object, so the object trusts this header.
    headers.set('X-Live-Claims', JSON.stringify(claims));
    return namespace.get(namespace.idFromName(name)).fetch(new Request(request, { headers }));
}

async function deliver(namespace, name, message) {
    const response = await namespace.get(namespace.idFromName(name)).fetch('https://live.internal/publish', { method: 'POST', body: message });
    if (!response.ok) throw new Error('delivery_failed');
    const result = await response.json();
    return Number.isSafeInteger(result.delivered) ? result.delivered : 0;
}

/**
 * Sockets in one Durable Object. Everything it knows lives in the sockets' tags and attachments,
 * so an object woken from hibernation behaves exactly like one that never slept.
 */
class Room {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        // The runtime answers keep-alive pings itself, without waking the object.
        if (typeof WebSocketRequestResponsePair === 'function') {
            ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
        }
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/publish' && request.method === 'POST') {
            return json({ delivered: this.broadcast(await request.text(), () => true) });
        }
        if (url.pathname === '/connect') {
            const claims = JSON.parse(request.headers.get('X-Live-Claims') || 'null');
            if (!claims) return json({ error: 'invalid_token' }, 401);
            const [client, server] = runtime.pair();
            this.ctx.acceptWebSocket(server, [claims.role]);
            server.serializeAttachment({ role: claims.role, name: claims.name, thread: claims.thread, until: runtime.now() + SESSION_MS, typed: 0 });
            this.joined(server, claims.role);
            return runtime.upgrade(client);
        }
        return json({ error: 'not_found' }, 404);
    }

    /** Sends to every open socket that passes $wanted; closes sockets whose session ran out. */
    broadcast(message, wanted) {
        let delivered = 0;
        const now = runtime.now();
        for (const socket of this.ctx.getWebSockets()) {
            if (socket.readyState !== OPEN || !wanted(socket)) continue;
            const info = socket.deserializeAttachment() || {};
            if (!(info.until > now)) {
                close(socket, 4001, 'session_expired');
                continue;
            }
            try { socket.send(message); delivered++; } catch { /* Closing already. */ }
        }
        return delivered;
    }

    open(role, except = null) {
        return this.ctx.getWebSockets(role).filter((socket) => socket !== except && socket.readyState === OPEN);
    }

    async webSocketMessage(socket, data) {
        const info = socket.deserializeAttachment() || {};
        if (!(info.until > runtime.now())) {
            close(socket, 4001, 'session_expired');
            return;
        }
        if (typeof data !== 'string' || data.length > MAX_SOCKET_MESSAGE) return;
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message && message.type === 'typing') this.typing(socket, info);
    }

    async webSocketClose(socket, code, reason) {
        // Completes the closing handshake; 1005 and 1006 cannot be sent back, so they become 1000.
        close(socket, code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason || '');
        this.left(socket);
    }

    async webSocketError(socket) {
        this.left(socket);
    }

    joined() {}

    left() {}

    typing() {}
}

/** One live chat: the visitor's tabs and the agents who have it open. */
export class Conversation extends Room {
    joined(socket, role) {
        if (role === 'visitor') {
            this.tell(this.open('agent'), { type: 'presence', visitor: true });
        } else {
            this.tell([socket], { type: 'presence', visitor: this.open('visitor', socket).length > 0 });
        }
    }

    left(socket) {
        const info = socket.deserializeAttachment() || {};
        if (info.role === 'visitor' && this.open('visitor', socket).length === 0) {
            this.tell(this.open('agent'), { type: 'presence', visitor: false });
        }
    }

    /** Typing goes to everyone else in the chat, never to the visitor's own other tabs. Never stored. */
    typing(socket, info) {
        const now = runtime.now();
        if (now - (info.typed || 0) < TYPING_EVERY_MS) return;
        socket.serializeAttachment({ ...info, typed: now });
        const message = JSON.stringify({ type: 'typing', thread: info.thread, from: info.role, name: info.name });
        this.broadcast(message, (other) => other !== socket && !(info.role === 'visitor' && (other.deserializeAttachment() || {}).role === 'visitor'));
    }

    tell(sockets, event) {
        const message = JSON.stringify(event);
        for (const socket of sockets) {
            try { socket.send(message); } catch { /* Closing already. */ }
        }
    }
}

/** One help-desk site: the agents' Live chat screens, told when the queue changes. */
export class Desk extends Room {}

export function configured(env) {
    return typeof env.LIVE_SECRET === 'string' && env.LIVE_SECRET.length >= 32 && Boolean(env.CONVERSATIONS) && Boolean(env.DESKS);
}

function publishPayload(site, timestamp, delivery, bodyHash) {
    return ['v1', 'publish', site, String(timestamp), delivery, bodyHash].join('\n');
}

/** The X-Core-Support-Signature WordPress sends with each publish. */
export async function signPublish(secret, site, timestamp, delivery, body) {
    return 'v1=' + toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(publishPayload(site, timestamp, delivery, await sha256(body)))));
}

/**
 * Checks a subscribe token from WordPress: "v1." + base64url(JSON claims) + "." + hex HMAC of
 * "v1\nsubscribe\n" + the claims segment. Returns the claims, or null when the token is forged,
 * expired or malformed.
 */
export async function verifyToken(secret, token, now) {
    const parts = typeof token === 'string' && token.length <= 2048 ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
    if (!(await verifyHex(secret, 'v1\nsubscribe\n' + parts[1], parts[2]))) return null;
    let claims;
    try { claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))); } catch { return null; }
    if (!isObject(claims) || !['visitor', 'agent'].includes(claims.role) || typeof claims.site !== 'string' || !SITE.test(claims.site)
        || typeof claims.thread !== 'string' || (claims.thread !== '' && !THREAD.test(claims.thread)) || (claims.role === 'visitor' && claims.thread === '')
        || typeof claims.origin !== 'string' || !ORIGIN.test(claims.origin) || typeof claims.name !== 'string' || claims.name.length > 100
        || !Number.isSafeInteger(claims.exp) || claims.exp < now) {
        return null;
    }
    return { role: claims.role, site: claims.site, thread: claims.thread, origin: claims.origin, name: claims.name, exp: claims.exp };
}

async function verifyHex(secret, payload, hex) {
    if (!/^[0-9a-f]{64}$/.test(hex)) return false;
    // subtle.verify compares in constant time.
    return crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromHex(hex), new TextEncoder().encode(payload));
}

function hmacKey(secret, usage) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function sha256(bytes) {
    return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function readLimited(request, limit) {
    if (Number(request.headers.get('Content-Length') || 0) > limit) return null;
    if (!request.body) return new Uint8Array(0);
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) { await reader.cancel(); return null; }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
}

function close(socket, code, reason) {
    try { socket.close(code, reason); } catch { /* Already closed. */ }
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toHex(buffer) { return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function fromHex(hex) { return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16)); }
function fromBase64Url(text) {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
