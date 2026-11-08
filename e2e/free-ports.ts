import { spawnSync } from 'node:child_process';

// Порты общих демо-серверов e2e. Фиксированные номера сталкивались, когда
// несколько рабочих деревьев запускали e2e одновременно: второй прогон ждал
// чужой сервер до таймаута. Порты выбирает ОС (`listen(0)`) один раз в
// процессе раннера; воркеры наследуют его окружение и, вычисляя конфигурацию
// заново, берут те же номера.

/** Переменные окружения с портами общих серверов: задаются playwright.config. */
export const portEnv = {
  demo: 'DEVCONTOUR_E2E_DEMO_PORT',
  attention: 'DEVCONTOUR_E2E_ATTENTION_PORT',
} as const;

/**
 * Свободные порты на 127.0.0.1, все разные: слушатели держатся открытыми,
 * пока ОС не выдаст последний номер, и закрываются вместе. Синхронно —
 * конфигурация Playwright вычисляется без ожидания.
 */
export function freePorts(count: number): number[] {
  const script = `
    const net = require('node:net');
    const servers = [];
    const next = () => {
      if (servers.length === ${count}) {
        console.log(servers.map((s) => s.address().port).join(' '));
        for (const s of servers) s.close();
        return;
      }
      const s = net.createServer();
      s.once('error', (e) => { console.error(e.message); process.exit(1); });
      s.listen(0, '127.0.0.1', () => { servers.push(s); next(); });
    };
    next();
  `;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const ports = run.stdout.trim().split(/\s+/).map(Number);
  if (run.status !== 0 || ports.length !== count || !ports.every((p) => p > 0))
    throw new Error(`свободные порты для e2e не получены: ${run.stderr || run.stdout}`);
  return ports;
}

/** Порты общих серверов этого прогона: выбираются один раз, затем из окружения. */
export function sharedPorts() {
  if (!process.env[portEnv.demo] || !process.env[portEnv.attention]) {
    const [demo, attention] = freePorts(2);
    process.env[portEnv.demo] = String(demo);
    process.env[portEnv.attention] = String(attention);
  }
  return {
    demo: Number(process.env[portEnv.demo]),
    attention: Number(process.env[portEnv.attention]),
  };
}
