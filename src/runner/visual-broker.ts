import { z } from 'zod';
import { visualElementId } from '../core/visual.ts';

/**
 * Клиент device broker визуальной приёмки (`devcontour visual run`).
 *
 * Gate исполняется в песочнице ОС, где сервисы симулятора недоступны; broker —
 * процесс хоста, который lifecycle репозитория запускает до gates. Gate
 * говорит с ним только по localhost и только закрытым набором вызовов ниже:
 * произвольных команд у broker нет, он привязан к одному устройству и
 * токену прогона.
 *
 * Координаты всех рамок и точек — в pt окна приложения, как их отдаёт дерево
 * доступности. Снимок экрана — PNG в пикселях устройства; масштаб оценщик
 * выводит из отношения ширины снимка к ширине окна.
 */

const finite = z.number().finite();
const rect = z.strictObject({
  x: finite,
  y: finite,
  width: finite.min(0),
  height: finite.min(0),
});
export type BrokerRect = z.infer<typeof rect>;

/**
 * Снимок дерева доступности: окно, safe area, рамки элементов с id и фокус.
 * id не по формату спецификации broker передаёт как есть, клиент их
 * отбрасывает: спецификация их назвать всё равно не может.
 */
const framesResult = z.strictObject({
  window: rect,
  safeArea: rect,
  elements: z.record(z.string().max(500), rect),
  focused: z
    .strictObject({
      element: z.string().max(500),
      text: z.string().max(10_000),
      /** Поле пароля: платформа отдаёт вместо текста маску, сравнима только длина. */
      secure: z.literal(true).optional(),
    })
    .nullable(),
});
export type BrokerFrames = z.infer<typeof framesResult>;
const validId = (id: string) => visualElementId.safeParse(id).success;
/** Только id, которые может назвать спецификация. */
export const usableFrames = (f: BrokerFrames): BrokerFrames => ({
  ...f,
  elements: Object.fromEntries(Object.entries(f.elements).filter(([id]) => validId(id))),
  focused: f.focused && validId(f.focused.element) ? f.focused : null,
});

const helloResult = z.strictObject({
  /** Версия протокола broker. */
  protocol: z.literal(1),
  platform: z.literal('ios'),
  host: z.enum(['dev-client', 'expo-go']),
  device: z.strictObject({
    udid: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    runtime: z.string().min(1).max(100),
    appearance: z.enum(['light', 'dark']),
    locale: z.string().min(1).max(40),
  }),
});
export type BrokerHello = z.infer<typeof helloResult>;
/** Требования спецификации к устройству: broker настраивает его по ним в `hello`. */
export type BrokerDeviceRequest = {
  model?: string;
  runtime?: string;
  appearance?: 'light' | 'dark';
  locale?: string;
};

/** Ответ broker больше предела — сбой окружения (снимок PNG в base64 укладывается). */
export const BROKER_RESPONSE_LIMIT = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const empty = z.strictObject({});
/**
 * Закрытый набор вызовов. Схема результата проверяется у каждого ответа:
 * broker — код хоста, но ответ, не совпавший с договором, — сбой окружения,
 * а не наблюдение.
 */
export const brokerMethods = {
  /** Версия протокола, хост приложения и устройство: пишутся в evidence. */
  hello: helloResult,
  /** Рамки элементов; `ids` пусто — все элементы с id. */
  frames: framesResult,
  /** Рамка экранной клавиатуры; null — клавиатуры нет. */
  keyboardFrame: z.strictObject({ keyboard: rect.nullable() }),
  /** Касание по координате экрана, а не касание элемента. */
  tapPoint: empty,
  /** Набор текста в поле в фокусе; `\b` — удаление символа. */
  typeText: empty,
  /** Жест перетаскивания для шага `scroll`. */
  drag: empty,
  /** PNG снимка экрана в base64. */
  screenshot: z.strictObject({ png: z.string().min(1) }),
  /** Запуск приложения заново с аргументами. */
  launch: empty,
  /** Открыть deep link приложения. */
  openURL: empty,
  /** Размер журнала bundler/устройства в байтах с начала сеанса broker. */
  logSize: z.strictObject({ size: z.number().int().min(0) }),
  /** Байты журнала с `from` до текущего конца, base64. */
  logRead: z.strictObject({ size: z.number().int().min(0), data: z.string() }),
} as const;
export type BrokerMethod = keyof typeof brokerMethods;

export interface VisualBroker {
  hello(device?: BrokerDeviceRequest): Promise<BrokerHello>;
  frames(ids?: string[]): Promise<BrokerFrames>;
  keyboardFrame(): Promise<BrokerRect | null>;
  tapPoint(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  screenshot(): Promise<Buffer>;
  launch(args: string[]): Promise<void>;
  openURL(url: string): Promise<void>;
  logSize(): Promise<number>;
  logRead(from: number): Promise<{ size: number; data: Buffer }>;
}

/**
 * Сбой связи с broker или нарушение им договора: ошибка окружения. Правка
 * продукта его не исправит, поэтому он не становится провалом утверждения.
 */
export class BrokerError extends Error {
  override name = 'BrokerError';
}

/** Где broker и как к нему обращаться: из ресурсов попытки и окружения gate. */
export interface BrokerAddress {
  port: number;
  token: string;
  /** Устройство из ресурса `device`: broker сверяет его со своим. */
  device?: string;
}

const resources = z.array(
  z.object({ id: z.string(), kind: z.string(), value: z.string() }).passthrough(),
);

/**
 * Адрес broker: порт — ресурс `port` с id `brokerResource`, устройство —
 * первый ресурс `device`, токен — `DEVCONTOUR_VISUAL_TOKEN`. Нет нужного —
 * ошибка окружения с названной причиной.
 */
export function brokerAddress(
  env: NodeJS.ProcessEnv,
  brokerResource: string,
): BrokerAddress | { error: string } {
  const raw = env.DEVCONTOUR_RESOURCES_JSON;
  if (!raw)
    return {
      error: `нет DEVCONTOUR_RESOURCES_JSON: объявите у gate ресурсы ${brokerResource} (port) и устройство (device)`,
    };
  let list: z.infer<typeof resources>;
  try {
    list = resources.parse(JSON.parse(raw));
  } catch {
    return { error: 'DEVCONTOUR_RESOURCES_JSON не по формату [{id, kind, value}]' };
  }
  const port = list.find((r) => r.id === brokerResource);
  if (!port || port.kind !== 'port')
    return { error: `нет ресурса ${brokerResource} вида port среди ресурсов gate` };
  const number = Number(port.value);
  if (!Number.isInteger(number) || number < 1 || number > 65535)
    return { error: `ресурс ${brokerResource}: порт ${port.value} не число 1–65535` };
  const token = env.DEVCONTOUR_VISUAL_TOKEN;
  if (!token) return { error: 'нет DEVCONTOUR_VISUAL_TOKEN: токен прогона broker не передан' };
  const device = list.find((r) => r.kind === 'device')?.value;
  return { port: number, token, ...(device ? { device } : {}) };
}

/** Ответ broker: `{result}` или `{error: {message}}`. */
const envelope = z.union([
  z.strictObject({ result: z.unknown() }),
  z.strictObject({ error: z.strictObject({ message: z.string().max(4000) }) }),
]);

/** HTTP JSON-RPC к broker на 127.0.0.1: POST /rpc, токен в Authorization. */
export function httpBroker(
  address: BrokerAddress,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): VisualBroker {
  const send = options.fetch ?? fetch;
  const call = async <M extends BrokerMethod>(
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<z.infer<(typeof brokerMethods)[M]>> => {
    let response: Response;
    try {
      response = await send(`http://127.0.0.1:${address.port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${address.token}`,
        },
        body: JSON.stringify({ method, params }),
        // Broker отвечает сам: перенаправление увело бы запрос с токеном с localhost.
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new BrokerError(
        `broker на 127.0.0.1:${address.port} недоступен (${method}): ${error instanceof Error ? error.message : String(error)}. ` +
          'Его запускает lifecycle.setup командой devcontour visual broker start',
      );
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > BROKER_RESPONSE_LIMIT)
      throw new BrokerError(`ответ broker на ${method} больше ${BROKER_RESPONSE_LIMIT} байт`);
    let body: unknown;
    try {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > BROKER_RESPONSE_LIMIT)
        throw new BrokerError(`ответ broker на ${method} больше ${BROKER_RESPONSE_LIMIT} байт`);
      body = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(`broker ответил на ${method} не JSON (HTTP ${response.status})`);
    }
    const parsed = envelope.safeParse(body);
    if (!parsed.success)
      throw new BrokerError(`broker ответил на ${method} не по договору (HTTP ${response.status})`);
    if ('error' in parsed.data)
      throw new BrokerError(`broker: ${method}: ${parsed.data.error.message}`);
    const result = brokerMethods[method].safeParse(parsed.data.result);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new BrokerError(
        `broker: результат ${method} не по договору: ${issue?.path.map(String).join('.') || '(корень)'}: ${issue?.message}`,
      );
    }
    return result.data as z.infer<(typeof brokerMethods)[M]>;
  };
  return {
    hello: (device) =>
      call('hello', {
        ...(address.device ? { device: address.device } : {}),
        ...(device && Object.keys(device).length ? { expect: device } : {}),
      }),
    frames: async (ids) => usableFrames(await call('frames', ids ? { ids } : {})),
    keyboardFrame: async () => (await call('keyboardFrame')).keyboard,
    tapPoint: async (x, y) => void (await call('tapPoint', { x, y })),
    typeText: async (text) => void (await call('typeText', { text })),
    drag: async (from, to) => void (await call('drag', { from, to })),
    screenshot: async () => {
      const png = Buffer.from((await call('screenshot')).png, 'base64');
      if (!png.subarray(0, 8).equals(PNG_SIGNATURE))
        throw new BrokerError('broker: снимок screenshot — не PNG');
      return png;
    },
    launch: async (args) => void (await call('launch', { args })),
    openURL: async (url) => void (await call('openURL', { url })),
    logSize: async () => (await call('logSize')).size,
    logRead: async (from) => {
      const r = await call('logRead', { from });
      return { size: r.size, data: Buffer.from(r.data, 'base64') };
    },
  };
}
