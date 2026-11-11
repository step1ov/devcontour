import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { input } from './helpers.ts';
import { parseIntent } from '../src/core/intent.ts';
import { DevContour } from '../src/core/service.ts';
import { Store } from '../src/core/store.ts';
import { Workspace } from '../src/core/workspace.ts';
import { IntentService } from '../src/runner/intent.ts';
import { git, command } from '../src/runner/process.ts';
import { AgentService } from '../src/application/agent.ts';
import { syncGit } from '../src/runner/git-sync.ts';
import { recordsFromState, stateFromRecords } from '../src/core/sync-state.ts';
import { fixture, map } from './product-fixture.ts';

test('Product map separates monorepo channels and cross-repository features; rejects incomplete or unsafe declarations', async () => {
  const f = await fixture();
  try {
    const view = f.view();
    assert.equal(view.channels.length, 2);
    assert.equal(view.components.filter((c) => c.repositoryId === 'app').length, 2);
    assert.equal(view.features[0].status, 'unplanned');
    assert.equal(view.features[1].status, 'deferred');
    assert.equal(view.releaseAccepted, false);
    assert.ok(
      !JSON.stringify(view).includes('Участник не может отправлять сообщения после блокировки.'),
    );
    assert.ok(!JSON.stringify(view).includes('taskIds'));
    assert.deepEqual(
      new AgentService(f.h).execute({ operation: 'product_view', input: { releaseId: 'mvp' } }),
      view,
    );
    for (const mutate of [
      (d: any) => d.releases[0].features.pop(),
      (d: any) => d.releases[0].features[0].channels.pop(),
      (d: any) => (d.releases[0].features[0].channels[0].stories[0].storyId = 'absent'),
      (d: any) => (d.releases[0].features[0].checks[0].gate = 'absent'),
      (d: any) => (d.releases[0].features[0].checks = []),
      (d: any) => d.product.components[2].dependsOn.push('web'),
      (d: any) => (d.product.components[0].path = '../other'),
      (d: any) => (d.product.components[0].repositoryId = 'unknown'),
      (d: any) => d.releases[0].features[0].channels.forEach((a: any) => a.stories.pop()),
    ]) {
      const changed = map();
      mutate(changed);
      assert.throws(() => f.intent.render({ definition: changed }));
    }
    const markdown = await readFile(join(f.control, 'INTENT.md'), 'utf8');
    assert.throws(
      () => parseIntent(markdown.replace('## Возможности продукта', '## Другие возможности')),
      /расходятся/,
    );
    const cli = await command(
      [
        process.execPath,
        '--import',
        'tsx',
        'src/cli.ts',
        'product-view',
        '--release',
        'mvp',
        '--require-accepted',
        '--data',
        f.root,
      ],
      process.cwd(),
      { timeoutMs: 20000 },
    );
    assert.equal(cli.code, 1);
    assert.equal(JSON.parse(cli.stdout).releaseAccepted, false);
  } finally {
    await f.close();
  }
});

test('A product release needs every local board and real joint tests; acceptance stays distinct from task completion', async () => {
  const f = await fixture();
  try {
    f.plan();
    assert.equal(f.view().features[0].status, 'in-progress');
    const change = f.runner.workspace.create({
      title: 'Релиз модерации',
      description: 'Согласованная блокировка во всех клиентах.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    assert.throws(() => f.runner.verify(change.id), /завершите/);
    await f.run();
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    // A live unfinished task keeps the release uncovered, and the refusal names it.
    const late = f.h.createBoard('Поздняя правка', '', 'app');
    const pending = f.h.addTask(late.id, {
      ...input('Поздняя правка блокировки'),
      repositoryId: 'app',
      requirements: f.store.read().tasks.find((t) => t.repositoryId === 'app')!.requirements,
    });
    assert.equal(f.view().features[0].status, 'in-progress');
    assert.throws(
      () => f.runner.verify(change.id),
      (e: Error) =>
        /не покрыт/.test(e.message) &&
        e.message.includes('история app/block: не подтверждены задачи ' + pending.id),
    );
    // A cancelled task is not current work: it stays visible as excluded and
    // does not hold the release open.
    f.h.cancel(pending.id, 'Правка не нужна');
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    const local = f.intent.report({ repositoryId: 'app', releaseId: 'mvp' }) as {
      coverageComplete: boolean;
      stories: { excludedTasks: { id: string; reason: string }[]; taskIds: string[] }[];
    };
    assert.equal(local.coverageComplete, true);
    assert.deepEqual(local.stories[0].excludedTasks, [{ id: pending.id, reason: 'cancelled' }]);
    assert.ok(!local.stories[0].taskIds.includes(pending.id));
    assert.throws(() => f.runner.verify(change.id), /примите/);
    await f.accept();
    assert.throws(() => new Workspace(f.h).start(change.id), /runner/);
    const partial = f.runner.workspace.create({
      title: 'Неполный релиз',
      description: 'Забыли доску библиотеки.',
      boardIds: [f.boards[0]],
      releaseId: 'mvp',
    });
    assert.throws(() => f.runner.verify(partial.id), /не включает задачу/);
    const original = f.c.workspaceGates[0].command;
    f.c.workspaceGates[0].command = [process.execPath, '-e', 'process.exit(1)'];
    await assert.rejects(f.runner.verify(change.id));
    assert.equal(f.view().features[0].status, 'awaiting-verification');
    f.c.workspaceGates[0].command = original;
    await f.runner.verify(change.id);
    const checked = f.view();
    assert.equal(checked.features[0].status, 'verified');
    assert.ok(checked.features[0].checks.every((c) => c.passed));
    assert.deepEqual(
      checked.features[0].checks.map((c) => [c.status, c.evidence.map((e) => e.testId)]),
      [['evidenced', ['policy type', 'policy type']]],
    );
    assert.equal(checked.releaseAccepted, false);
    const verification = f.store
      .read()
      .changeSets.find((c) => c.id === change.id)!
      .verifications.at(-1)!;
    assert.equal(verification.impact!.mode, 'all');
    assert.ok(verification.productRelease?.intentDigest);
    // A pending ChangeSet may be rebound by Git sync; its old proof belongs to the old release.
    f.store.change('fixture.rebind-release', (s) => {
      s.changeSets.find((c) => c.id === change.id)!.releaseId = 'next';
    });
    const next = f.intent.productView({ releaseId: 'next' });
    assert.ok(next.available && !next.verification && !next.releaseAccepted);
    assert.throws(() => f.runner.workspace.accept(change.id), /актуальной/);
    f.store.change('fixture.restore-release', (s) => {
      s.changeSets.find((c) => c.id === change.id)!.releaseId = 'mvp';
    });
    const evidence = structuredClone(f.store.read().runs[0].evidence);
    f.store.change('fixture.missing-proof', (s) => {
      s.runs[0].evidence = [];
    });
    assert.throws(() => f.runner.workspace.accept(change.id), /Покрытие/);
    f.store.change('fixture.restore-proof', (s) => {
      s.runs[0].evidence = evidence;
    });
    f.c.approvalMode = 'operator';
    assert.equal(f.runner.workspace.accept(change.id).status, 'awaiting-operator');
    assert.equal(f.view().releaseAccepted, false);
    f.runner.workspace.accept(change.id, { actor: 'operator' });
    assert.equal(f.view().features[0].status, 'accepted');
    const portable = recordsFromState(f.h, f.store.read());
    for (const records of portable.values())
      for (const record of Object.values(records))
        if (record.kind === 'changeset' && record.data.id === change.id)
          record.data.releaseId = 'different';
    assert.throws(
      () => stateFromRecords(f.h, f.store.read(), portable, new Map()),
      /Нельзя менять принятый ChangeSet/,
    );
    const receipt = structuredClone(
      f.store.read().changeSets.find((c) => c.id === change.id)!.acceptance,
    );
    const acceptedRef = 'refs/heads/' + f.repos[0].targetBranch;
    const parent = await git(f.repos[0].path, 'rev-parse', acceptedRef);
    const tree = await git(f.repos[0].path, 'rev-parse', parent + '^{tree}');
    const advanced = await git(
      f.repos[0].path,
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      'A later unverified combination',
    );
    await git(f.repos[0].path, 'update-ref', acceptedRef, advanced, parent);
    assert.equal(f.view().coverageComplete, true);
    assert.equal(f.view().releaseAccepted, false);
    assert.deepEqual(
      f.store.read().changeSets.find((c) => c.id === change.id)!.acceptance,
      receipt,
    );
  } finally {
    await f.close();
  }
});

test('Git sync preserves product release binding across clones without importing release acceptance', async () => {
  const f = await fixture();
  let imported: Store | undefined;
  try {
    syncGit(f.h, { member: 'alice' });
    f.plan();
    const change = f.runner.workspace.create({
      title: 'Общий релиз',
      description: 'Переносим общую связь, не локальные проверки.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    syncGit(f.h);
    for (const path of [f.control, ...f.repos.map((r) => r.path)])
      await f.commit(path, 'Share portable tasks');
    const control = join(f.root, 'cloned-control');
    await git(f.root, 'clone', '--no-local', f.control, control);
    const repos = [];
    for (const repo of f.repos) {
      const path = join(f.root, 'clone-' + repo.id);
      await git(f.root, 'clone', '--no-local', repo.path, path);
      repos.push({ ...repo, path });
    }
    imported = new Store(join(f.root, 'clone.sqlite'));
    const h = new DevContour(imported, {
      ...f.c,
      repository: repos[0].path,
      repositories: repos,
      workspaceRoot: control,
    });
    syncGit(h, { member: 'bob' });
    const received = imported.read().changeSets.find((c) => c.id === change.id)!;
    assert.equal(received.releaseId, 'mvp');
    assert.equal(received.acceptance, undefined);
    assert.deepEqual(received.verifications, []);
    assert.deepEqual(new IntentService(h).productView(), f.view());
  } finally {
    imported?.close();
    await f.close();
  }
});

test('Joint verification masks secrets in its JUnit copy, evidence, failure and verification error', async () => {
  const f = await fixture();
  // Секрет с кавычкой: в JUnit он появляется как XML-сущность, в JSON — как \".
  const secret = 'joint-secret"7781';
  process.env.DEVCONTOUR_TEST_JOINT_SECRET = secret;
  try {
    f.plan();
    const change = f.runner.workspace.create({
      title: 'Релиз с секретом',
      description: 'Совместная проверка видит секрет окружения.',
      boardIds: f.boards,
      releaseId: 'mvp',
    });
    await f.run();
    await f.accept();
    f.c.environment = {
      inherit: ['PATH', 'HOME'],
      values: {},
      secrets: { SECRET: 'DEVCONTOUR_TEST_JOINT_SECRET' },
    };
    const forms = [secret, secret.replace('"', '&quot;'), secret.replace('"', '\\"')];
    const leaks = (text: string) => forms.filter((form) => text.includes(form));
    const check = async (script: string) => {
      f.c.workspaceGates[0].command = [process.execPath, '-e', script];
      await assert.rejects(f.runner.verify(change.id));
      const verification = f.store
        .read()
        .changeSets.find((c) => c.id === change.id)!
        .verifications.at(-1)!;
      const evidence = verification.evidence.at(-1)!;
      const files = [evidence.log, evidence.log.replace(/\.log$/, '.xml')];
      for (const file of files) {
        const text = await readFile(file, 'utf8').catch(() => '');
        assert.deepEqual(leaks(text), [], file);
      }
      assert.deepEqual(leaks(JSON.stringify(evidence)), [], 'evidence');
      assert.deepEqual(leaks(verification.error ?? ''), [], 'verification.error');
      return evidence;
    };
    // Проваленный testcase с секретом в имени и сообщении.
    const failed = await check(
      `const fs=require('fs');fs.mkdirSync('.reports',{recursive:true});const s=process.env.SECRET.replace(/"/g,'&quot;');fs.writeFileSync(process.env.DEVCONTOUR_REPORT_PATH,'<testsuite tests="1" failures="1"><testcase name="'+s+'"><failure message="'+s+'"/></testcase></testsuite>');`,
    );
    assert.equal(failed.passed, false);
    // Отчёт ссылается на недоступный файл, названный секретом: путь — в
    // тексте ошибки чтения.
    await check(
      `const fs=require('fs'),p=require('path');fs.mkdirSync('.reports',{recursive:true});const t=p.join('.reports',process.env.SECRET);fs.writeFileSync(t,'<testsuite/>');fs.chmodSync(t,0);fs.rmSync(process.env.DEVCONTOUR_REPORT_PATH,{force:true});fs.symlinkSync(p.resolve(t),process.env.DEVCONTOUR_REPORT_PATH);`,
    );
  } finally {
    delete process.env.DEVCONTOUR_TEST_JOINT_SECRET;
    await f.close();
  }
});
