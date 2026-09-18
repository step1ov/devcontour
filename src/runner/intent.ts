import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { Harness, digest, specDigest } from '../core/service.ts';
import { DomainError, requireValue, type Task } from '../core/model.ts';
import { repository } from '../core/repositories.ts';
import { taskOwner } from '../core/sync-state.ts';
import {
  intentDefinition,
  intentRequirementId,
  parseIntent,
  referenceKey,
  renderIntent,
  validateIntent,
  type ComponentIntent,
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
};
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1_100_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}
export class IntentService {
  constructor(readonly h: Harness) {}
  private root(repositoryId?: string) {
    return repositoryId
      ? repository(this.h.config, repositoryId).path
      : requireValue(this.h.config.workspaceRoot, 'Нужен Git workspaceRoot');
  }
  private read(repositoryId?: string) {
    const root = this.root(repositoryId),
      sha = git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
    if (!/^100(644|755) blob /.test(git(root, 'ls-tree', sha, '--', 'INTENT.md')))
      throw new DomainError('Нужен обычный committed INTENT.md выбранного владельца');
    const markdown = git(root, 'show', sha + ':INTENT.md'),
      document = parseIntent(markdown);
    if ((repositoryId ? 'component' : 'workspace') !== document.kind)
      throw new DomainError('INTENT kind не соответствует владельцу');
    return { sha, markdown, document, digest: digest(document) };
  }
  render(raw: unknown) {
    const input = intentInputs.intent_render.parse(raw),
      definition = input.definition;
    validateIntent(definition);
    if ((input.repositoryId ? 'component' : 'workspace') !== definition.kind)
      throw new DomainError('INTENT kind не соответствует владельцу');
    let document;
    if (definition.kind === 'component') {
      const root = this.root(input.repositoryId),
        sha = git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
      const sections = definition.sources.flatMap((source) =>
        requirementSnapshot(root, source, sha).requirements.map((r) => ({ ...r, source })),
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
      source: 'INTENT.md',
      markdown,
      committed: false,
      next: 'Write in the selected owner, review scope, commit, then intent_snapshot. No file or status was changed.',
    };
  }
  snapshot(raw: unknown) {
    const input = intentInputs.intent_snapshot.parse(raw),
      snapshot = this.read(input.repositoryId);
    if (snapshot.document.kind === 'workspace') {
      if (input.storyId)
        throw new DomainError('Workspace содержит ссылки на релизы, а не локальные истории');
      return {
        repositoryId: null,
        source: 'INTENT.md',
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
      source: 'INTENT.md',
      sha: snapshot.sha,
      digest: snapshot.digest,
      releases: snapshot.document.releases,
      stories: stories.map((s) => ({
        ...s,
        requirement: {
          ...bindings.find((b) => b.id === intentRequirementId(s.id))!,
          source: 'INTENT.md',
        },
      })),
    };
  }
  report(raw: unknown): Record<string, unknown> {
    const input = intentInputs.intent_report.parse(raw),
      snapshot = this.read(input.repositoryId);
    if (snapshot.document.kind === 'component')
      return this.componentReport(
        input.repositoryId!,
        input.releaseId,
        snapshot as typeof snapshot & { document: ComponentIntent },
      );
    const release = snapshot.document.releases.find((r) => r.id === input.releaseId);
    if (!release) throw new DomainError('Неизвестный релиз');
    const components = release.components.map((c) => {
      try {
        const actual = this.read(c.repositoryId);
        const report = this.componentReport(
          c.repositoryId,
          c.releaseId,
          actual as typeof actual & { document: ComponentIntent },
        );
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
    return {
      repositoryId: null,
      releaseId: release.id,
      intentDigest: snapshot.digest,
      coverageComplete: components.every((c) => c.coverageComplete),
      components,
      releaseAccepted: false,
      note: 'Coverage only. Joint ChangeSet verification and the configured publication policy remain mandatory. Component task text stays local.',
    };
  }
  private componentReport(
    repositoryId: string,
    releaseId: string,
    snapshot: { sha: string; markdown: string; document: ComponentIntent; digest: string },
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
          sources.set(source, requirementSnapshot(root, source, snapshot.sha).requirements);
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
    const completed = (task: Task) => {
      if (completionCache.has(task.id)) return completionCache.get(task.id)!;
      completionCache.set(task.id, false);
      if (task.status !== 'done' || task.approvedDigest !== specDigest(task) || !fresh(task))
        return false;
      try {
        git(
          root,
          'merge-base',
          '--is-ancestor',
          task.resultSha!,
          repository(this.h.config, repositoryId).targetBranch,
        );
      } catch {
        return false;
      }
      completionCache.set(task.id, true);
      return true;
    };
    const checked = (task: Task, gate: string) => {
      const run = state.runs.findLast((r) => r.taskId === task.id && r.status === 'succeeded');
      return (run?.evidence ?? task.sharedCompletion?.receipt.checks ?? []).some(
        (e) =>
          e.kind === 'test' &&
          e.gate === gate &&
          e.phase === 'integration' &&
          e.sha === task.resultSha &&
          e.passed &&
          e.exitCode === 0,
      );
    };
    const stories = doc.stories
      .filter((s) => s.releaseId === releaseId)
      .map((story) => {
        const binding = bindings.find((b) => b.id === intentRequirementId(story.id))!;
        const requirementKeys = new Set(
          story.criteria.flatMap((c) => c.requirements.map(referenceKey)),
        );
        const related = tasks.filter((t) => {
          const links = t.requirements ?? [];
          if (links.some((r) => r.source === 'INTENT.md' && r.id === binding.id)) return true;
          // An unassigned contributor cannot disappear behind another completed task.
          // Explicitly assigned stories of other releases retain their own scope.
          return (
            !links.some((r) => r.source === 'INTENT.md' && knownStories.has(r.id)) &&
            links.some((r) => requirementKeys.has(referenceKey(r)))
          );
        });
        const eligible = related.filter(
          (t) =>
            completed(t) &&
            t.requirements?.some(
              (r) =>
                r.source === 'INTENT.md' &&
                r.id === binding.id &&
                r.digest === binding.digest &&
                checked(t, r.gate),
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
                      referenceKey(l) === referenceKey(r) &&
                      l.digest === r.digest &&
                      checked(t, l.gate),
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
