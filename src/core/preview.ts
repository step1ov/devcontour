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
 * `deployed` (релиз обслуживает URL) → `healthy` (health и версия
 * подтверждены на URL) → `confirmed` (пользовательский сценарий прошёл на
 * URL). Здоровый релиз без прошедшего сценария — `unconfirmed`, а не
 * подтверждённый.
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
export interface Preview {
  id: string;
  changeSetId: string;
  verificationId: string;
  manifestDigest: string;
  policyDigest: string;
  /** Идентификатор релиза: производный от manifest, им помечены образы и проект. */
  release: string;
  /** Имя compose-проекта этого релиза. */
  project: string;
  token: string;
  leaseUntil: number;
  status: PreviewStatus;
  /** Выполняется ли сейчас попытка: активная — под lease. */
  active: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Образы сервисов и их общий digest — артефакт, который обслуживает URL. */
  images?: Record<string, string>;
  artifactDigest?: string;
  url?: string;
  deployedAt?: string;
  healthyAt?: string;
  confirmedAt?: string;
  /** Релиз, который обслуживал URL до этого и к которому возможен откат. */
  previous?: string;
  /** Статус, с которым релиз был снят с URL: к нему он возвращается при откате. */
  retiredFrom?: PreviewStatus;
  /** Откат выполнен: этот релиз не прошёл и URL вернули предыдущему. */
  rolledBack?: boolean;
  error?: string;
  smoke?: { passed: boolean; summary: string; log: string };
}

export const previewPolicy = (h: DevContour) =>
  digest({ preview: h.config.preview, environment: h.config.environment });
const release = (manifestDigest: string) => 'r' + manifestDigest.slice(0, 12);

/** Релиз, который сейчас обслуживает URL preview, если он есть. */
export function servingPreview(s: Pick<DevContourState, 'previews'>) {
  return s.previews?.findLast(
    (p) =>
      (p.status === 'healthy' || p.status === 'confirmed' || p.status === 'unconfirmed') &&
      !p.active,
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
   * Начать выкладку проверенного ChangeSet.
   *
   * Повтор для того же manifest и политики не собирает и не выкладывает
   * второй раз: возвращается уже обслуживающий релиз. Одновременно
   * выполняется не больше одной выкладки.
   */
  start(changeSetId: string, workspaceKey: string) {
    const config = this.config();
    return this.h.store.change('preview.started', (s) => {
      const c = s.changeSets.find((c) => c.id === changeSetId);
      if (!c) throw new DomainError('ChangeSet не найден');
      const v = currentVerification(this.h, s, c);
      const policy = previewPolicy(this.h);
      if (s.previews?.some((p) => p.active && p.leaseUntil > Date.now()))
        throw new DomainError('Выкладка preview уже выполняется');
      // Попытка, чей lease истёк, не выложена: процесс, который её вёл, умер.
      for (const p of s.previews ?? [])
        if (p.active) {
          p.active = false;
          p.status = 'failed';
          p.error = 'Истёк срок владения выкладкой';
          p.finishedAt = new Date().toISOString();
        }
      const serving = servingPreview(s);
      if (serving && serving.manifestDigest === v.manifestDigest && serving.policyDigest === policy)
        return { ...serving, reused: true };
      s.previews ??= [];
      const r = release(v.manifestDigest!);
      const preview: Preview = {
        id: randomUUID(),
        changeSetId,
        verificationId: v.id,
        manifestDigest: v.manifestDigest!,
        policyDigest: policy,
        release: r,
        project: `dc-${workspaceKey}-${r}`,
        token: randomUUID(),
        leaseUntil: Date.now() + this.h.config.leaseMs,
        status: 'building',
        active: true,
        startedAt: new Date().toISOString(),
        url: `http://127.0.0.1:${config.port}`,
        previous: serving?.release,
      };
      s.previews.push(preview);
      return { ...preview, manifest: v.manifest! };
    });
  }
  /** Изменение попытки под её lease: устаревшая попытка ничего не записывает. */
  update<T>(id: string, token: string, event: string, action: (p: Preview) => T): T {
    return this.h.store.change(event, (s) => {
      const p = s.previews?.find((p) => p.id === id);
      if (!p || p.token !== token || !p.active || p.leaseUntil <= Date.now())
        throw new DomainError('Устаревшая попытка выкладки preview');
      if (p.policyDigest !== previewPolicy(this.h))
        throw new DomainError('Настройки preview изменились во время выкладки');
      return action(p);
    });
  }
  heartbeat(id: string, token: string) {
    this.update(id, token, 'heartbeat', (p) => {
      p.leaseUntil = Date.now() + this.h.config.leaseMs;
    });
  }
  built(id: string, token: string, images: Record<string, string>) {
    return this.update(id, token, 'preview.built', (p) => {
      p.status = 'built';
      p.images = images;
      p.artifactDigest = digest(images);
      return p;
    });
  }
  /**
   * Релиз обслуживает URL. Прежний обслуживающий релиз снимается с роли —
   * два релиза сразу не могут считаться выложенными.
   */
  deployed(id: string, token: string) {
    return this.update(id, token, 'preview.deployed', (p) => {
      p.status = 'deployed';
      p.deployedAt = new Date().toISOString();
      return p;
    });
  }
  healthy(id: string, token: string) {
    return this.h.store.change('preview.healthy', (s) => {
      const p = s.previews?.find((p) => p.id === id);
      if (!p || p.token !== token || !p.active || p.status !== 'deployed')
        throw new DomainError('Здоровье подтверждается только выложенному релизу');
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
      p.healthyAt = new Date().toISOString();
      return p;
    });
  }
  /** Итог сценария: подтверждён или нет — но здоровый релиз остаётся выложенным. */
  finish(id: string, token: string, smoke?: Preview['smoke']) {
    return this.update(id, token, 'preview.finished', (p) => {
      if (p.status !== 'healthy') throw new DomainError('Сценарий проверяется на здоровом релизе');
      p.smoke = smoke;
      if (smoke) {
        p.status = smoke.passed ? 'confirmed' : 'unconfirmed';
        if (smoke.passed) p.confirmedAt = new Date().toISOString();
      } else p.status = 'unconfirmed';
      p.active = false;
      p.finishedAt = new Date().toISOString();
      return p;
    });
  }
  /** Откат выполнен: прежний релиз снова обслуживает URL, текущий снят. */
  restore(previousId: string, currentId: string) {
    return this.h.store.change('preview.rolled-back', (s) => {
      const previous = s.previews?.find((p) => p.id === previousId);
      const current = s.previews?.find((p) => p.id === currentId);
      if (!previous || !current || previous.status !== 'retired')
        throw new DomainError('Откат возможен только к снятому прежнему релизу');
      current.retiredFrom = current.status;
      current.status = 'retired';
      current.rolledBack = true;
      previous.status = previous.retiredFrom ?? 'healthy';
      previous.retiredFrom = undefined;
      return previous;
    });
  }
  /** Отказ: этот релиз не обслуживает URL; откат — если он был выполнен. */
  fail(id: string, token: string, error: string, rolledBack: boolean) {
    this.h.store.change('preview.failed', (s) => {
      const p = s.previews?.find((p) => p.id === id && p.token === token);
      if (p?.active) {
        p.status = 'failed';
        p.active = false;
        p.error = error;
        p.rolledBack = rolledBack || undefined;
        p.finishedAt = new Date().toISOString();
        // Прежний релиз снова обслуживает URL: его статус не менялся.
      }
      return { previewId: id, error, rolledBack };
    });
  }
}
