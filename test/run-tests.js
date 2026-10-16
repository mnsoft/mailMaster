'use strict';

/**
 * 逻辑自测（无需 Electron / SMTP）：
 *   node test/run-tests.js
 * 覆盖：模板变量编译与 Spintax、调度时间计算、发送节奏、多账号轮询、数据层 CRUD 与统计、
 *      CSV 导入、错误归类、试运行全流程、MIME/DSN 退信解析、IMAP 协议与退信监听闭环。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const vm = require('vm');

const { Database, LOG_STATUS, parseCsv } = require('../src/main/db');
const template = require('../src/main/template');
const spintax = require('../src/main/spintax');
const pacing = require('../src/main/pacing');
const { AccountPool, resolvePoolAccounts } = require('../src/main/account-pool');
const mime = require('../src/main/mime');
const { ImapClient } = require('../src/main/imap');
const { BounceWatcher } = require('../src/main/bounce-watcher');
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
  // 硬退信改为打「退信标记」（可手动解除），不再直接把联系人置为退订
  assert.strictEqual(c.bounceMarked, true, '硬退信应打上退信标记');
  assert.ok(c.bounceInfo && c.bounceInfo.at, '退信标记应带时间与原因');
  assert.strictEqual(db.resolveAudience({ mode: 'all' }).some((x) => x.id === c.id), false, '退信标记的地址不应再进入发送列表');
  db.releaseContactBounce(c.id);
  assert.strictEqual(c.bounceMarked, false, '解除标记后应恢复可发送');
  assert.strictEqual(db.resolveAudience({ mode: 'all' }).some((x) => x.id === c.id), true);
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
    const audience = db2.resolveAudience(campaign.audience);
    assert.strictEqual(progress.total, audience.length);
    assert.ok(
      progress.total < db2.data.contacts.filter((c) => c.subscribed !== false).length,
      '打了退信标记的地址应被排除在发送列表之外',
    );
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

  await runSpintaxTests();
  runPacingTests();
  runPoolTests();
  runMimeTests();
  await runBounceTests();
  await runPreviewMockTests();

  console.log(`\n测试结果：通过 ${passed} 项，失败 ${failed} 项\n`);
  process.exit(failed ? 1 : 0);
})();

// ---------------------------------------------------------------------------
// [8] Spintax 同义词轮换
// ---------------------------------------------------------------------------
async function runSpintaxTests() {
  console.log('\n[8] Spintax 同义词轮换');

  test('只有含顶层 | 的大括号组才被当作 Spintax', () => {
    assert.strictEqual(spintax.expand('正常写 {} 或 {单个}').text, '正常写 {} 或 {单个}');
    assert.strictEqual(spintax.countVariants('正常写 {} 或 {单个}'), 1);
  });

  test('选项组组合数按乘积计算（含嵌套）', () => {
    assert.strictEqual(spintax.countVariants('{A|B}'), 2);
    assert.strictEqual(spintax.countVariants('{A|B}{C|D|E}'), 6);
    assert.strictEqual(spintax.countVariants('{A|{B1|B2}}'), 3);
  });

  test('反斜杠可输出字面大括号', () => {
    assert.strictEqual(spintax.expand('\\{a|b\\}').text, '{a|b}');
  });

  test('展开结果始终落在选项集合内', () => {
    const out = new Set();
    for (let i = 0; i < 60; i += 1) out.add(spintax.expand('{您好|你好|打扰了}').text);
    assert.deepStrictEqual([...out].sort(), ['你好', '打扰了', '您好'].sort());
  });

  test('展开器优先选用本批次没用过的组合', () => {
    const used = new Set();
    const seen = new Set();
    for (let i = 0; i < 6; i += 1) {
      seen.add(spintax.expand('{A|B|C}{D|E}', { used }).text);
    }
    assert.strictEqual(seen.size, 6, '6 次展开在 6 种组合下应互不相同');
  });

  test('与 {{变量}} 语法不冲突', () => {
    const r = template.render('{您好|你好}{{联系人}}，{{公司名}}在{{城市}}。', {
      company: '云图',
      contact: '张明远',
      city: '深圳',
    });
    assert.ok(/^(您好|你好)张明远，云图在深圳。$/.test(r.text), `实际输出：${r.text}`);
  });

  test('变量本身带花括号也不会被 Spintax 吞掉', () => {
    const r = template.render('{{{公司名}}|客户}', { company: '云图' });
    assert.ok(['云图', '客户'].includes(r.text), `实际输出：${r.text}`);
  });

  test('同一批次内主题与正文字面各不相同', () => {
    const tpl = { subject: '{{公司名}} · {关于|聊聊}{沟通|交流}', body: '{您好|你好|打扰了}，{方案|资料}已更新。' };
    const used = new Set();
    const pairs = new Set();
    for (let i = 0; i < 12; i += 1) {
      const r = template.renderMessage(tpl, { company: '云图' }, template.buildGlobalContext({ index: i + 1 }), {
        spintax: { used },
      });
      pairs.add(`${r.subject}|${r.body}`);
    }
    assert.strictEqual(pairs.size, 12, '12 封邮件应覆盖全部 4×3 种组合且互不重复');
    assert.strictEqual(used.size, 12);
  });

  test('组合用尽后开启新一轮，不会死循环也不会报错', () => {
    const used = new Set();
    for (let i = 0; i < 5; i += 1) {
      const r = spintax.expand('{A|B}', { used });
      assert.ok(['A', 'B'].includes(r.text));
    }
    assert.ok(used.size <= 2, '两轮之后应重新计数');
  });

  test('describeSpintax 报告变体总数', () => {
    const info = template.describeSpintax({ subject: '{a|b}', body: '{c|d|e}' });
    assert.strictEqual(info.hasSpintax, true);
    assert.strictEqual(info.subjectVariants, 2);
    assert.strictEqual(info.bodyVariants, 3);
    assert.strictEqual(info.totalVariants, 6);
  });
}

// ---------------------------------------------------------------------------
// [9] 发送节奏：随机延迟与速率
// ---------------------------------------------------------------------------
function runPacingTests() {
  console.log('\n[9] 发送节奏（随机延迟 / 速率控制）');

  test('旧配置（只有 intervalSeconds）按固定间隔处理', () => {
    const cfg = pacing.normalize({ intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 });
    assert.strictEqual(cfg.mode, 'fixed');
    assert.strictEqual(cfg.intervalSeconds, 6);
    assert.strictEqual(pacing.nextDelay(cfg, { sentCount: 1 }).ms, 6000);
  });

  test('随机延迟始终落在配置区间内', () => {
    const cfg = pacing.normalize({ mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90 });
    for (let i = 0; i < 300; i += 1) {
      const { ms, kind } = pacing.nextDelay(cfg, { sentCount: 1 });
      assert.strictEqual(kind, 'random');
      assert.ok(ms >= 20000 && ms <= 90000, `延迟越界：${ms}`);
    }
  });

  test('每 N 封后插入一次长停顿', () => {
    const cfg = pacing.normalize({
      mode: 'random',
      delayMinSeconds: 20,
      delayMaxSeconds: 90,
      burstEvery: 5,
      burstMinSeconds: 180,
      burstMaxSeconds: 420,
    });
    assert.strictEqual(pacing.nextDelay(cfg, { sentCount: 5 }).kind, 'burst');
    assert.strictEqual(pacing.nextDelay(cfg, { sentCount: 10 }).kind, 'burst');
    assert.strictEqual(pacing.nextDelay(cfg, { sentCount: 3 }).kind, 'random');
    const burst = pacing.nextDelay(cfg, { sentCount: 5 }).ms;
    assert.ok(burst >= 180000 && burst <= 420000);
  });

  test('区间填反时自动纠正，避免死等或负数', () => {
    const cfg = pacing.normalize({ mode: 'random', delayMinSeconds: 90, delayMaxSeconds: 20 });
    assert.strictEqual(cfg.delayMinSeconds, 90);
    assert.strictEqual(cfg.delayMaxSeconds, 90);
  });

  test('每小时上限：窗口内未满不等待，满了等到最早一封滑出', () => {
    const now = Date.now();
    const stamps = [now - 10 * 60 * 1000, now - 5 * 60 * 1000];
    assert.strictEqual(pacing.waitForHourlySlot(stamps, 5, now), 0);
    const wait = pacing.waitForHourlySlot(stamps, 2, now);
    assert.ok(wait > 0 && wait <= 3600 * 1000, `等待时长异常：${wait}`);
  });

  test('整批耗时估算随总数增长并给出人话描述', () => {
    const cfg = pacing.normalize({ mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10 });
    const small = pacing.estimateMs(cfg, 5);
    const large = pacing.estimateMs(cfg, 100);
    assert.ok(large > small);
    assert.ok(pacing.humanizeMs(large).startsWith('约'));
    assert.ok(pacing.describe(cfg).includes('随机延迟'));
  });

  test('预设节奏齐全且都能被归一化', () => {
    assert.ok(pacing.PRESETS.length >= 3);
    for (const preset of pacing.PRESETS) {
      const cfg = pacing.normalize(preset.config);
      assert.ok(cfg.mode === 'random' || cfg.mode === 'fixed');
      assert.ok(cfg.delayMaxSeconds >= cfg.delayMinSeconds);
    }
  });
}

// ---------------------------------------------------------------------------
// [10] 多账号轮询
// ---------------------------------------------------------------------------
function runPoolTests() {
  console.log('\n[10] 多账号轮询发送');

  const accounts = [
    { id: 'a1', email: 'a1@example.com', enabled: true, dailyLimit: 2 },
    { id: 'a2', email: 'a2@example.com', enabled: true, dailyLimit: 100 },
    { id: 'a3', email: 'a3@example.com', enabled: false, dailyLimit: 100 },
  ];

  test('轮询按顺序依次使用各个账号', () => {
    const pool = new AccountPool(accounts, { strategy: 'roundRobin' });
    const picked = [];
    for (let i = 0; i < 6; i += 1) {
      const { account } = pool.next((a) => (a.enabled === false ? '停用' : null));
      picked.push(account.email);
      pool.markUsed(account.id);
    }
    assert.deepStrictEqual(picked, ['a1@example.com', 'a2@example.com', 'a1@example.com', 'a2@example.com', 'a1@example.com', 'a2@example.com']);
  });

  test('达到日限额的账号会被自动跳过', () => {
    const pool = new AccountPool(accounts, { strategy: 'roundRobin' });
    // a1 日限额 2 封，先发 1 封，第 2 封用尽后应自动切到 a2
    const usage = { 'a1@example.com': 1, 'a2@example.com': 0 };
    const picked = [];
    for (let i = 0; i < 4; i += 1) {
      const { account } = pool.next((a) => {
        if (a.enabled === false) return '停用';
        if (usage[a.email] >= a.dailyLimit) return '今日已达上限';
        return null;
      });
      picked.push(account.email);
      usage[account.email] += 1;
    }
    assert.deepStrictEqual(picked, ['a1@example.com', 'a2@example.com', 'a2@example.com', 'a2@example.com']);
  });

  test('全部不可用时返回 null 并说明每个账号的原因', () => {
    const pool = new AccountPool(accounts, { strategy: 'roundRobin' });
    const res = pool.next((a) => (a.enabled === false ? '账号已停用' : '今日已达上限'));
    assert.strictEqual(res.account, null);
    assert.strictEqual(res.blocked.length, 3);
    assert.ok(res.blocked.every((b) => b.reason));
  });

  test('分布统计反映各账号实际发送量', () => {
    const pool = new AccountPool(accounts.slice(0, 2), { strategy: 'roundRobin' });
    pool.markUsed('a1');
    pool.markUsed('a1');
    pool.markUsed('a2');
    const dist = pool.distribution();
    assert.deepStrictEqual(dist.map((d) => d.sent), [2, 1]);
  });

  test('单账号模式沿用原有解析规则，池模式按勾选顺序', () => {
    const all = accounts;
    const single = resolvePoolAccounts({ accountId: 'a2', accountMode: 'single' }, all, (id) => all.find((a) => a.id === id));
    assert.deepStrictEqual(single.map((a) => a.id), ['a2']);
    const pool = resolvePoolAccounts({ accountMode: 'pool', accountIds: ['a2', 'a1'] }, all, () => all[0]);
    assert.deepStrictEqual(pool.map((a) => a.id), ['a2', 'a1']);
  });

  test('池模式只勾选一个账号时回落为单账号', () => {
    const db3 = new Database();
    const d = tmpDir();
    db3.init(d);
    const saved = db3.saveCampaign({ name: '回落用例', accountMode: 'pool', accountIds: [db3.listAccounts()[0].id] });
    assert.strictEqual(saved.accountMode, 'single');
    fs.rmSync(d, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// [11] MIME / DSN 退信解析
// ---------------------------------------------------------------------------
const SAMPLE_DSN = [
  'Return-Path: <MAILER-DAEMON@example.com>',
  'From: Mail Delivery System <MAILER-DAEMON@example.com>',
  'To: marketing@example.com',
  'Subject: =?utf-8?B?VW5kZWxpdmVyZWQgTWFpbCBSZXR1cm5lZCB0byBTZW5kZXI=?=',
  'Date: Tue, 13 Oct 2026 09:12:03 +0800',
  'Message-ID: <dsn-1@example.com>',
  'Content-Type: multipart/report; report-type=delivery-status;\r\n boundary="BND1"',
  '',
  '--BND1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'I am sorry to inform you that your message could not be delivered.',
  '=E6=8A=95=E9=80=92=E5=A4=B1=E8=B4=A5',
  '    550 5.1.1 <zhangmingyuan@yuntu-ai.com>: Recipient address rejected:',
  '    User unknown in local recipient table',
  '',
  '--BND1',
  'Content-Type: message/delivery-status',
  '',
  'Final-Recipient: rfc822; zhangmingyuan@yuntu-ai.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 Recipient address rejected: User unknown',
  'Original-Message-ID: <dryrun-9f2a1b@mailmaster.local>',
  '',
  '--BND1',
  'Content-Type: message/rfc822',
  '',
  'Message-ID: <dryrun-9f2a1b@mailmaster.local>',
  'To: zhangmingyuan@yuntu-ai.com',
  '',
  'body',
  '--BND1--',
  '',
].join('\r\n');

function runMimeTests() {
  console.log('\n[11] MIME / DSN 退信解析');

  const node = mime.parseMessage(Buffer.from(SAMPLE_DSN, 'utf8'));
  const bounce = mime.extractBounce(node);

  test('multipart/report 被递归拆成三个子部件', () => {
    assert.strictEqual(node.contentType.type, 'multipart/report');
    assert.strictEqual(node.contentType.params['report-type'], 'delivery-status');
    assert.deepStrictEqual(node.parts.map((p) => p.contentType.type), ['text/plain', 'message/delivery-status', 'message/rfc822']);
  });

  test('RFC 2047 编码字主题被正确解码', () => {
    assert.strictEqual(bounce.subject, 'Undelivered Mail Returned to Sender');
  });

  test('quoted-printable 中文正文被正确解码', () => {
    assert.ok(bounce.text.includes('投递失败'), '中文应已解码');
  });

  test('识别为硬退信并给出状态码与收件人', () => {
    assert.strictEqual(bounce.isBounce, true);
    assert.strictEqual(bounce.type, 'hard');
    assert.strictEqual(bounce.status, '5.1.1');
    assert.deepStrictEqual(bounce.recipients, ['zhangmingyuan@yuntu-ai.com']);
    assert.strictEqual(bounce.originalMessageId, 'dryrun-9f2a1b@mailmaster.local');
    assert.ok(bounce.diagnostic.includes('User unknown'));
  });

  test('4.x 状态码归为临时性退信（不标记）', () => {
    const soft = SAMPLE_DSN.replace('Status: 5.1.1', 'Status: 4.2.2').replace('Action: failed', 'Action: delayed');
    const info = mime.extractBounce(mime.parseMessage(Buffer.from(soft, 'utf8')));
    assert.strictEqual(info.type, 'soft');
  });

  test('普通邮件不会被误判为退信', () => {
    const normal = ['From: zhang@yuntu.com', 'Subject: 关于方案的沟通', 'Content-Type: text/plain', '', '您好，方案已发送。'].join('\r\n');
    const info = mime.extractBounce(mime.parseMessage(Buffer.from(normal, 'utf8')));
    assert.strictEqual(info.isBounce, false);
  });

  test('中文退信主题也会被识别', () => {
    const cn = ['From: postmaster@example.com', 'Subject: 退信通知：无法投递', 'Content-Type: text/plain', '', '您的邮件无法投递，收件人 x@y.com 不存在。'].join('\r\n');
    const info = mime.extractBounce(mime.parseMessage(Buffer.from(cn, 'utf8')));
    assert.strictEqual(info.isBounce, true);
    assert.ok(info.recipients.includes('x@y.com'));
  });
}

// ---------------------------------------------------------------------------
// [12] IMAP 协议 + 退信监听闭环（对着本地模拟 IMAP 服务器跑）
// ---------------------------------------------------------------------------
function startFakeImapServer() {
  const state = { commands: [], fetched: 0 };
  const server = net.createServer((socket) => {
    socket.write('* OK [CAPABILITY IMAP4rev1] fake ready\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        state.commands.push(line);
        const tag = line.split(' ')[0];
        if (/LOGIN/i.test(line)) socket.write(`${tag} OK LOGIN completed\r\n`);
        else if (/CAPABILITY/i.test(line)) socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        else if (/SELECT/i.test(line)) socket.write(`* 3 EXISTS\r\n${tag} OK [READ-WRITE] done\r\n`);
        else if (/UID SEARCH/i.test(line)) socket.write(`* SEARCH 101 102\r\n${tag} OK done\r\n`);
        else if (/UID FETCH/i.test(line)) {
          state.fetched += 1;
          const uid = (line.match(/UID FETCH (\d+)/) || [])[1];
          // 只有 101 是退信报告；102 是普通邮件，用于验证不会被误判
          const payload =
            uid === '101'
              ? SAMPLE_DSN
              : ['From: partner@yuntu-ai.com', 'Subject: 方案已收到，谢谢', 'Content-Type: text/plain; charset=utf-8', '', '已收到，稍后回复。'].join('\r\n');
          const body = Buffer.from(payload, 'utf8');
          socket.write(`* ${uid} FETCH (BODY[] {${body.length}}\r\n`);
          socket.write(body);
          socket.write(')\r\n');
          socket.write(`${tag} OK done\r\n`);
        } else if (/UID STORE/i.test(line)) socket.write(`* 101 FETCH (FLAGS (\\Seen))\r\n${tag} OK done\r\n`);
        else if (/LOGOUT/i.test(line)) {
          socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
          socket.end();
        } else socket.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

async function runBounceTests() {
  console.log('\n[12] IMAP 退信监听（本地模拟服务器）');

  const { server, state, port } = await startFakeImapServer();

  await testAsync('IMAP 客户端完成 连接 → 登录 → 选择邮箱 → 搜索 → 取信 → 标记已读', async () => {
    const client = new ImapClient({ host: '127.0.0.1', port, secure: false });
    await client.connect();
    await client.login();
    const box = await client.select('INBOX');
    const uids = await client.search(['UNSEEN', 'SINCE 12-Oct-2026']);
    const raw = await client.fetchRaw(uids[0]);
    const seen = await client.markSeen(uids[0]);
    await client.logout();
    assert.strictEqual(box.exists, 3);
    assert.deepStrictEqual(uids, [101, 102]);
    assert.strictEqual(raw.length, Buffer.byteLength(SAMPLE_DSN, 'utf8'), '字面量应按长度精确读取');
    assert.strictEqual(seen, true);
    assert.ok(state.commands.some((c) => /UID FETCH 101 \(BODY\.PEEK\[\]\)/.test(c)));
    assert.ok(state.commands.some((c) => /UID STORE 101 \+FLAGS/.test(c)));
  });

  await testAsync('退信监听到 DSN 后自动标记联系人并从发送列表剔除', async () => {
    const d = tmpDir();
    const db4 = new Database();
    db4.init(d);
    db4.getSettings().sendMode = 'dryRun';

    const account = db4.listAccounts()[0];
    account.imap = { enabled: true, host: '127.0.0.1', port, secure: false, user: 'u', pass: 'p', mailbox: 'INBOX', markSeen: true, searchDays: 30, allowInsecure: true };

    // 造一条投递成功的日志，其 messageId 与 DSN 里的 Original-Message-ID 对应
    const contact = db4.data.contacts[0];
    contact.email = 'zhangmingyuan@yuntu-ai.com';
    db4.addLog({
      campaignId: db4.listCampaigns()[0].id,
      campaignName: '退信用例',
      accountId: account.id,
      accountEmail: account.email,
      contactId: contact.id,
      company: contact.company,
      contact: contact.contact,
      email: contact.email,
      subject: '测试主题',
      status: LOG_STATUS.SUCCESS,
      messageId: 'dryrun-9f2a1b@mailmaster.local',
      dryRun: false,
    });

    const watcher = new BounceWatcher(db4, () => {});
    const summary = await watcher.checkNow({ reason: 'manual' });
    assert.strictEqual(summary.marked, 1, '应标记 1 个退信地址');
    assert.strictEqual(contact.bounceMarked, true);
    assert.strictEqual(contact.bounceInfo.type, 'hard');
    assert.ok(contact.bounceInfo.reason.includes('5.1.1'));
    assert.strictEqual(
      db4.resolveAudience({ mode: 'all' }).some((c) => c.id === contact.id),
      false,
      '退信地址不应再进入发送列表',
    );

    const events = db4.listBounceEvents({});
    assert.strictEqual(events.total, 1);
    assert.strictEqual(events.items[0].email, 'zhangmingyuan@yuntu-ai.com');
    assert.strictEqual(events.items[0].matched, true);
    assert.strictEqual(events.items[0].campaignName, '退信用例');

    // 重复检查不应重复处理（已记录过的 UID 会跳过）
    const again = await watcher.checkNow({ reason: 'manual' });
    assert.strictEqual(again.marked, 0);

    // 手动解除后重新回到发送列表
    watcher.release(contact.id);
    assert.strictEqual(contact.bounceMarked, false);
    assert.strictEqual(contact.bounceInfo, null);
    assert.strictEqual(db4.resolveAudience({ mode: 'all' }).some((c) => c.id === contact.id), true);
    assert.strictEqual(
      db4.data.contacts.filter((c) => c.bounceMarked).some((c) => c.id === contact.id),
      false,
      '该联系人不应再处于退信标记状态',
    );
    fs.rmSync(d, { recursive: true, force: true });
  });

  await testAsync('未启用 IMAP 的账号会被明确跳过并给出原因', async () => {
    const d = tmpDir();
    const db5 = new Database();
    db5.init(d);
    const watcher = new BounceWatcher(db5, () => {});
    for (const a of db5.listAccounts()) a.imap.enabled = false;
    const summary = await watcher.checkNow({ reason: 'manual' });
    assert.strictEqual(summary.accounts, 0);
    assert.ok(summary.message.includes('IMAP'));
    fs.rmSync(d, { recursive: true, force: true });
  });

  server.close();
}
// ---------------------------------------------------------------------------
// [13] 浏览器预览模拟层（dev-mock.js）
// ---------------------------------------------------------------------------
/**
 * 浏览器预览（npm run preview）不经过 Electron 主进程，而是由 dev-mock.js 在内存里
 * 实现同一套 window.api。渲染层新用到的接口一旦在模拟层缺失，预览页就会直接抛错，
 * 因此这里把 dev-mock 载入 Node，逐项校验界面真正依赖的数据契约。
 */
async function runPreviewMockTests() {
  console.log('\n[13] 浏览器预览模拟层（dev-mock）');

  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/renderer/js/dev-mock.js'), 'utf8'),
    sandbox,
    { filename: 'dev-mock.js' },
  );
  const api = sandbox.api;

  // 接口清单直接从 preload.js 解析，避免两边人工维护导致漂移
  const preloadSrc = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  const preloadKeys = Array.from(preloadSrc.matchAll(/^\s{2}([A-Za-z_]\w*):\s*\(.*\)\s*=>\s*invoke\(/gm)).map((m) => m[1]);
  preloadKeys.push('onEvent'); // 事件订阅不是 invoke 写法，单独补上

  test(`preload 暴露的 ${preloadKeys.length} 个接口在模拟层中全部存在`, () => {
    const missing = preloadKeys.filter((k) => typeof api[k] !== 'function');
    assert.deepStrictEqual(missing, [], `模拟层缺少：${missing.join(', ')}`);
  });

  // ---------------- 发送节奏 ----------------
  const meta = (await api.pacingMeta()).data;
  test('pacingMeta 返回节奏预设与账号池策略', () => {
    assert.strictEqual(meta.presets.length, 4);
    assert.strictEqual(meta.strategies.length, 2);
    meta.presets.forEach((p) => assert.ok(p.key && p.label && p.config, `预设字段不完整：${p.key}`));
  });

  await testAsync('paceEstimate 的说明文案与实际执行模块保持一致', async () => {
    const est = (await api.paceEstimate({ throttle: { mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10, hourlyLimit: 60 }, total: 120 })).data;
    assert.ok(est.ms > 0);
    // 同样的配置在主进程模块里应产生同样的描述
    assert.strictEqual(est.describe, pacing.describe({ mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10, hourlyLimit: 60 }));
    assert.strictEqual(est.text, pacing.humanizeMs(pacing.estimateMs({ mode: 'random', delayMinSeconds: 20, delayMaxSeconds: 90, burstEvery: 10, hourlyLimit: 60 }, 120)));
    const old = (await api.paceEstimate({ throttle: { intervalSeconds: 6 }, total: 10 })).data;
    assert.ok(old.describe.includes('固定间隔 6 秒/封'), old.describe);
  });

  // ---------------- Spintax ----------------
  const templates = (await api.listTemplates()).data;
  const tplSeed = templates[0];
  const spinInfo = (await api.spintaxInfo({ subject: tplSeed.subject, body: tplSeed.body })).data;
  test('种子模板的 Spintax 变体数与主进程算法一致', () => {
    assert.strictEqual(spinInfo.totalVariants, spintax.countVariants(tplSeed.subject) * spintax.countVariants(tplSeed.body));
    assert.strictEqual(spinInfo.subjectVariants, spintax.countVariants(tplSeed.subject));
    assert.strictEqual(spinInfo.bodyVariants, spintax.countVariants(tplSeed.body));
    assert.strictEqual(spinInfo.samples.length, 5);
  });

  await testAsync('previewTemplate 按组合序号取到不同措辞，且变量全部替换', async () => {
    const total = spinInfo.totalVariants;
    const probe = Math.min(total, 40);
    const seen = new Set();
    const subjects = new Set();
    for (let i = 0; i < probe; i += 1) {
      const idx = Math.floor((i * total) / probe); // 均匀铺开，避免落在同一个主题变体上
      const r = (await api.previewTemplate({ subject: tplSeed.subject, body: tplSeed.body, spinIndex: idx })).data;
      assert.strictEqual(r.rendered.spintax.totalVariants, total);
      assert.ok(!/\{\{/.test(r.rendered.subject), `主题残留变量：${r.rendered.subject}`);
      assert.ok(!/\{\{/.test(r.rendered.body), '正文残留变量');
      seen.add(`${r.rendered.subject}\u0000${r.rendered.body}`);
      subjects.add(r.rendered.subject);
    }
    assert.strictEqual(seen.size, probe, `${probe} 个组合序号应产生 ${probe} 种内容，实际 ${seen.size}`);
    assert.ok(subjects.size > 1, '主题也应随组合轮换');
  });

  await testAsync('纯变量模板不会被 Spintax 解析器破坏', async () => {
    const r = (await api.previewTemplate({ subject: '{{公司名}} 测试', body: '{{联系人}} 你好', spinIndex: 0 })).data;
    assert.ok(!/\{\{/.test(r.rendered.subject));
    assert.ok(r.rendered.subject.includes('测试'));
    const info = (await api.spintaxInfo({ subject: '{{公司名}} 测试', body: '{{联系人}} 你好' })).data;
    assert.strictEqual(info.hasSpintax, false);
    assert.strictEqual(info.totalVariants, 1);
  });

  // ---------------- 多账号轮询 ----------------
  const accIds = (await api.listAccounts()).data.map((a) => a.id);
  await testAsync('任务可保存账号池配置并回传 poolEmails / paceText', async () => {
    const before = (await api.listCampaigns()).data;
    assert.ok(before.every((c) => typeof c.paceText === 'string' && Array.isArray(c.poolEmails)));
    const saved = (await api.saveCampaign({
      name: '池模式自测',
      templateId: tplSeed.id,
      kind: 'manual',
      schedule: { type: 'manual' },
      audience: { mode: 'all' },
      throttle: { mode: 'random', delayMinSeconds: 30, delayMaxSeconds: 60 },
      accountMode: 'pool',
      accountIds: accIds,
      accountStrategy: 'roundRobin',
      dryRun: true,
    })).data;
    assert.strictEqual(saved.accountMode, 'pool');
    assert.strictEqual(saved.accountIds.length, accIds.length);
    const reloaded = (await api.listCampaigns()).data.find((c) => c.id === saved.id);
    assert.strictEqual(reloaded.poolEmails.length, accIds.length);
    assert.ok(reloaded.paceText.includes('随机延迟 30–60 秒/封'), reloaded.paceText);
    await api.removeCampaign(saved.id);
  });

  // ---------------- 退信标记与发送列表剔除 ----------------
  const marked = (await api.listContacts({ status: 'bounceMarked' })).data.items;
  test('种子数据里存在被标记退信的地址（用于演示剔除效果）', () => {
    assert.ok(marked.length >= 1);
    assert.ok(marked[0].bounceInfo && marked[0].bounceInfo.source);
  });

  await testAsync('被标记退信的地址会同时从「仅可发送」列表与受众中剔除', async () => {
    const activeBefore = (await api.listContacts({ status: 'active' })).data.items;
    assert.ok(!activeBefore.some((c) => c.bounceMarked));
    const audience = (await api.previewCampaignAudience({ mode: 'all' })).data.total;
    assert.strictEqual(audience, activeBefore.length);

    const target = marked[0];
    const released = (await api.releaseContactBounce({ id: target.id })).data;
    assert.strictEqual(released.bounceMarked, false);
    assert.strictEqual(released.bounceInfo, null);
    assert.strictEqual(released.subscribed, true);
    const activeAfter = (await api.listContacts({ status: 'active' })).data.items;
    assert.strictEqual(activeAfter.length, activeBefore.length + 1, '解除标记后应重新进入发送列表');

    // 复原，避免污染后续用例
    await api.markContactBounced({ id: target.id, note: '手动标记' });
    const reMarked = (await api.listContacts({ status: 'bounceMarked' })).data.items.find((c) => c.id === target.id);
    assert.ok(reMarked, '应能再次打上退信标记');
    assert.strictEqual(reMarked.bounceInfo.source, 'manual');
  });

  // ---------------- IMAP 退信监听 ----------------
  const bs = (await api.bounceState()).data;
  test('bounceState 结构完整（账号状态 + 三个计数）', () => {
    assert.ok(Array.isArray(bs.accounts) && bs.accounts.length > 0);
    assert.strictEqual(typeof bs.enabledAccountCount, 'number');
    assert.strictEqual(typeof bs.markedCount, 'number');
    assert.strictEqual(typeof bs.eventCount, 'number');
    assert.strictEqual(typeof bs.autoCheck, 'boolean');
    assert.strictEqual(typeof bs.pollMinutes, 'number');
    bs.accounts.forEach((a) => {
      ['host', 'mailbox', 'readiness', 'lastCheckAt', 'lastFound'].forEach((k) => assert.ok(k in a, `账号状态缺少字段 ${k}`));
    });
  });

  await testAsync('listBounces 支持类型 / 匹配情况 / 关键字筛选', async () => {
    const all = (await api.listBounces({})).data;
    assert.ok(all.total >= 1);
    assert.ok(all.items[0].email && all.items[0].type && 'matched' in all.items[0]);
    assert.strictEqual((await api.listBounces({ matched: 'matched' })).data.total, all.total);
    assert.strictEqual((await api.listBounces({ type: 'soft' })).data.total, 0);
    assert.strictEqual((await api.listBounces({ keyword: '绝不存在的关键字zzz' })).data.total, 0);
  });

  await testAsync('checkBounces / testImap 在预览模式下给出明确的模拟结果', async () => {
    const summary = (await api.checkBounces({ manual: true })).data;
    assert.ok(typeof summary.checkedAt === 'string');
    assert.strictEqual(typeof summary.scanned, 'number');
    assert.ok(Array.isArray(summary.errors));

    const ready = bs.accounts.find((a) => a.enabled && !a.readiness);
    assert.ok(ready, `应有一个配置完整的 IMAP 账号，实际：${bs.accounts.map((a) => a.readiness).join(' | ')}`);
    const okRes = (await api.testImap({ id: ready.id })).data;
    assert.strictEqual(okRes.ok, true);
    assert.ok(okRes.message.includes('IMAP'));
    assert.strictEqual(typeof okRes.durationMs, 'number');

    // 未保存的新账号（draft）也要能测试：密码留空时沿用发信密码
    const draft = (await api.testImap({ draft: { email: 'new@example.com', pass: 'code', user: '', imap: { enabled: true, host: 'imap.example.com', port: 993, mailbox: 'INBOX' } } })).data;
    assert.strictEqual(draft.ok, true, JSON.stringify(draft));
    const noPass = (await api.testImap({ draft: { email: 'new@example.com', pass: '', user: '', imap: { enabled: true, host: 'imap.example.com', port: 993 } } })).data;
    assert.strictEqual(noPass.ok, false);
    assert.ok(noPass.message.includes('密码'), noPass.message);
    const noHost = (await api.testImap({ draft: { imap: { enabled: true, host: '' } } })).data;
    assert.strictEqual(noHost.ok, false);
    assert.ok(noHost.message.includes('服务器'), noHost.message);
  });

  // ---------------- 总览 / 设置 / 账号 ----------------
  const ov = (await api.overview()).data;
  test('overview 提供退信相关指标（看板依赖）', () => {
    assert.ok(ov.bounceMarkedCount >= 1);
    assert.ok(ov.bounceEventCount >= 1);
    assert.strictEqual(typeof ov.lastImapCheckAt, 'string');
  });

  await testAsync('overview 的可发送人数与「仅可发送」列表一致（已排除退信地址）', async () => {
    const active = (await api.listContacts({ status: 'active' })).data.items.length;
    assert.strictEqual(ov.activeContactCount, active);
  });

  const settings = (await api.getSettings()).data;
  test('settings 含完整默认节奏与 IMAP 全局开关', () => {
    ['mode', 'intervalSeconds', 'delayMinSeconds', 'delayMaxSeconds', 'burstEvery', 'hourlyLimit', 'dailyLimit', 'maxRetries'].forEach((k) =>
      assert.ok(k in settings.defaultThrottle, `默认节奏缺少字段 ${k}`),
    );
    ['imapAutoCheck', 'imapPollMinutes', 'imapAutoMarkBounce', 'imapBounceType'].forEach((k) =>
      assert.ok(k in settings, `设置缺少字段 ${k}`),
    );
  });

  await testAsync('账号可保存 IMAP 配置（账号页表单依赖）', async () => {
    const accounts = (await api.listAccounts()).data;
    assert.ok(accounts.some((a) => a.imap && typeof a.imap === 'object'));
    const imap = { enabled: true, host: 'imap.exmail.qq.com', port: 993, secure: true, user: '', pass: '', mailbox: 'INBOX', searchDays: 30, markSeen: true, allowInsecure: false };
    const saved = (await api.saveAccount(Object.assign({}, accounts[0], { imap }))).data;
    assert.strictEqual(saved.imap.host, 'imap.exmail.qq.com');
    assert.strictEqual(saved.imap.enabled, true);
    assert.strictEqual(saved.imap.markSeen, true);
  });
}
