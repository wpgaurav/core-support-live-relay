/**
 * The Worker running in workerd, over real HTTP and WebSockets: `npx wrangler dev` with
 * LIVE_SECRET in .dev.vars, then
 *
 *     LIVE_RELAY_URL=http://localhost:8787 LIVE_SECRET=… npm run test:dev
 *
 * Skipped without LIVE_RELAY_URL. It checks what worker.test.mjs can only fake: the 101 upgrade
 * through a Durable Object, tags, attachments, the ping auto-response and close handling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomUUID } from 'node:crypto';

const base = process.env.LIVE_RELAY_URL || '';
const secret = process.env.LIVE_SECRET || '';
const skip = base === '' || secret.length < 32 ? 'set LIVE_RELAY_URL and LIVE_SECRET to run against wrangler dev' : false;
const site = 'qa.example.com';
const origin = 'https://qa.example.com';
const now = () => Math.floor(Date.now() / 1000);

function token(claims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return 'v1.' + payload + '.' + createHmac('sha256', secret).update('v1\nsubscribe\n' + payload).digest('hex');
}

async function publish(event, key = secret) {
    const body = JSON.stringify(event);
    const timestamp = String(now());
    const delivery = randomUUID();
    const signed = ['v1', 'publish', site, timestamp, delivery, createHash('sha256').update(body).digest('hex')].join('\n');
    const response = await fetch(base + '/publish', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Core-Support-Site': site,
            'X-Core-Support-Timestamp': timestamp,
            'X-Core-Support-Delivery': delivery,
            'X-Core-Support-Signature': 'v1=' + createHmac('sha256', key).update(signed).digest('hex'),
        },
        body,
    });
    return { status: response.status, body: await response.json() };
}

/** Opens a socket and collects its events; resolves once open, rejects when refused. */
function open(claims, from = claims.origin) {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/connect?token=' + encodeURIComponent(token(claims)), { headers: { Origin: from } });
    const events = [];
    const waiters = [];
    ws.onmessage = (event) => {
        const data = event.data === 'pong' ? { type: 'pong' } : JSON.parse(event.data);
        events.push(data);
        waiters.splice(0).forEach((check) => check());
    };
    const next = (type, timeout = 3000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No ' + type + ' event; got ' + JSON.stringify(events))), timeout);
        const check = () => {
            const index = events.findIndex((event) => event.type === type);
            if (index === -1) { waiters.push(check); return; }
            clearTimeout(timer);
            resolve(events.splice(index, 1)[0]);
        };
        check();
    });
    return new Promise((resolve, reject) => {
        ws.onopen = () => resolve({ ws, events, next });
        ws.onerror = () => reject(new Error('refused'));
    });
}

const thread = randomUUID();
const visitor = () => ({ role: 'visitor', site, thread, origin, name: '', exp: now() + 300 });
const agent = (overrides = {}) => ({ role: 'agent', site, thread, origin, name: 'Sam', exp: now() + 300, ...overrides });

test('health reports a configured Worker', { skip }, async () => {
    assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, service: 'core-support-live-relay', version: 1, configured: true });
});

test('sockets, fan-out, typing, ping and presence through workerd', { skip }, async () => {
    const sam = await open(agent());
    assert.deepEqual(await sam.next('presence'), { type: 'presence', visitor: false });
    const desk = await open(agent({ thread: '' }));
    const tab = await open(visitor());
    assert.deepEqual(await sam.next('presence'), { type: 'presence', visitor: true });

    const message = { id: 7, from: 'agent', name: 'Sam', body: 'Hello from the help desk.', at: '2026-11-02 10:00:00' };
    const sent = await publish({ type: 'message', thread, data: { message } });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.delivered, 2);
    assert.deepEqual(await tab.next('message'), { message, type: 'message', thread });
    assert.deepEqual(await sam.next('message'), { message, type: 'message', thread });

    const status = await publish({ type: 'status', thread, data: { status: 'ended', joined: true, agent_name: 'Sam' } });
    assert.equal(status.body.delivered, 3);
    assert.equal((await desk.next('status')).status, 'ended');
    assert.equal((await publish({ type: 'test', thread: '', data: {} })).body.delivered, 1);
    assert.equal((await desk.next('test')).type, 'test');

    tab.ws.send(JSON.stringify({ type: 'typing' }));
    assert.deepEqual(await sam.next('typing'), { type: 'typing', thread, from: 'visitor', name: '' });
    sam.ws.send(JSON.stringify({ type: 'typing' }));
    assert.deepEqual(await tab.next('typing'), { type: 'typing', thread, from: 'agent', name: 'Sam' });

    tab.ws.send('ping');
    assert.equal((await tab.next('pong')).type, 'pong');

    tab.ws.close(1000);
    assert.deepEqual(await sam.next('presence'), { type: 'presence', visitor: false });
    sam.ws.close(1000);
    desk.ws.close(1000);
});

test('wrong origins, expired and forged tokens are refused', { skip }, async () => {
    await assert.rejects(open(visitor(), 'https://evil.example.net'), /refused/);
    await assert.rejects(open({ ...visitor(), exp: now() - 1 }), /refused/);
    assert.equal((await publish({ type: 'test', thread: '', data: {} }, 'a-different-secret-of-32-characters-x')).status, 401);
});
