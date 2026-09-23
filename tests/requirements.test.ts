import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupDemo } from '../src/demo.ts';
import { loadConfig } from '../src/runner/config.ts';
import { Store } from '../src/core/store.ts';
import { DevContour, specDigest } from '../src/core/service.ts';
import { updateBase } from '../src/runner/base-update.ts';
import { Scheduler } from '../src/runner/scheduler.ts';
import { git } from '../src/runner/process.ts';
import { acceptBoard } from '../src/runner/agent-control.ts';
import {
  parseRequirements,
  requirementSnapshot,
  requirementReport,
  correctRequirements,
} from '../src/runner/requirements.ts';
import { input } from './helpers.ts';

test('Requirement parser ignores examples, rejects duplicate IDs and bounds sections', () => {
  assert.equal(
    parseRequirements(
      '```md\n## REQ-fake: example\n```\n## REQ-real: Real\nExpected behaviour\n## Notes\nNot requirement',
    )[0].id,
    'REQ-real',
  );
  assert.throws(() => parseRequirements('## REQ-a: One\n## REQ-a: Two'), /Повтор/);
  assert.throws(() => parseRequirements('## REQ-a: One\n' + 'x'.repeat(12000)), /Разбейте/);
});

test('Requirements survive real Git execution; changed spec loses current coverage and creates immutable correction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devcontour-requirements-'));
  await setupDemo(root);
  const config = loadConfig(join(root, 'config.json'));
  const store = new Store(join(root, 'state.sqlite'));
  const h = new DevContour(store, config),
    scheduler = new Scheduler(h, root);
  try {
    store.change('fixture.reset', (s) => {
      s.tasks = [];
      s.boards = [];
      s.runs = [];
    });
    await mkdir(join(config.repository, 'docs'), { recursive: true });
    await writeFile(
      join(config.repository, 'docs/spec.md'),
      '## REQ-catalog: Catalogue\nList the catalogue.\n',
    );
    await git(config.repository, 'add', 'docs/spec.md');
    await git(config.repository, 'commit', '-m', 'Specify catalogue');
    await git(config.repository, 'update-ref', 'refs/heads/' + config.targetBranch, 'HEAD');
    const snapshot = requirementSnapshot(config.repository, 'docs/spec.md');
    const requirement = {
      ...snapshot.requirements[0],
      source: snapshot.source,
      gate: config.gates[0].id,
      scenario: 'Catalogue listing',
    };
    const board = h.createBoard('Traceable catalogue');
    const task = h.addTask(board.id, { ...input(), requirements: [requirement] });
    assert.throws(
      () =>
        h.addTask(board.id, { ...input(), requirements: [{ ...requirement, gate: 'missing' }] }),
      /test gate/,
    );
    assert.throws(
      () =>
        h.addTask(board.id, {
          ...input(),
          requirements: [{ ...requirement, text: 'Forged requirement' }],
        }),
      /digest/,
    );
    h.approve(board.id);
    await scheduler.init();
    // Требование только что закоммичено в рабочую ветку: база прогонов должна
    // его содержать, иначе исполнитель ищет источник в дереве без него.
    await updateBase(config, root);
    h.pause(false);
    await scheduler.drain();
    const done = store.read().tasks.find((t) => t.id === task.id)!;
    assert.equal(done.status, 'done', done.failure);
    assert.ok(
      store
        .read()
        .runs[0].timings?.some((t) => t.stage === 'implementation' && t.outcome === 'passed'),
    );
    assert.ok(
      store
        .read()
        .runs[0].timings?.some((t) => t.stage.startsWith('integration-test:') && t.finishedAt),
    );
    assert.equal(requirementReport(h, 'main').tasks[0].requirements[0].verified, true);
    assert.equal(
      store.read().runs[0].evidence.filter((e) => e.gate === 'requirement-source').length,
      2,
    );
    await acceptBoard(h, board.id, 'codex');
    const original = store.read().boards[0].revisions[0].snapshot!.digest;
    await writeFile(
      join(config.repository, 'docs/spec.md'),
      '## REQ-catalog: Catalogue\nList and filter the catalogue.\n',
    );
    await git(config.repository, 'add', 'docs/spec.md');
    await git(config.repository, 'commit', '-m', 'Change requirement');
    assert.equal(requirementReport(h, 'main').tasks[0].requirements[0].verified, false);
    correctRequirements(h, board.id, 'Add filtering to catalogue requirement');
    const state = store.read(),
      replacement = state.tasks.find((t) => t.supersedes === task.id)!;
    assert.equal(state.boards[0].revisions[0].snapshot!.digest, original);
    assert.equal(replacement.status, 'draft');
    assert.notEqual(replacement.requirements![0].digest, requirement.digest);
    assert.notEqual(specDigest(replacement), done.approvedDigest);
    // Задача цитирует новую редакцию спецификации, а база прогонов её ещё не
    // содержит: выдать работу на таком дереве значит искать источник там, где
    // его нет. Раньше это давало непонятный провал задачи — теперь отказ назван.
    h.approve(board.id);
    await assert.rejects(scheduler.drain(), /base-update/);
    assert.equal(store.read().tasks.find((t) => t.id === replacement.id)!.status, 'ready');

    // С перенесённой базой источник на месте, и доказательство снова собирается.
    await updateBase(config, root);
    await scheduler.drain();
    const redone = store.read().tasks.find((t) => t.id === replacement.id)!;
    assert.equal(redone.status, 'done', redone.failure);
    assert.equal(requirementReport(h, 'main').tasks[0].requirements[0].verified, true);
  } finally {
    await scheduler.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
