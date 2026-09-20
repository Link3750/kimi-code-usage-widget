// WS 实测 v2: 修正 client_hello 的 payload 嵌套
const port = process.argv[2];
const sessionId = process.argv[3];
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?client_id=kimi-ws-test`);
const t0 = Date.now();
const log = (msg) => console.log(`[+${Date.now() - t0}ms]`, msg);

ws.onopen = () => log('OPEN');
ws.onerror = (e) => log('ERROR ' + (e.message || JSON.stringify(e)));
ws.onclose = (e) => { log(`CLOSE code=${e.code} reason=${e.reason}`); process.exit(0); };
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return log('MSG(raw) ' + String(ev.data).slice(0, 200)); }
  if (m.type === 'server_hello') {
    ws.send(JSON.stringify({
      type: 'client_hello', id: 'h1',
      payload: { client_id: 'kimi-ws-test', subscriptions: [sessionId] }
    }));
    return log('SERVER_HELLO, client_hello sent');
  }
  if (m.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', payload: { nonce: m.payload?.nonce } }));
    return;
  }
  if (m.type === 'ack') {
    return log('ACK ' + JSON.stringify(m.payload).slice(0, 300));
  }
  const summary = { type: m.type, seq: m.seq };
  const p = m.payload || {};
  if (p.usage) summary.usage = p.usage;
  if (p.durationMs != null) summary.durationMs = p.durationMs;
  if (p.step != null) summary.step = p.step;
  log(JSON.stringify(summary).slice(0, 600));
};
setTimeout(() => { log('TIMEOUT, closing'); ws.close(); process.exit(0); }, 30000);
