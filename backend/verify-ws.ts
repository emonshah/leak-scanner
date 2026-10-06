/*
 * verify-ws.ts — targeted harness for the /api/scans/:id/stream handler.
 *
 * Guards the v1.1.1 fix: @fastify/websocket v11 passes the raw WebSocket as
 * the first handler argument (older versions passed { socket }). The old code
 * read `connection.socket.on(...)` which threw `Cannot read properties of
 * undefined` inside a fire-and-forget async IIFE — an unhandled rejection that
 * killed the whole server (Node 24).
 *
 * Checks:
 *   T1  legacy shape ({ socket }) + invalid id  → close(4001), no throw
 *   T2  raw shape (socket directly) + invalid id → close(4001), no throw
 *   T3  valid id + DB unreachable                → close(4003), no crash
 *   T4  full HTTP+WS integration via real plugin → connects, no unhandledRejection
 *
 * Run: npm run verify:ws  (from backend/)
 */
import assert from 'node:assert';

async function main(): Promise<void> {
  // Force an instant DB failure BEFORE config/db modules load, so getScan()
  // rejects fast and deterministically regardless of whether MySQL is up.
  process.env['DB_PORT'] = '1';
  process.env['DB_HOST'] = '127.0.0.1';

  const { scanStreamHandler } = await import('./src/routes/scans.js');

  type FakeWs = {
    closed: { code?: number; reason?: string } | null;
    close: (code?: number, reason?: string) => void;
    send: (data: string) => void;
    on: (event: string, cb: () => void) => void;
    sent: string[];
  };

  function fakeWs(): FakeWs {
    return {
      closed: null,
      close(code?: number, reason?: string) {
        this.closed = { code, reason };
      },
      send(data: string) {
        this.sent.push(data);
      },
      on() {
        /* close event registered */
      },
      sent: [],
    };
  }

  function fakeReq(id: string): { params: { id: string } } {
    return { params: { id } };
  }

  async function waitMs(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  // T1: legacy wrapper shape, invalid id
  {
    const ws = fakeWs();
    scanStreamHandler({ socket: ws }, fakeReq('0') as never);
    assert.strictEqual(ws.closed?.code, 4001, 'T1 legacy shape invalid id must close(4001)');
    console.log('PASS T1 legacy {socket} shape + invalid id closes 4001');
  }

  // T2: raw v11 shape (the production crash case), invalid id
  {
    const ws = fakeWs();
    scanStreamHandler(ws, fakeReq('abc') as never);
    assert.strictEqual(ws.closed?.code, 4001, 'T2 raw shape invalid id must close(4001)');
    console.log('PASS T2 raw socket shape + invalid id closes 4001');
  }

  // T3: valid id, DB forced unreachable → getScan rejects → close(4003), no throw
  {
    const ws = fakeWs();
    scanStreamHandler(ws, fakeReq('1') as never);
    await waitMs(3000);
    assert.strictEqual(ws.closed?.code, 4003, 'T3 rejected getScan must close(4003), got ' + JSON.stringify(ws.closed));
    console.log('PASS T3 valid id + DB error closes 4003 without crashing');
  }

  // T4: full integration — real Fastify + real @fastify/websocket plugin
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown): void => {
    unhandled.push(err);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const { default: Fastify } = await import('fastify');
    const { default: websocket } = await import('@fastify/websocket');
    const { scanRoutes } = await import('./src/routes/scans.js');
    const { default: WSClient } = await import('ws');

    const app = Fastify({ logger: false });
    await app.register(websocket);
    await app.register(scanRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // Invalid id through the real plugin (this exact path crashed v1.1.0).
    const code = await new Promise<number>((resolve, reject) => {
      const client = new WSClient(`ws://127.0.0.1:${port}/api/scans/0/stream`);
      const timer = setTimeout(() => reject(new Error('T4 close timeout')), 8000);
      client.on('close', (c: number) => {
        clearTimeout(timer);
        resolve(c);
      });
      client.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    assert.strictEqual(code, 4001, 'T4 real plugin invalid id must close(4001), got ' + code);

    // Valid id with DB unreachable → server must survive and answer 4003.
    const code2 = await new Promise<number>((resolve, reject) => {
      const client = new WSClient(`ws://127.0.0.1:${port}/api/scans/1/stream`);
      const timer = setTimeout(() => reject(new Error('T4b close timeout')), 8000);
      client.on('close', (c: number) => {
        clearTimeout(timer);
        resolve(c);
      });
      client.on('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    assert.strictEqual(code2, 4003, 'T4b real plugin valid id must close(4003), got ' + code2);

    await app.close();
    assert.strictEqual(unhandled.length, 0, 'T4 no unhandledRejection allowed: ' + String(unhandled[0]));
    console.log('PASS T4 real @fastify/websocket integration: 4001 + 4003, no unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  console.log('All stream-handler checks passed.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
