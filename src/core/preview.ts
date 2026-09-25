import { randomUUID } from 'node:crypto';
import { DevContour, digest } from './service.ts';
import { currentVerification } from './delivery.ts';
import { DomainError, type DevContourState } from './model.ts';

/**
 * Preview — работающая версия проверенного результата, которую автор
 * продукта может открыть и попробовать.
 *
 * Принятый commit и зелёные проверки не дают человеку того, что он оценивает:
 * работающего сервиса. Preview собирается из того самого manifest, который
 * прошёл совместную проверку ChangeSet, и запускается локально в Docker.
 * Один стек и одна среда — осознанное ограничение: универсальная поставка в
 * production этим не заявляется.
 *
 * Состояния разделены и не выводятся друг из друга: «код проверен» (есть
 * успешная проверка ChangeSet) → `built` (образы собраны из manifest) →
 * `deployed` (выкладка заняла URL) → `healthy` (health, версия и образы
 * подтверждены на URL) → `confirmed` (пользовательский сценарий прошёл на
 * URL). Здоровая выкладка без прошедшего сценария — `unconfirmed`.
 *
 * Каждая выкладка — отдельная сущность со своим compose-проектом: две
 * выкладки одного manifest с разными настройками не делят контейнеры и
 * данные, и откат возвращает именно ту выкладку, которая обслуживала URL.
 */
export type { PreviewConfig } from './integrations.ts';

export type PreviewStatus =
  | 'building'
  | 'built'
  | 'deployed'
  | 'healthy'
  | 'confirmed'
  | 'unconfirmed'
  | 'failed'
  | 'retired';
/**
 * Причина отказа — по месту, где он возник, а не по тексту ошибки: у автора
 * внешний доступ и техническое исправление — разные решения.
 */
export type PreviewFailure =
  'docker-unavailable' | 'compose-policy' | 'build' | 'health' | 'switch' | 'lease' | 'unknown';
export interface Preview {
  id: string;
  changeSetId: string;
  verificationId: string;
  /** Проверки, чей manifest обслуживает эта выкладка: повтор той же проверки добавляется сюда. */
  verificationIds?: string[];
  manifestDigest: string;
  policyDigest: string;
  /** Идентификатор релиза: производный от manifest, его называет приложение. */
  release: string;
  /** Имя compose-проекта этой выкладки: уникально для выкладки. */
  project: string;
  token: string;
  leaseUntil: number;
  status: PreviewStatus;
  /** Выполняется ли сейчас попытка. */
  active: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Образы сервисов (immutable ID) и их общий digest — артефакт выкладки. */
  images?: Record<string, string>;
  artifactDigest?: string;
  url?: string;
  deployedAt?: string;
  healthyAt?: string;
  /** Когда здоровье и принадлежность URL последний раз подтверждены. */
  checkedAt?: string;
  confirmedAt?: string;
  /** Выкладка, которая обслуживала URL до этой и к которой возможен откат. */
  previous?: string;
  /** Статус, с которым выкладка была снята с URL: к нему она возвращается при откате. */
  retiredFrom?: PreviewStatus;
  /** С этой выкладки URL вернули прежней. */
  rolledBack?: boolean;
  /**
   * Состояние URL неизвестно: восстановление не доказано. Такая выкладка
   * не считается обслуживающей, пока её не проверят заново.
   */
  lost?: string;
  error?: string;
  failure?: PreviewFailure;
  smoke?: { passed: boolean; summary: string; log: string };
}
/** Одна операция над URL за раз — выкладка или откат — под lease. */
export interface PreviewLock {
  token: string;
  kind: 'deploy' | 'rollback';
  previewId?: string;
  leaseUntil: number;
}

export const previewPolicy = (h: DevContour) =>
  digest({ preview: h.config.preview, environment: h.config.environment });
const release = (manifestDigest: string) => 'r' + manifestDigest.slice(0, 12);

/** Выкладка, которая сейчас обслуживает URL preview, если она есть. */
export function servingPreview(s: Pick<DevContourState, 'previews'>) {
  return s.previews?.findLast(
    (p) =>
      (p.status === 'healthy' || p.status === 'confirmed' || p.status === 'unconfirmed') &&
      !p.active &&
      !p.lost,
  );
}

export class Previews {
  constructor(readonly h: DevContour) {}
  private config() {
    const config = this.h.config.preview;
    if (!config) throw new DomainError('Preview не настроен: добавьте раздел preview в config');
    return config;
  }
  /**
   * Захватить URL для операции. Одновременно идёт не больше одной — выкладка
   * или откат. Операция, чей lease истёк, считается прерванной: её
   * незавершённая выкладка помечается проваленной.
   */
  private acquire(s: DevContourState, kind: PreviewLock['kind']) {
    if (s.previewLock && s.previewLock.leaseUntil > Date.now())
      throw new DomainError(
        s.previewLock.kind === 'deploy'
          ? 'Выкладка preview уже выполняется'
          : 'Откат preview уже выполняется',
      );
    for (const p of s.previews ?? [])
      if (p.active) {
        p.active = false;
        p.status = 'failed';
        p.failure = 'lease';
        p.error = 'Истёк срок владения выкладкой';
        p.finishedAt = new Date().toISOString();
      }
    s.previewLock = { token: randomUUID(), kind, leaseUntil: Date.now() + this.h.config.leaseMs };
    return s.previewLock;
  }
  /** Запись под действующей блокировкой: устаревшая операция ничего не меняет. */
  private fenced<T>(token: string, event: string, action: (s: DevContourState) => T): T {
    return this.h.store.change(event, (s) => {
      if (!s.previewLock || s.previewLock.token !== token || s.previewLock.leaseUntil <= Date.now())
        throw new DomainError('Операция preview устарела: её владение истекло или перехвачено');
      return action(s);
    });
  }
  /** Действует ли ещё владение: исполнитель проверяет это перед каждым внешним эффектом. */
  owns(token: string) {
    const lock = this.h.store.read().previewLock;
    return !!lock && lock.token === token && lock.leaseUntil > Date.now();
  }
  heartbeat(token: string) {
    this.fenced(token, 'heartbeat', (s) => {
      s.previewLock!.leaseUntil = Date.now() + this.h.config.leaseMs;
      const p = s.previews?.find((x) => x.id === s.previewLock!.previewId);
      if (p?.active) p.leaseUntil = s.previewLock!.leaseUntil;
    });
  }
  release(token: string) {
    this.h.store.change('preview.released', (s) => {
      if (s.previewLock?.token === token) s.previewLock = undefined;
      return {};
    });
  }
  /**
   * Начать выкладку проверенного ChangeSet: захватить URL и сказать, есть ли
   * уже выкладка того же manifest и политики. Её исполнитель сначала
   * проверяет на деле — историческое здоровье за текущее не выдаётся.
   */
  start(changeSetId: string) {
    this.config();
    return this.h.store.change('preview.started', (s) => {
      const c = s.changeSets.find((c) => c.id === changeSetId);
      if (!c) throw new DomainError('ChangeSet не найден');
      const v = currentVerification(this.h, s, c);
      const lock = this.acquire(s, 'deploy');
      const serving = servingPreview(s);
      const reusable =
        serving &&
        serving.manifestDigest === v.manifestDigest &&
        serving.policyDigest === previewPolicy(this.h)
          ? serving
          : undefined;
      return {
        token: lock.token,
        verificationId: v.id,
        manifest: v.manifest!,
        manifestDigest: v.manifestDigest!,
        reusable,
      };
    });
  }
  /**
   * Выкладка того же manifest подтверждена на деле: она обслуживает и эту
   * проверку. История прежней проверки не переписывается — добавляется
   * связь.
   */
  reused(token: string, previewId: string, verificationId: string) {
    return this.fenced(token, 'preview.reused', (s) => {
      const p = s.previews!.find((x) => x.id === previewId)!;
      p.verificationIds = [
        ...new Set([...(p.verificationIds ?? [p.verificationId]), verificationId]),
      ];
      p.checkedAt = new Date().toISOString();
      p.lost = undefined;
      s.previewLock = undefined;
      return p;
    });
  }
  /** Обслуживающая выкладка на деле не работает и не восстановилась. */
  lost(token: string, previewId: string, reason: string) {
    return this.fenced(token, 'preview.lost', (s) => {
      const p = s.previews!.find((x) => x.id === previewId);
      if (p) p.lost = reason;
      return { previewId, reason };
    });
  }
  /** Новая выкладка под действующей блокировкой. */
  begin(
    token: string,
    input: { changeSetId: string; verificationId: string; manifestDigest: string },
    workspaceKey: string,
  ) {
    const config = this.config();
    return this.fenced(token, 'preview.begun', (s) => {
      const id = randomUUID();
      const r = release(input.manifestDigest);
      const serving = servingPreview(s);
      const preview: Preview = {
        id,
        changeSetId: input.changeSetId,
        verificationId: input.verificationId,
        manifestDigest: input.manifestDigest,
        policyDigest: previewPolicy(this.h),
        release: r,
        project: `dc-${workspaceKey}-${r}-${id.slice(0, 8)}`,
        token,
        leaseUntil: s.previewLock!.leaseUntil,
        status: 'building',
        active: true,
        startedAt: new Date().toISOString(),
        url: `http://127.0.0.1:${config.port}`,
        previous: serving?.id,
      };
      s.previews ??= [];
      s.previews.push(preview);
      s.previewLock!.previewId = id;
      return preview;
    });
  }
  private attempt<T>(
    token: string,
    id: string,
    event: string,
    action: (p: Preview, s: DevContourState) => T,
  ) {
    return this.fenced(token, event, (s) => {
      const p = s.previews?.find((x) => x.id === id);
      if (!p || !p.active || p.token !== token)
        throw new DomainError('Устаревшая попытка выкладки preview');
      if (p.policyDigest !== previewPolicy(this.h))
        throw new DomainError('Настройки preview изменились во время выкладки');
      return action(p, s);
    });
  }
  built(token: string, id: string, images: Record<string, string>) {
    return this.attempt(token, id, 'preview.built', (p) => {
      p.status = 'built';
      p.images = images;
      p.artifactDigest = digest(images);
      return p;
    });
  }
  deployed(token: string, id: string) {
    return this.attempt(token, id, 'preview.deployed', (p) => {
      p.status = 'deployed';
      p.deployedAt = new Date().toISOString();
      return p;
    });
  }
  /**
   * Выкладка здорова на URL. Прежняя снимается с роли — две выкладки сразу не
   * могут считаться обслуживающими.
   */
  healthy(token: string, id: string) {
    return this.attempt(token, id, 'preview.healthy', (p, s) => {
      if (p.status !== 'deployed')
        throw new DomainError('Здоровье подтверждается только выложенной версии');
      for (const other of s.previews ?? [])
        if (
          other !== p &&
          !other.active &&
          other.status !== 'failed' &&
          other.status !== 'retired'
        ) {
          other.retiredFrom = other.status;
          other.status = 'retired';
        }
      p.status = 'healthy';
      p.healthyAt = p.checkedAt = new Date().toISOString();
      return p;
    });
  }
  /** Итог сценария: подтверждён или нет — здоровая выкладка остаётся на URL. */
  finish(token: string, id: string, smoke?: Preview['smoke']) {
    return this.attempt(token, id, 'preview.finished', (p, s) => {
      if (p.status !== 'healthy')
        throw new DomainError('Сценарий проверяется на здоровой выкладке');
      p.smoke = smoke;
      p.status = smoke?.passed ? 'confirmed' : 'unconfirmed';
      if (smoke?.passed) p.confirmedAt = new Date().toISOString();
      p.active = false;
      p.finishedAt = new Date().toISOString();
      s.previewLock = undefined;
      return p;
    });
  }
  /**
   * Отказ выкладки. Если URL физически вернули прежней выкладке, её запись
   * снова обслуживающая — статус возвращается, а не остаётся «снята».
   * Если вернуть не удалось, прежняя помечается потерянной: состояние URL
   * неизвестно и не выдаётся за работающее.
   */
  fail(
    token: string,
    id: string,
    outcome: { error: string; failure: PreviewFailure; restored?: boolean; lostReason?: string },
  ) {
    this.h.store.change('preview.failed', (s) => {
      const p = s.previews?.find((x) => x.id === id && x.token === token);
      if (p?.active) {
        p.status = 'failed';
        p.active = false;
        p.error = outcome.error;
        p.failure = outcome.failure;
        p.rolledBack = outcome.restored || undefined;
        p.finishedAt = new Date().toISOString();
        const previous = s.previews?.find((x) => x.id === p.previous);
        if (previous && outcome.restored && previous.status === 'retired') {
          previous.status = previous.retiredFrom ?? 'healthy';
          previous.retiredFrom = undefined;
          previous.checkedAt = new Date().toISOString();
        }
        if (previous && outcome.lostReason) previous.lost = outcome.lostReason;
      }
      if (s.previewLock?.token === token) s.previewLock = undefined;
      return { previewId: id, ...outcome };
    });
  }
  /** Начать откат: захватить URL. */
  startRollback() {
    this.config();
    return this.h.store.change('preview.rollback-started', (s) => {
      const current = servingPreview(s);
      const previous = s.previews?.find((p) => p.id === current?.previous);
      if (!current || !previous) throw new DomainError('Нет предыдущей выкладки для отката');
      const lock = this.acquire(s, 'rollback');
      return { token: lock.token, current, previous };
    });
  }
  /** Откат выполнен и проверен: прежняя выкладка снова обслуживает URL. */
  restore(token: string, previousId: string, currentId: string) {
    return this.fenced(token, 'preview.rolled-back', (s) => {
      const previous = s.previews?.find((p) => p.id === previousId);
      const current = s.previews?.find((p) => p.id === currentId);
      if (!previous || !current || previous.status !== 'retired')
        throw new DomainError('Откат возможен только к снятой прежней выкладке');
      current.retiredFrom = current.status;
      current.status = 'retired';
      current.rolledBack = true;
      previous.status = previous.retiredFrom ?? 'healthy';
      previous.retiredFrom = undefined;
      previous.checkedAt = new Date().toISOString();
      previous.lost = undefined;
      s.previewLock = undefined;
      return previous;
    });
  }
  /** Откат не удался. Что обслуживает URL — записано явно, без догадок. */
  rollbackFailed(token: string, currentId: string, lostReason?: string) {
    this.h.store.change('preview.rollback-failed', (s) => {
      const current = s.previews?.find((p) => p.id === currentId);
      if (current && lostReason) current.lost = lostReason;
      if (s.previewLock?.token === token) s.previewLock = undefined;
      return { currentId, lostReason };
    });
  }
}
