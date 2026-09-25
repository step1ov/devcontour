import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { DevContour, digest, specDigest } from '../core/service.ts';
import {
  DomainError,
  relativePath,
  requireValue,
  type Task,
  type RequirementLink,
  type Verification,
} from '../core/model.ts';
import { requirementProof, taskEvidence } from '../core/proof.ts';
import {
  Workspace,
  changeSnapshot,
  snapshotDigest,
  type ProductReleaseGuard,
} from '../core/workspace.ts';
import {
  storyKey,
  type FeatureProgress,
  type ProductReleaseProof,
  type ProductView,
} from '../core/product-map.ts';
import { repository, repositories } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import { delivered } from '../core/delivery.ts';
import {
  intentDefinition,
  intentRequirementId,
  parseIntent,
  referenceKey,
  renderIntent,
  validateIntent,
  type ComponentIntent,
  type WorkspaceIntent,
} from '../core/intent.ts';
import { parseRequirements, requirementSnapshot } from './requirements.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,50}$/);
const scope = {
  repositoryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .optional(),
};
export const intentInputs = {
  intent_render: z.strictObject({ ...scope, definition: intentDefinition }),
  intent_snapshot: z.strictObject({ ...scope, storyId: id.optional() }),
  intent_report: z.strictObject({ ...scope, releaseId: id }),
  product_view: z.strictObject({ releaseId: id.optional() }),
};
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1_100_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}
export class IntentService implements ProductReleaseGuard {
  constructor(readonly h: DevContour) {}
  private readCache?: Map<string, string>;
  private reading<T>(read: () => T): T {
    if (this.readCache) return read();
    this.readCache = new Map();
    try {
      return read();
    } finally {
      this.readCache = undefined;
    }
  }
  private git(root: string, ...args: string[]) {
    const key = JSON.stringify([root, args]);
    if (this.readCache?.has(key)) return this.readCache.get(key)!;
    const value = git(root, ...args);
    this.readCache?.set(key, value);
    return value;
  }
  private requirements(root: string, source: string, sha: string) {
    relativePath.parse(source);
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new DomainError('Нужен точный SHA источников');
    if (
      !/^100(644|755) blob /.test(
        this.git(root, '--literal-pathspecs', 'ls-tree', sha, '--', source),
      )
    )
      throw new DomainError('ТЗ должно быть обычным Git-файлом: ' + source);
    return { requirements: parseRequirements(this.git(root, 'show', sha + ':' + source)) };
  }
  render(raw: unknown) {
    return this.reading(() => this.renderCurrent(raw));
  }
  snapshot(raw: unknown) {
    return this.reading(() => this.snapshotCurrent(raw));
  }
  report(raw: unknown): Record<string, unknown> {
    return this.reading(() => this.reportCurrent(raw));
  }
  productView(raw: unknown = {}): ProductView {
    return this.reading(() => this.productViewCurrent(raw));
  }
  capture(releaseId: string, selected: ReturnType<typeof changeSnapshot>): ProductReleaseProof {
    return this.reading(() => this.captureCurrent(releaseId, selected));
  }
  validate(
    proof: ProductReleaseProof,
    selected: ReturnType<typeof changeSnapshot>,
    manifest?: Verification['manifest'],
  ) {
    return this.reading(() => this.validateCurrent(proof, selected, manifest));
  }
  private root(repositoryId?: string) {
    return repositoryId
      ? repository(this.h.config, repositoryId).path
      : requireValue(this.h.config.workspaceRoot, 'Нужен Git workspaceRoot');
  }
  private source(repositoryId?: string) {
    return repositoryId && this.h.config.workspaceMode === 'embedded'
      ? 'docs/implementation-intent.md'
      : 'INTENT.md';
  }
  private read(repositoryId?: string, ref = 'HEAD') {
    const root = this.root(repositoryId),
      source = this.source(repositoryId),
      sha = this.git(root, 'rev-parse', '--verify', ref + '^{commit}');
    if (!/^100(644|755) blob /.test(this.git(root, 'ls-tree', sha, '--', source)))
      throw new DomainError(`Нужен обычный committed ${source} выбранного владельца`);
    const markdown = this.git(root, 'show', sha + ':' + source),
      document = parseIntent(markdown);
    if ((repositoryId ? 'component' : 'workspace') !== document.kind)
      throw new DomainError('INTENT kind не соответствует владельцу');
    return { sha, source, markdown, document, digest: digest(document) };
  }
  private renderCurrent(raw: unknown) {
    const input = intentInputs.intent_render.parse(raw),
      definition = input.definition;
    validateIntent(definition);
    if ((input.repositoryId ? 'component' : 'workspace') !== definition.kind)
      throw new DomainError('INTENT kind не соответствует владельцу');
    let document;
    if (definition.kind === 'component') {
      const root = this.root(input.repositoryId),
        sha = this.git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
      const sections = definition.sources.flatMap((source) =>
        this.requirements(root, source, sha).requirements.map((r) => ({ ...r, source })),
      );
      const pin = (ref: { source: string; id: string }) => {
        const r = sections.find((s) => referenceKey(s) === referenceKey(ref));
        if (!r) throw new DomainError('Неизвестное требование: ' + ref.source + ':' + ref.id);
        return { ...ref, digest: r.digest };
      };
      document = {
        ...definition,
        version: 1,
        sourceSha: sha,
        stories: definition.stories.map((s) => ({
          ...s,
          criteria: s.criteria.map((c) => ({ ...c, requirements: c.requirements.map(pin) })),
        })),
        exclusions: definition.exclusions.map((e) => ({ ...pin(e), reason: e.reason })),
      };
    } else {
      const issues = this.mapIssues(definition);
      if (issues.length) throw new DomainError(issues.join('; '));
      document = {
        ...definition,
        version: 1,
        releases: definition.releases.map((r) => ({
          ...r,
          components: r.components.map((c) => {
            const snapshot = this.read(c.repositoryId);
            if (!snapshot.document.releases.some((r) => r.id === c.releaseId))
              throw new DomainError('Неизвестный релиз компонента');
            return { ...c, intentDigest: snapshot.digest };
          }),
        })),
      };
    }
    const markdown = renderIntent(document);
    // These are ordinary pinned REQ sections; existing per-section safety limits apply.
    parseRequirements(markdown);
    if (Buffer.byteLength(markdown) > 1_000_000) throw new DomainError('INTENT превышает 1 MB');
    return {
      source: this.source(input.repositoryId),
      markdown,
      committed: false,
      next: 'Write in the selected owner, review scope, commit, then intent_snapshot. No file or status was changed.',
    };
  }
  private snapshotCurrent(raw: unknown) {
    const input = intentInputs.intent_snapshot.parse(raw),
      snapshot = this.read(input.repositoryId);
    if (snapshot.document.kind === 'workspace') {
      if (input.storyId)
        throw new DomainError('Workspace содержит ссылки на релизы, а не локальные истории');
      return {
        repositoryId: null,
        source: this.source(input.repositoryId),
        sha: snapshot.sha,
        digest: snapshot.digest,
        document: snapshot.document,
      };
    }
    const bindings = parseRequirements(snapshot.markdown);
    const stories = snapshot.document.stories.filter(
      (s) => !input.storyId || s.id === input.storyId,
    );
    if (!stories.length) throw new DomainError('Неизвестная история');
    return {
      repositoryId: input.repositoryId,
      source: this.source(input.repositoryId),
      sha: snapshot.sha,
      digest: snapshot.digest,
      releases: snapshot.document.releases,
      stories: stories.map((s) => ({
        ...s,
        requirement: {
          ...bindings.find((b) => b.id === intentRequirementId(s.id))!,
          source: this.source(input.repositoryId),
        },
      })),
    };
  }
  private reportCurrent(raw: unknown): Record<string, unknown> {
    const input = intentInputs.intent_report.parse(raw),
      snapshot = this.read(input.repositoryId);
    if (snapshot.document.kind === 'component')
      return this.componentReport(
        input.repositoryId!,
        input.releaseId,
        snapshot as typeof snapshot & { document: ComponentIntent },
      );
    const coverage = this.workspaceCoverage(snapshot.document, input.releaseId);
    const product = snapshot.document.product
      ? this.productProgress(snapshot.document, snapshot.digest, input.releaseId, coverage)
      : undefined;
    return {
      repositoryId: null,
      releaseId: input.releaseId,
      intentDigest: snapshot.digest,
      coverageComplete: coverage.complete,
      components: coverage.components,
      ...(product ? { product, issues: coverage.issues } : {}),
      releaseAccepted: product?.releaseAccepted ?? false,
      note: 'Coverage is not release acceptance. Product releases require a bound ChangeSet and fresh joint verification. Component task text stays local.',
    };
  }
  private workspaceCoverage(
    doc: WorkspaceIntent,
    releaseId: string,
    manifest?: Verification['manifest'],
    resultRefs?: Record<string, string>,
  ) {
    const release = doc.releases.find((r) => r.id === releaseId);
    if (!release) throw new DomainError('Неизвестный релиз');
    const locals = new Map<string, ReturnType<IntentService['componentReport']>>();
    const components = release.components.map((c) => {
      try {
        const actual = this.read(c.repositoryId, manifest?.[c.repositoryId]?.sha ?? 'HEAD');
        if (actual.document.kind !== 'component') throw new DomainError('Нужна карта компонента');
        const report = this.componentReport(
          c.repositoryId,
          c.releaseId,
          actual as typeof actual & { document: ComponentIntent },
          manifest?.[c.repositoryId]?.sha ?? resultRefs?.[c.repositoryId],
        );
        locals.set(c.repositoryId, report);
        return {
          ...c,
          currentDigest: actual.digest,
          fresh: c.intentDigest === actual.digest,
          coverageComplete: c.intentDigest === actual.digest && report.coverageComplete,
          counts: report.counts,
          issues: report.issues.length,
        };
      } catch {
        return { ...c, fresh: false, coverageComplete: false, unavailable: true };
      }
    });
    const issues = this.mapIssues(doc, releaseId);
    return {
      release,
      locals,
      components,
      issues,
      complete: !issues.length && components.every((c) => c.coverageComplete),
    };
  }
  private mapIssues(
    doc: Extract<z.infer<typeof intentDefinition>, { kind: 'workspace' }>,
    releaseId?: string,
  ) {
    if (!doc.product) return [];
    const issues: string[] = [],
      locals = new Map<string, ComponentIntent>();
    for (const component of doc.product.components) {
      try {
        repository(this.h.config, component.repositoryId);
      } catch {
        issues.push('Неизвестный репозиторий карты: ' + component.repositoryId);
      }
    }
    for (const release of doc.releases.filter((r) => !releaseId || r.id === releaseId)) {
      const linked = new Set<string>();
      for (const feature of release.features ?? []) {
        for (const check of feature.checks) {
          const gate = this.h.config.workspaceGates.find((g) => g.id === check.gate);
          if (!gate || gate.kind !== 'test' || !gate.report)
            issues.push('Фиче нужен настроенный сквозной test gate с JUnit: ' + check.gate);
        }
        for (const app of feature.channels) {
          if (app.scope !== 'included') continue;
          app.stories.forEach((s) => linked.add(storyKey(s)));
        }
      }
      for (const target of release.components) {
        try {
          if (!locals.has(target.repositoryId)) {
            const current = this.read(target.repositoryId).document;
            if (current.kind !== 'component') throw new DomainError('Нужна карта компонента');
            locals.set(target.repositoryId, current);
          }
          const local = locals.get(target.repositoryId)!;
          for (const key of linked) {
            const [repositoryId, storyId] = JSON.parse(key) as string[];
            if (
              repositoryId === target.repositoryId &&
              !local.stories.some((s) => s.id === storyId && s.releaseId === target.releaseId)
            )
              issues.push(
                'Неизвестная история в релизе компонента: ' + repositoryId + '/' + storyId,
              );
          }
          for (const story of local.stories.filter((s) => s.releaseId === target.releaseId))
            if (!linked.has(storyKey({ repositoryId: target.repositoryId, storyId: story.id })))
              issues.push(
                'История релиза не связана с фичей: ' + target.repositoryId + '/' + story.id,
              );
        } catch {
          issues.push('Недоступна карта компонента: ' + target.repositoryId);
        }
      }
    }
    return [...new Set(issues)];
  }

  private captureCurrent(
    releaseId: string,
    selected: ReturnType<typeof changeSnapshot>,
  ): ProductReleaseProof {
    const snapshot = this.read(),
      doc = snapshot.document;
    if (doc.kind !== 'workspace' || !doc.product)
      throw new DomainError('Для приёмки релиза нужна продуктовая карта workspace');
    const acceptedHeads = Object.fromEntries(
      repositories(this.h.config).map((repo) => [
        repo.id,
        this.git(repo.path, 'rev-parse', 'refs/heads/' + repo.targetBranch),
      ]),
    );
    const coverage = this.workspaceCoverage(doc, releaseId, undefined, acceptedHeads);
    if (!coverage.complete)
      throw new DomainError(
        'Продуктовый релиз не покрыт актуальными требованиями и задачами' +
          (coverage.issues.length ? ': ' + coverage.issues.join('; ') : ''),
      );
    const state = this.h.store.read();
    for (const board of selected.boards) {
      const revision = state.boards.find((b) => b.id === board.id)?.revisions.at(-1);
      if (revision?.status !== 'accepted' || revision.number !== board.revision)
        throw new DomainError('Для релиза сначала примите текущие ревизии всех досок');
    }
    const selectedIds = new Set(selected.tasks.map((t) => t.id));
    for (const local of coverage.locals.values())
      for (const taskId of local.stories.flatMap((s) => s.taskIds))
        if (!selectedIds.has(taskId))
          throw new DomainError('ChangeSet не включает задачу релиза: ' + taskId);
    return {
      releaseId,
      intentDigest: snapshot.digest,
      gateIds: [
        ...new Set(coverage.release.features!.flatMap((f) => f.checks.map((c) => c.gate))),
      ].sort(),
      acceptedHeads,
      sources: coverage.release.components.map((c) => {
        const local = this.read(c.repositoryId).document as ComponentIntent;
        const files = [...new Set([this.source(c.repositoryId), ...local.sources])].sort();
        return {
          repositoryId: c.repositoryId,
          files,
          digest: this.sourceDigest(c.repositoryId, files, 'HEAD'),
        };
      }),
      stateDigest: this.coverageStateDigest(
        coverage.release.components.map((c) => c.repositoryId),
        selected,
      ),
    };
  }

  private sourceDigest(repositoryId: string, files: string[], ref: string) {
    return digest(
      this.git(
        repository(this.h.config, repositoryId).path,
        '--literal-pathspecs',
        'ls-tree',
        ref,
        '--',
        ...files,
      ),
    );
  }

  private coverageStateDigest(
    repositoryIds: string[],
    selected: ReturnType<typeof changeSnapshot>,
  ) {
    const state = this.h.store.read();
    const tasks = state.tasks.filter((t) => repositoryIds.includes(taskOwner(t) ?? ''));
    const ids = new Set(tasks.map((t) => t.id));
    return digest({
      tasks: tasks.toSorted((a, b) => a.id.localeCompare(b.id)),
      checks: state.runs
        .filter((r) => ids.has(r.taskId) && r.status === 'succeeded')
        .map((r) => ({ id: r.id, taskId: r.taskId, evidence: r.evidence }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
      boards: selected.boards
        .map((b) => {
          const revision = state.boards.find((x) => x.id === b.id)?.revisions.at(-1);
          return { id: b.id, revision: revision?.number, status: revision?.status };
        })
        .toSorted((a, b) => a.id.localeCompare(b.id)),
    });
  }

  private validateCurrent(
    proof: ProductReleaseProof,
    selected: ReturnType<typeof changeSnapshot>,
    manifest?: Verification['manifest'],
  ) {
    const snapshot = this.read();
    if (snapshot.digest !== proof.intentDigest)
      throw new DomainError('Продуктовая карта изменилась; нужна новая проверка релиза');
    const doc = snapshot.document as WorkspaceIntent;
    const release = doc.releases.find((r) => r.id === proof.releaseId);
    if (
      !release ||
      this.mapGateIds(release) !== JSON.stringify(proof.gateIds) ||
      proof.stateDigest !==
        this.coverageStateDigest(
          release.components.map((c) => c.repositoryId),
          selected,
        )
    )
      throw new DomainError('Покрытие или проверки релиза изменились; нужна новая проверка');
    for (const [id, sha] of Object.entries(proof.acceptedHeads)) {
      const repo = repository(this.h.config, id);
      if (
        this.git(repo.path, 'rev-parse', 'refs/heads/' + repo.targetBranch) !== sha ||
        (manifest && manifest[id]?.sha !== sha)
      )
        throw new DomainError('Принятая версия компонента изменилась; повторите проверку релиза');
    }
    for (const source of proof.sources) {
      if (source.digest !== this.sourceDigest(source.repositoryId, source.files, 'HEAD'))
        throw new DomainError('Источники требований изменились; повторите проверку релиза');
      if (
        manifest &&
        (!manifest[source.repositoryId] ||
          source.digest !==
            this.sourceDigest(source.repositoryId, source.files, manifest[source.repositoryId].sha))
      )
        throw new DomainError(
          'Проверяемые SHA не содержат актуальные источники продуктового релиза',
        );
    }
  }

  private mapGateIds(release: WorkspaceIntent['releases'][number]) {
    return JSON.stringify(
      [...new Set(release.features?.flatMap((f) => f.checks.map((c) => c.gate)))].sort(),
    );
  }

  private productProgress(
    doc: WorkspaceIntent,
    intentDigest: string,
    releaseId: string,
    coverage: ReturnType<IntentService['workspaceCoverage']>,
  ) {
    const state = this.h.store.read(),
      workspace = new Workspace(this.h);
    let verification: { changeSetId: string; verificationId: string } | undefined;
    let releaseAccepted = false;
    for (const changeSet of [...state.changeSets].reverse()) {
      if (changeSet.releaseId !== releaseId) continue;
      const run = changeSet.verifications.at(-1);
      if (
        !run ||
        run.status !== 'passed' ||
        !run.manifest ||
        !run.productRelease ||
        run.productRelease.releaseId !== releaseId ||
        run.productRelease.intentDigest !== intentDigest ||
        run.manifestDigest !== digest(run.manifest) ||
        run.policyDigest !== workspace.policyDigest()
      )
        continue;
      try {
        const selected = changeSnapshot(state, changeSet);
        if (run.specDigest !== snapshotDigest(selected)) continue;
        this.validate(run.productRelease, selected, run.manifest);
        if (
          this.h.config.workspaceGates.some(
            (g) => !run.evidence.findLast((e) => e.gate === g.id)?.passed,
          )
        )
          continue;
        verification = { changeSetId: changeSet.id, verificationId: run.id };
        releaseAccepted =
          changeSet.acceptance?.verificationId === run.id &&
          changeSet.acceptance.digest === digest(run) &&
          (this.h.config.completionMode !== 'remote' || Boolean(delivered(this.h, changeSet)));
        if (releaseAccepted) break;
      } catch {
        /* An old acceptance remains history, not current product readiness. */
      }
    }
    const features: FeatureProgress[] = coverage.release.features!.map((scope) => {
      const feature = doc.product!.features.find((f) => f.id === scope.featureId)!;
      const channels = scope.channels.map((app) => {
        if (app.scope !== 'included') return app;
        const stories = app.stories.map((ref) => ({
          story: coverage.locals.get(ref.repositoryId)?.stories.find((s) => s.id === ref.storyId),
          fresh: coverage.components.find((c) => c.repositoryId === ref.repositoryId)?.fresh,
        }));
        return {
          ...app,
          covered: stories.every((s) => s.fresh && s.story?.verified),
          planned: stories.every((s) => Boolean(s.story?.taskIds.length)),
        };
      });
      const included = channels.filter((a) => a.scope === 'included');
      const covered = included.length > 0 && included.every((a) => a.covered);
      const status: FeatureProgress['status'] = !included.length
        ? channels.some((a) => a.scope === 'deferred')
          ? 'deferred'
          : 'not-applicable'
        : !included.every((a) => a.planned)
          ? 'unplanned'
          : !covered
            ? 'in-progress'
            : releaseAccepted
              ? 'accepted'
              : verification
                ? 'verified'
                : 'awaiting-verification';
      return {
        ...feature,
        status,
        channels,
        checks: scope.checks.map((c) => ({ ...c, passed: covered && Boolean(verification) })),
      };
    });
    return { features, verification, releaseAccepted };
  }

  private productViewCurrent(raw: unknown = {}): ProductView {
    const input = intentInputs.product_view.parse(raw);
    if (!this.h.config.workspaceRoot)
      return {
        available: false,
        reason: 'Укажите Git workspace и подготовьте его INTENT.md с картой продукта.',
      };
    const root = this.root();
    if (!this.git(root, 'ls-tree', 'HEAD', '--', 'INTENT.md'))
      return {
        available: false,
        reason: 'Ведущий агент ещё не закрепил INTENT.md в Git workspace.',
      };
    const snapshot = this.read(),
      doc = snapshot.document as WorkspaceIntent;
    if (!doc.product)
      return {
        available: false,
        reason:
          'В INTENT.md есть релизы компонентов; добавьте приложения и карту фич через intent_render.',
      };
    const releaseId = input.releaseId ?? doc.releases[0].id;
    const coverage = this.workspaceCoverage(doc, releaseId);
    const issues = [
      ...coverage.issues,
      ...coverage.components
        .filter((c) => !c.coverageComplete)
        .map((c) => 'Нет актуального полного покрытия компонента: ' + c.repositoryId),
    ];
    return {
      available: true,
      title: doc.title,
      purpose: doc.purpose,
      channels: doc.product.channels,
      components: doc.product.components,
      releases: doc.releases.map((r) => ({ id: r.id, title: r.title })),
      releaseId,
      intentDigest: snapshot.digest,
      coverageComplete: coverage.complete,
      issues,
      ...this.productProgress(doc, snapshot.digest, releaseId, coverage),
    };
  }

  private componentReport(
    repositoryId: string,
    releaseId: string,
    snapshot: { sha: string; markdown: string; document: ComponentIntent; digest: string },
    resultRef?: string,
  ) {
    const doc = snapshot.document,
      root = this.root(repositoryId);
    if (!doc.releases.some((r) => r.id === releaseId)) throw new DomainError('Неизвестный релиз');
    const state = this.h.store.read(),
      replaced = new Set(state.tasks.map((t) => t.supersedes));
    const tasks = state.tasks.filter((t) => taskOwner(t) === repositoryId && !replaced.has(t.id));
    const issues: { kind: string; source?: string; id?: string }[] = [];
    const sources = new Map<
      string,
      ReturnType<typeof requirementSnapshot>['requirements'] | null
    >();
    const sectionsAt = (source: string) => {
      if (!sources.has(source)) {
        try {
          sources.set(source, this.requirements(root, source, snapshot.sha).requirements);
        } catch {
          sources.set(source, null);
        }
      }
      return sources.get(source);
    };
    const current = new Map<string, { digest: string }>();
    for (const source of doc.sources) {
      const sections = sectionsAt(source);
      if (!sections) {
        issues.push({ kind: 'unavailable-source', source });
        continue;
      }
      if (!sections.length) issues.push({ kind: 'empty-source', source });
      for (const r of sections) current.set(referenceKey({ source, id: r.id }), r);
    }
    const mapped = new Set(
      doc.stories.flatMap((s) => s.criteria.flatMap((c) => c.requirements.map(referenceKey))),
    );
    const excluded = new Set(doc.exclusions.map(referenceKey));
    for (const key of current.keys())
      if (!mapped.has(key) && !excluded.has(key)) {
        const [source, id] = JSON.parse(key) as string[];
        issues.push({ kind: 'unmapped-requirement', source, id });
      }
    for (const e of doc.exclusions)
      if (current.get(referenceKey(e))?.digest !== e.digest)
        issues.push({ kind: 'stale-exclusion', source: e.source, id: e.id });
    const bindings = parseRequirements(snapshot.markdown);
    const knownStories = new Set(bindings.map((b) => b.id));
    const fresh = (task: Task) => {
      return (task.requirements ?? []).every((r) =>
        sectionsAt(r.source)?.some((s) => s.id === r.id && s.digest === r.digest),
      );
    };
    const completionCache = new Map<string, boolean>();
    let resultTip: string | undefined,
      allResultsIntegrated = false;
    const results = [...new Set(tasks.filter((t) => t.status === 'done').map((t) => t.resultSha))];
    if (results.length && results.every((sha) => sha && /^[a-f0-9]{40,64}$/.test(sha))) {
      try {
        resultTip = this.git(
          root,
          'rev-parse',
          resultRef ?? repository(this.h.config, repositoryId).targetBranch,
        );
        allResultsIntegrated = true;
        // A bounded batch has only the accepted tip as an independent head iff all
        // result commits are its ancestors. Fall back per task for partial reports.
        for (let offset = 0; offset < results.length; offset += 100) {
          if (
            this.git(
              root,
              'merge-base',
              '--independent',
              resultTip,
              ...(results.slice(offset, offset + 100) as string[]),
            ) !== resultTip
          ) {
            allResultsIntegrated = false;
            break;
          }
        }
      } catch {
        allResultsIntegrated = false;
      }
    }
    const completed = (task: Task) => {
      if (completionCache.has(task.id)) return completionCache.get(task.id)!;
      completionCache.set(task.id, false);
      if (task.status !== 'done' || task.approvedDigest !== specDigest(task) || !fresh(task))
        return false;
      try {
        if (!allResultsIntegrated)
          this.git(
            root,
            'merge-base',
            '--is-ancestor',
            task.resultSha!,
            resultTip ?? resultRef ?? repository(this.h.config, repositoryId).targetBranch,
          );
      } catch {
        return false;
      }
      completionCache.set(task.id, true);
      return true;
    };
    const checked = (task: Task, gate: string) => {
      return taskEvidence(state, task).some(
        (e) =>
          e.kind === 'test' &&
          e.gate === gate &&
          e.phase === 'integration' &&
          e.sha === task.resultSha &&
          e.passed &&
          e.exitCode === 0,
      );
    };
    // Покрытие подтверждается тем же правилом, что и приёмка: связь, назвавшая
    // свой тест, требует именно его на принятом SHA; без testId — прежний
    // уровень зелёной проверки.
    const proven = (task: Task, link: RequirementLink) =>
      checked(task, link.gate) &&
      (!link.testId ||
        requirementProof(link, taskEvidence(state, task), task.resultSha).level === 'testcase');
    const stories = doc.stories
      .filter((s) => s.releaseId === releaseId)
      .map((story) => {
        const binding = bindings.find((b) => b.id === intentRequirementId(story.id))!;
        const requirementKeys = new Set(
          story.criteria.flatMap((c) => c.requirements.map(referenceKey)),
        );
        const related = tasks.filter((t) => {
          const links = t.requirements ?? [];
          if (links.some((r) => r.source === this.source(repositoryId) && r.id === binding.id))
            return true;
          // An unassigned contributor cannot disappear behind another completed task.
          // Explicitly assigned stories of other releases retain their own scope.
          return (
            !links.some((r) => r.source === this.source(repositoryId) && knownStories.has(r.id)) &&
            links.some((r) => requirementKeys.has(referenceKey(r)))
          );
        });
        const eligible = related.filter(
          (t) =>
            completed(t) &&
            t.requirements?.some(
              (r) =>
                r.source === this.source(repositoryId) &&
                r.id === binding.id &&
                r.digest === binding.digest &&
                proven(t, r),
            ) &&
            checked(t, 'requirement-source'),
        );
        const criteria = story.criteria.map((c) => {
          const requirements = c.requirements.map((r) => {
            const matching = related.filter((t) =>
              t.requirements?.some((l) => referenceKey(l) === referenceKey(r)),
            );
            const fresh = current.get(referenceKey(r))?.digest === r.digest;
            const verified =
              fresh &&
              matching.length > 0 &&
              matching.every(
                (t) =>
                  eligible.includes(t) &&
                  t.requirements!.some(
                    (l) =>
                      referenceKey(l) === referenceKey(r) && l.digest === r.digest && proven(t, l),
                  ),
              );
            return {
              ...r,
              fresh,
              verified,
              status: !fresh
                ? 'stale-source'
                : !matching.length
                  ? 'unplanned'
                  : !verified
                    ? 'unverified'
                    : 'verified',
              taskIds: matching.map((t) => t.id),
            };
          });
          return {
            id: c.id,
            text: c.text,
            verified: requirements.every((r) => r.verified),
            requirements,
          };
        });
        return {
          id: story.id,
          title: story.title,
          taskIds: related.map((t) => t.id),
          unverifiedTaskIds: related.filter((t) => !eligible.includes(t)).map((t) => t.id),
          verified:
            related.length > 0 &&
            related.length === eligible.length &&
            criteria.every((c) => c.verified),
          criteria,
        };
      });
    if (!stories.length) issues.push({ kind: 'empty-release' });
    return {
      repositoryId,
      releaseId,
      intentDigest: snapshot.digest,
      sourceSha: snapshot.sha,
      coverageComplete: !issues.length && stories.length > 0 && stories.every((s) => s.verified),
      counts: {
        stories: stories.length,
        verified: stories.filter((s) => s.verified).length,
        requirements: current.size,
        exclusions: doc.exclusions.length,
      },
      issues,
      stories,
      releaseAccepted: false,
      note: 'Coverage of declared REQ sources only. Review source inventory and test adequacy. Completion is historical SHA evidence, not a new whole-product test or release acceptance.',
    };
  }
}
