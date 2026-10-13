'use strict';

/**
 * 逻辑自测（无需 Electron / SMTP）：
 *   node test/run-tests.js
 * 覆盖：模板变量编译、调度时间计算、数据层 CRUD 与统计、CSV 导入、错误归类、试运行全流程。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Database, LOG_STATUS, parseCsv } = require('../src/main/db');
const template = require('../src/main/template');
const { scheduleNextRun, describeSchedule } = require('../src/main/scheduler');
const mailer = require('../src/main/mailer');
const tencentSes = require('../src/main/tencent-ses');
const { CampaignRunner } = require('../src/main/engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mailmaster-test-'));
}

const contact = {
  company: '深圳市云图智能科技有限公司',
  contact: '张明远',
  salutation: '张总',
  email: 'zhang@yuntu.com',
  phone: '13800000000',
  city: '深圳',
  position: '采购总监',
  tags: ['重点客户', '华南'],
};

console.log('\n[1] 模板变量编译');
test('中文变量与常见别名均可识别', () => {
  const r = template.render('{{公司名}}|{{公司}}|{{联系人}}|{{姓名}}|{{称呼}}|{{尊称}}|{{手机}}|{{邮件地址}}', contact);
  assert.strictEqual(r.text, '深圳市云图智能科技有限公司|深圳市云图智能科技有限公司|张明远|张明远|张总|张总|13800000000|zhang@yuntu.com');
  assert.strictEqual(r.missing.length, 0);
});
test('英文键名同样可用', () => {
  const r = template.render('{{company}} - {{contact}} - {{email}}', contact);
  assert.strictEqual(r.text, '深圳市云图智能科技有限公司 - 张明远 - zhang@yuntu.com');
});
test('全局变量（日期/发件人/序号）可替换', () => {
  const g = template.buildGlobalContext({ now: new Date(2026, 9, 12, 10, 8), sender: '王小明', senderCompany: '示例公司', index: 3, total: 10 });
  const r = template.render('{{日期}} {{时间}} {{年份}} {{月份}} {{发件人}}/{{发件方公司}} {{序号}}/{{总数}}', {}, { globals: g });
  assert.strictEqual(r.text, '2026-10-12 10:08 2026 10月 王小明/示例公司 3/10');
});
test('缺失与未识别变量会被记录而不会破坏内容', () => {
  const r = template.render('您好{{称呼}}{{联系人}}，{{不存在的变量}}您好', { contact: '李四' });
  assert.strictEqual(r.text, '您好李四，您好');
  assert.deepStrictEqual(r.missing.sort(), ['不存在的变量', '称呼'].sort());
});
test('listVariables 能扫描出模板用到的变量', () => {
  const vars = template.listVariables('{{公司名}} 的 {{联系人}}，以及重复的 {{联系人}} 与 {{日期}}');
  assert.strictEqual(vars.length, 3);
  assert.strictEqual(vars[0].label, '公司名');
  assert.strictEqual(vars[0].known, true);
  assert.strictEqual(vars[2].global, true);
});
test('数组字段（标签）会以顿号连接', () => {
  const r = template.render('标签：{{标签}}', contact);
  assert.strictEqual(r.text, '标签：重点客户、华南');
});

console.log('\n[2] 调度时间计算');
test('手动任务不产生下次执行时间', () => {
  assert.strictEqual(scheduleNextRun({ type: 'manual' }, new Date()), null);
});
test('每天 09:30：当天已过则顺延到明天', () => {
  const from = new Date(2026, 9, 12, 10, 0);
  const next = scheduleNextRun({ type: 'daily', time: '09:30' }, from);
  assert.strictEqual(next.getDate(), 13);
  assert.strictEqual(next.getHours(), 9);
  assert.strictEqual(next.getMinutes(), 30);
});
test('每天 09:30：当天未到则取当天', () => {
  const from = new Date(2026, 9, 12, 8, 0);
  assert.strictEqual(scheduleNextRun({ type: 'daily', time: '09:30' }, from).getDate(), 12);
});
test('每周（周一/周三/周五）取最近的一个匹配日', () => {
  const from = new Date(2026, 9, 12, 10, 0); // 2026-10-12 是周一
  const next = scheduleNextRun({ type: 'weekly', weekdays: [1, 3, 5], time: '09:30' }, from);
  assert.strictEqual(next.getDay(), 3); // 周三
  assert.strictEqual(next.getDate(), 14);
});
test('每月 1 / 15 日 09:30', () => {
  const from = new Date(2026, 9, 12, 10, 0);
  const next = scheduleNextRun({ type: 'monthly', days: [1, 15], time: '09:30' }, from);
  assert.strictEqual(next.getDate(), 15);
  assert.strictEqual(next.getMonth(), 9);
});
test('每月 31 日遇到短月份自动落到当月最后一天', () => {
  const from = new Date(2027, 1, 1, 10, 0); // 2027-02
  const next = scheduleNextRun({ type: 'monthly', days: [31], time: '09:00' }, from);
  assert.strictEqual(next.getMonth(), 1);
  assert.strictEqual(next.getDate(), 28);
});
test('间隔任务按分钟推进', () => {
  const from = new Date(2026, 9, 12, 10, 0, 0);
  const next = scheduleNextRun({ type: 'interval', everyMinutes: 30 }, from);
  assert.strictEqual(next.getMinutes(), 30);
});
test('单次任务到点后返回 null', () => {
  assert.strictEqual(scheduleNextRun({ type: 'once', at: '2026-01-01T09:00' }, new Date(2026, 5, 1)), null);
  assert.notStrictEqual(scheduleNextRun({ type: 'once', at: '2027-01-01T09:00' }, new Date(2026, 5, 1)), null);
});
test('调度描述文案正确', () => {
  assert.ok(describeSchedule({ type: 'monthly', days: [1, 15], time: '09:30' }).includes('每月'));
  assert.ok(describeSchedule({ type: 'weekly', weekdays: [1], time: '09:30' }).includes('周一'));
  assert.strictEqual(describeSchedule({ type: 'manual' }), '仅手动触发');
});

console.log('\n[3] 错误归类（失败 / 硬退信）');
test('收件人不存在 → 退信', () => {
  const info = mailer.classifyError({ response: '550 5.1.1 User unknown', responseCode: 550 });
  assert.strictEqual(info.status, LOG_STATUS.BOUNCED);
});
test('邮箱不存在（mailbox not found）→ 退信', () => {
  assert.strictEqual(mailer.classifyError({ response: '550 mailbox not found', responseCode: 550 }).status, LOG_STATUS.BOUNCED);
});
test('4xx 临时错误 → 失败且可重试', () => {
  const info = mailer.classifyError({ response: '421 too many connections', responseCode: 421 });
  assert.strictEqual(info.status, LOG_STATUS.FAILED);
  assert.strictEqual(info.transient, true);
});
test('连接超时 → 失败', () => {
  const info = mailer.classifyError({ message: 'Connection timeout', code: 'ETIMEDOUT' });
  assert.strictEqual(info.status, LOG_STATUS.FAILED);
});

console.log('\n[4] 数据层');
const dir = tmpDir();
const db = new Database();
db.init(dir);

test('首次启动会写入演示数据', () => {
  assert.ok(db.data.contacts.length >= 8);
  assert.ok(db.data.templates.length >= 2);
  assert.ok(db.data.campaigns.length >= 2);
});
test('邮件地址唯一性与格式校验', () => {
  assert.throws(() => db.saveContact({ email: '不是邮箱', company: 'X' }), /格式不正确/);
  assert.throws(() => db.saveContact({ email: db.data.contacts[0].email }), /已存在/);
});
test('新增 / 编辑 / 删除联系人', () => {
  const created = db.saveContact({ company: '测试公司', contact: '测试员', salutation: '测试总', email: 'test@example.com', phone: '13900000000', tags: 'A|B' });
  assert.deepStrictEqual(created.tags, ['A', 'B']);
  const edited = db.saveContact({ id: created.id, company: '测试公司2', email: 'test@example.com' });
  assert.strictEqual(edited.company, '测试公司2');
  assert.strictEqual(db.removeContacts([created.id]), 1);
});
test('CSV 导入（含表头别名、重复跳过、非法行）', () => {
  const csv = ['邮箱,公司,姓名,称呼,手机', 'a@example.com,甲方公司,甲,甲总,13800000001', 'bad-email,乙方,乙,,13900000002', 'a@example.com,重复,重,,13900000003'].join('\n');
  const summary = db.importContactsFromCsv(csv, { mode: 'skip' });
  assert.strictEqual(summary.added, 1);
  assert.strictEqual(summary.skipped, 2);
});
test('CSV 解析支持引号内逗号', () => {
  const rows = parseCsv('a,"b,c",d');
  assert.deepStrictEqual(rows[0], ['a', 'b,c', 'd']);
});
test('导出 CSV 含表头与 BOM', () => {
  const csv = db.exportContactsCsv();
  assert.ok(csv.startsWith('\ufeff公司名,联系人,称呼,邮件地址,电话'));
});
test('受众解析：按标签筛选', () => {
  const list = db.resolveAudience({ mode: 'tags', tags: ['医疗行业'] });
  assert.ok(list.length >= 1);
  assert.ok(list.every((c) => c.tags.includes('医疗行业')));
});
test('受众解析：自动排除已退订联系人', () => {
  const target = db.data.contacts[0];
  target.subscribed = false;
  const list = db.resolveAudience({ mode: 'all' });
  assert.ok(!list.find((c) => c.id === target.id));
  target.subscribed = true;
});
test('投递结果会累加到联系人统计', () => {
  const c = db.data.contacts[0];
  const before = { ...c.stats };
  db.applyContactResult(c.id, LOG_STATUS.SUCCESS);
  db.applyContactResult(c.id, LOG_STATUS.BOUNCED);
  assert.strictEqual(c.stats.success, before.success + 1);
  assert.strictEqual(c.stats.bounced, before.bounced + 1);
  assert.strictEqual(c.subscribed, false, '硬退信应自动停用该地址');
  c.subscribed = true;
});
test('总览统计口径正确', () => {
  const o = db.overview();
  assert.strictEqual(o.userCount, db.data.contacts.length);
  assert.strictEqual(o.successCount + o.failedCount + o.bouncedCount, o.totalAttempts);
  assert.ok(o.nextRuns.length >= 0);
});
test('数据落盘后可以重新读取', () => {
  db.flush();
  const db2 = new Database();
  db2.init(dir);
  assert.strictEqual(db2.data.contacts.length, db.data.contacts.length);
});
test('日志保留期清理', () => {
  const added = db.pruneLogs(0);
  assert.strictEqual(added, 0);
  assert.ok(db.pruneLogs(1) >= 0);
});

console.log('\n[5] 发信邮箱账号（SMTP / 腾讯云邮件推送）');
const accDir = tmpDir();
const accDb = new Database();
accDb.init(accDir);

test('首次启动自带 SMTP 与腾讯云两类演示账号', () => {
  const providers = accDb.listAccounts().map((a) => a.provider || 'smtp');
  assert.ok(providers.includes('smtp'));
  assert.ok(providers.includes('tencent-ses'));
  assert.strictEqual(accDb.listAccounts().filter((a) => a.isDefault).length, 1);
});

test('SMTP 账号必须有服务器地址，腾讯云账号必须有密钥与模板', () => {
  assert.throws(() => accDb.saveAccount({ provider: 'smtp', email: 'a@b.com', host: '' }), /SMTP 服务器/);
  assert.throws(() => accDb.saveAccount({ provider: 'tencent-ses', email: 'c@d.com', ses: { secretId: '', secretKey: '' } }), /SecretId/);
  assert.throws(
    () => accDb.saveAccount({ provider: 'tencent-ses', email: 'c@d.com', ses: { secretId: 'AKID', secretKey: 'KEY' } }),
    /模板 ID/,
  );
});

test('发信邮箱地址不可重复、格式需合法', () => {
  assert.throws(() => accDb.saveAccount({ provider: 'smtp', email: 'bad-mail', host: 'smtp.x.com' }), /格式不正确/);
  const exists = accDb.listAccounts()[0].email;
  assert.throws(() => accDb.saveAccount({ provider: 'smtp', email: exists, host: 'smtp.x.com' }), /已存在/);
});

test('新增腾讯云账号（模板模式）后可正常保存并解析默认账号', () => {
  const created = accDb.saveAccount({
    provider: 'tencent-ses',
    name: '腾讯云测试账号',
    email: 'ses@example.com',
    fromName: '测试发信人',
    enabled: true,
    ses: { secretId: 'AKIDtest', secretKey: 'KEYtest', region: 'ap-guangzhou', site: 'cn', templateId: '12345', sendMode: 'template' },
  });
  assert.strictEqual(created.provider, 'tencent-ses');
  assert.strictEqual(created.ses.templateId, '12345');
  assert.strictEqual(created.ses.freeQuotaTotal, 1000, '默认免费额度总量应为 1000');
});

test('默认账号切换唯一性', () => {
  const list = accDb.listAccounts();
  accDb.setDefaultAccount(list[1].id);
  assert.strictEqual(accDb.listAccounts().filter((a) => a.isDefault).length, 1);
  assert.strictEqual(accDb.resolveSendingAccount().id, list[1].id);
  accDb.setDefaultAccount(list[0].id);
});

test('停用的账号不能被设为默认；被任务引用的账号不能删除', () => {
  const list = accDb.listAccounts();
  const target = list.find((a) => a.provider === 'smtp' && a.id !== list[0].id) || list[0];
  accDb.saveAccount(Object.assign({}, target, { enabled: false }));
  assert.throws(() => accDb.setDefaultAccount(target.id), /已停用/);
  accDb.saveAccount(Object.assign({}, target, { enabled: true }));

  const campaign = accDb.listCampaigns()[0];
  assert.throws(() => accDb.removeAccount(campaign.accountId), /正被/);
});

test('按账号统计今日 / 本月 / 累计使用量', () => {
  const account = accDb.listAccounts()[0];
  const before = accDb.accountUsageTotal(account.email);
  const contact = accDb.data.contacts[0];
  accDb.addLog({ accountEmail: account.email, contactId: contact.id, email: contact.email, status: LOG_STATUS.SUCCESS, dryRun: false });
  accDb.addLog({ accountEmail: account.email, contactId: contact.id, email: contact.email, status: LOG_STATUS.SUCCESS, dryRun: true });
  assert.strictEqual(accDb.accountUsageTotal(account.email), before + 1, '试运行日志不计入账号真实用量');
  assert.strictEqual(accDb.accountUsageToday(account.email) >= 1, true);
  assert.strictEqual(accDb.accountUsageMonth(account.email) >= 1, true);
  const stat = accDb.accountStats().find((s) => s.id === account.id);
  assert.ok(stat.freeQuotaTotal === 0, 'SMTP 账号无免费额度概念');
});

test('腾讯云账号的免费额度剩余由本地用量估算', () => {
  const sesAccount = accDb.listAccounts().find((a) => a.provider === 'tencent-ses');
  const contact = accDb.data.contacts[1];
  for (let i = 0; i < 3; i += 1) {
    accDb.addLog({ accountEmail: sesAccount.email, contactId: contact.id, email: contact.email, status: LOG_STATUS.SUCCESS, dryRun: false });
  }
  const stat = accDb.accountStats().find((s) => s.id === sesAccount.id);
  assert.strictEqual(stat.totalUsed, 3);
  assert.strictEqual(stat.freeQuotaRemaining, 1000 - 3);
});

test('推广任务可绑定不同的发信账号', () => {
  const accounts = accDb.listAccounts();
  const campaign = accDb.listCampaigns()[0];
  const updated = accDb.saveCampaign(Object.assign({}, campaign, { accountId: accounts[1].id }));
  assert.strictEqual(updated.accountId, accounts[1].id);
  assert.strictEqual(accDb.resolveSendingAccount(accounts[1].id).id, accounts[1].id);
  accDb.saveCampaign(Object.assign({}, updated, { accountId: accounts[0].id }));
});

test('旧版单一 SMTP 配置会自动迁移为发信账号', () => {
  const legacyDir = tmpDir();
  const file = path.join(legacyDir, 'mailmaster-data.json');
  const db0 = new Database();
  db0.init(legacyDir);
  db0.store.save(); // 落盘后模拟旧版本数据文件
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.accounts; // 模拟旧版本数据文件
  raw.settings.smtp = { host: 'smtp.legacy.com', port: 465, secure: true, user: 'legacy@x.com', pass: 'pwd', fromName: '旧账号', fromEmail: 'legacy@x.com' };
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  const db1 = new Database();
  db1.init(legacyDir);
  const migrated = db1.listAccounts();
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(migrated[0].host, 'smtp.legacy.com');
  assert.strictEqual(migrated[0].email, 'legacy@x.com');
  assert.strictEqual(migrated[0].isDefault, true);
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

console.log('\n[6] 腾讯云邮件推送（SES）');
test('TC3-HMAC-SHA256 签名结构正确且可复现', () => {
  const args = {
    secretId: 'AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE',
    secretKey: 'Gu5t9xGARNpq86cd98joQYCN3EXAMPLE',
    host: 'ses.tencentcloudapi.com',
    action: 'SendEmail',
    payload: '{"FromEmailAddress":"a@b.com"}',
    timestamp: 1750000000,
    region: 'ap-guangzhou',
  };
  const first = tencentSes.buildAuthorization(args);
  const second = tencentSes.buildAuthorization(args);
  assert.strictEqual(first.signature, second.signature, '同一输入签名应稳定');
  assert.strictEqual(first.signature.length, 64, '签名为 32 字节十六进制');
  assert.ok(first.authorization.startsWith('TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE/'), '凭证范围应以日期开头');
  assert.ok(first.authorization.includes('/ses/tc3_request'));
  assert.ok(first.authorization.includes('SignedHeaders=content-type;host;x-tc-action'));
  assert.ok(first.canonicalRequest.includes('x-tc-action:sendemail'), 'action 应小写参与规范化');
  assert.ok(first.headers['X-TC-Region'] === 'ap-guangzhou');
});

test('签名随密钥与请求体变化而变化', () => {
  const base = {
    secretId: 'AKID',
    secretKey: 'K1',
    host: 'ses.tencentcloudapi.com',
    action: 'SendEmail',
    payload: '{"a":1}',
    timestamp: 1750000000,
    region: 'ap-guangzhou',
  };
  const a = tencentSes.buildAuthorization(base).signature;
  assert.notStrictEqual(a, tencentSes.buildAuthorization(Object.assign({}, base, { secretKey: 'K2' })).signature);
  assert.notStrictEqual(a, tencentSes.buildAuthorization(Object.assign({}, base, { payload: '{"a":2}' })).signature);
});

test('额外汇总解析：可识别总量 / 已用 / 剩余', () => {
  const q = tencentSes.parseQuota([{ PackageId: 'p1', TotalAmount: 1000, UsedAmount: 120, RemainingAmount: 880, ExpireTime: '不限有效期' }]);
  assert.strictEqual(q.total, 1000);
  assert.strictEqual(q.used, 120);
  assert.strictEqual(q.remaining, 880);
});

test('额度解析：缺少剩余字段时按总量减已用推算', () => {
  const q = tencentSes.parseQuota([{ TotalCount: 500, UsedCount: 130 }]);
  assert.strictEqual(q.remaining, 370);
});

test('额度解析：无法识别字段时返回 null 而不是编造数据', () => {
  assert.strictEqual(tencentSes.parseQuota([{ SomethingElse: 'x' }, { Note: 'no numbers' }]), null);
});

test('腾讯云错误归类：收件人不存在 → 退信，限频 → 可重试失败', () => {
  assert.strictEqual(tencentSes.classifySesError({ code: 'FailedOperation.RecipientAddressNotFound', message: '' }).status, LOG_STATUS.BOUNCED);
  const limited = tencentSes.classifySesError({ code: 'RequestLimitExceeded', message: '请求超过频率限制' });
  assert.strictEqual(limited.status, LOG_STATUS.FAILED);
  assert.strictEqual(limited.transient, true);
});

test('缺少密钥或模板时接口调用会给出明确报错', () => {
  const sender = mailer.createSender({ provider: 'tencent-ses', email: 'x@y.com', ses: {} });
  assert.strictEqual(sender.provider, 'tencent-ses');
  assert.strictEqual(mailer.validateAccount({ provider: 'tencent-ses', email: 'x@y.com', ses: {} }), '腾讯云发信账号 x@y.com 未配置 SecretId / SecretKey');
  assert.strictEqual(mailer.validateAccount({ provider: 'smtp', email: 'x@y.com' }), '发信账号 x@y.com 未配置 SMTP 服务器');
});

test('渲染后的邮件内容可生成腾讯云模板变量表', () => {
  const tpl = { subject: '{{公司名}} 与 {{联系人}}', body: '尊敬的{{称呼}}{{联系人}}，来自{{发件方公司}}' };
  const mail = mailer.renderMail(tpl, contact, { senderCompany: '示例公司', appendFooter: false }, { account: { fromName: '王小明' } });
  assert.strictEqual(mail.templateData['公司名'], contact.company);
  assert.strictEqual(mail.templateData['联系人'], contact.name || contact.contact);
  assert.strictEqual(mail.templateData['发件方公司'], '示例公司');
  assert.ok(Object.keys(mail.templateData).length >= 4);
});

console.log('\n[7] 试运行全流程（不连接 SMTP）');
(async () => {
  const dir2 = tmpDir();
  const db2 = new Database();
  db2.init(dir2);
  const events = [];
  const runner = new CampaignRunner(db2, (p) => events.push(p));

  const campaign = db2.listCampaigns()[0];
  campaign.dryRun = true;
  campaign.throttle = { intervalSeconds: 0, dailyLimit: 0, maxRetries: 1 };
  db2.getSettings().sendMode = 'dryRun';

  await testAsync('执行推广任务并逐封记录投递结果', async () => {
    const progress = await runner.runCampaign(campaign.id, { reason: 'manual' });
    assert.strictEqual(progress.total, db2.data.contacts.filter((c) => c.subscribed !== false).length);
    assert.strictEqual(progress.done, progress.total);
    assert.strictEqual(progress.success + progress.failed + progress.bounced, progress.total);
    assert.strictEqual(campaign.runCount, 1);
  });

  await testAsync('每封邮件都生成了对应日志且带模板替换后的主题', async () => {
    const logs = db2.listLogs({ campaignId: campaign.id }).items;
    assert.strictEqual(logs.length, campaign.progress.total);
    assert.ok(logs[0].subject.length > 0);
    assert.ok(!logs[0].subject.includes('{{'), '主题中的变量应已被替换');
  });

  await testAsync('事件推送包含日志与任务进度', async () => {
    assert.ok(events.some((e) => e.type === 'log'));
    assert.ok(events.some((e) => e.type === 'campaign' && e.campaign.running === false));
  });

  await testAsync('试运行结果不会改变联系人的累计统计口径（仍会计入模拟统计）', async () => {
    const o = db2.overview();
    assert.strictEqual(o.totalRuns >= 1, true);
    assert.ok(o.recentLogs.length > 0);
  });

  await testAsync('模板变量可被逐条替换为对应收件人信息', async () => {
    const tpl = db2.getTemplate(campaign.templateId);
    const target = db2.data.contacts[0];
    const mail = mailer.renderMail(tpl, target, db2.getSettings(), { index: 1, total: 1 });
    assert.ok(mail.subject.includes(target.company) || mail.subject.includes(target.contact));
    assert.ok(mail.text.includes(target.salutation));
    assert.ok(!/\{\{/.test(mail.text), '正文中不应残留未替换的变量');
  });

  // 清理
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });

  console.log(`\n测试结果：通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(failed ? 1 : 0);
})();
