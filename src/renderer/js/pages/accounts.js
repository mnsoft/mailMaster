/* 页面：发信邮箱配置（SMTP / 腾讯云邮件推送） */
(function () {
  const MM = window.MM;

  /** 常用邮箱服务商快捷预设 */
  const SMTP_PRESETS = [
    { label: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, secure: true, hint: '密码填写邮箱登录密码或客户端专用密码' },
    { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true, hint: '需在 QQ 邮箱设置中开启 SMTP 并使用授权码' },
    { label: '网易企业邮', host: 'smtp.qiye.163.com', port: 465, secure: true, hint: '使用企业邮箱授权码' },
    { label: '163 邮箱', host: 'smtp.163.com', port: 465, secure: true, hint: '需开启 SMTP 并使用授权码' },
    { label: '阿里云企业邮', host: 'smtp.qiye.aliyun.com', port: 465, secure: true, hint: '使用邮箱密码' },
    { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true, hint: '需使用应用专用密码（App Password）' },
    { label: 'Outlook / Office365', host: 'smtp.office365.com', port: 587, secure: false, hint: 'STARTTLS，端口 587' },
  ];

  const SMTP_WARNING = `⚠ 使用普通邮箱（企业邮 / QQ / 163 / Gmail 等）的 SMTP 群发推广邮件存在账号风险：
短时间内大量群发、收件人举报或退信率偏高时，邮箱服务商可能对该账号限速、限制发信、临时冻结甚至封禁账号（个人邮箱风险更高，通常每日群发上限仅数十至数百封）。
建议：① 优先使用「腾讯云邮件推送」等专业发信通道；② 控制每封间隔（≥5 秒）与每日上限；③ 及时清理退信地址、附上退订说明。`;

  function providerBadge(a) {
    return a.provider === 'tencent-ses'
      ? '<span class="badge badge-info">腾讯云邮件推送</span>'
      : '<span class="badge badge-pending">普通邮箱 SMTP</span>';
  }

  function accountCard(a) {
    const usage = a.dailyLimit > 0 ? `${a.todayUsed || 0} / ${a.dailyLimit}` : `${a.todayUsed || 0} / 不限`;
    const pct = a.dailyLimit > 0 ? Math.min(100, Math.round(((a.todayUsed || 0) / a.dailyLimit) * 100)) : 0;
    const isSes = a.provider === 'tencent-ses';
    const freeTotal = a.freeQuotaTotal || 0;
    const freeLeft = a.freeQuotaRemaining;
    const freePct = freeTotal ? Math.min(100, Math.round(((freeLeft || 0) / freeTotal) * 100)) : 0;

    return `<div class="panel" data-id="${a.id}">
      <div class="panel-head">
        <div class="panel-title">
          ${MM.esc(a.name)}
          ${providerBadge(a)}
          ${a.isDefault ? '<span class="badge badge-info">默认发信账号</span>' : ''}
          ${a.enabled === false ? '<span class="badge badge-paused">已停用</span>' : '<span class="badge badge-success">已启用</span>'}
        </div>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="test">测试连接</button>
          ${isSes ? '<button class="btn btn-sm" data-act="quota">查询额度</button>' : ''}
          ${a.isDefault ? '' : `<button class="btn btn-sm" data-act="default" ${a.enabled === false ? 'disabled' : ''}>设为默认</button>`}
          <button class="btn btn-sm" data-act="toggle">${a.enabled === false ? '启用' : '停用'}</button>
          <button class="btn btn-sm" data-act="edit">编辑</button>
          <button class="btn btn-sm btn-danger" data-act="remove">删除</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="form-grid c3" style="gap:0 14px">
          <dl class="kv" style="grid-template-columns:96px 1fr">
            <dt>发信邮箱</dt><dd class="mono" style="font-size:12px">${MM.esc(a.email)}</dd>
            <dt>发信人姓名</dt><dd>${MM.esc(a.fromName || '—')}</dd>
            ${
              isSes
                ? `<dt>腾讯云地域</dt><dd>${MM.esc(a.ses?.site === 'intl' ? '国际站' : '中国站')} · ${MM.esc(a.ses?.region || 'ap-guangzhou')}</dd>
                   <dt>发信模板</dt><dd>${a.ses?.sendMode === 'html' ? 'HTML 直发（需控制台特殊配置）' : `模板 ID ${MM.esc(a.ses?.templateId || '未填写')}`}</dd>
                   <dt>密钥</dt><dd>${a.ses?.secretId && a.ses?.secretKey ? '••••••••（已配置）' : '<span style="color:var(--warn)">未配置 SecretId / SecretKey</span>'}</dd>`
                : `<dt>SMTP 服务器</dt><dd class="mono" style="font-size:12px">${MM.esc(a.host)}:${MM.esc(a.port)}</dd>
                   <dt>加密方式</dt><dd>${a.secure !== false ? 'SSL / TLS' : 'STARTTLS'}</dd>
                   <dt>密码/授权码</dt><dd>${a.pass ? '••••••••（已配置）' : '<span style="color:var(--warn)">未配置</span>'}</dd>`
            }
            <dt>备注</dt><dd>${MM.esc(a.remark || '—')}</dd>
          </dl>
          <div>
            <div class="stat-label" style="margin-bottom:6px">今日已发 ${MM.esc(usage)} 封</div>
            <div class="progress" style="margin-bottom:12px"><div class="progress-bar ${pct > 85 ? '' : 'ok'}" style="width:${pct}%"></div></div>
            ${
              isSes
                ? `<div class="stat-label" style="margin-bottom:6px">腾讯云免费额度剩余 ${freeLeft == null ? '—' : freeLeft} / ${freeTotal || '—'} 封</div>
                   <div class="progress" style="margin-bottom:10px"><div class="progress-bar ok" style="width:${freePct}%"></div></div>`
                : ''
            }
            <div style="display:flex;gap:14px;font-size:11.5px;color:var(--text-faint);flex-wrap:wrap">
              <span>累计投递 ${a.total || 0}</span>
              <span style="color:var(--success)">成功 ${a.success || 0}</span>
              <span style="color:var(--danger)">失败 ${a.failed || 0}</span>
              <span style="color:var(--warn)">退信 ${a.bounced || 0}</span>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--text-faint);line-height:1.9">
            本月已发 <b style="color:var(--text)">${a.monthUsed || 0}</b> 封 · 累计 <b style="color:var(--text)">${a.totalUsed || 0}</b> 封（仅统计真实发送）<br/>
            ${isSes ? '额度数据为本地统计结果，可在卡片上点「查询额度」从腾讯云读取实际套餐包剩余量。' : '普通邮箱 SMTP 无官方额度概念，建议按服务商规则控制日发送量。'}
          </div>
        </div>
      </div>
    </div>`;
  }

  function smtpFields(acc) {
    return `
      <div class="field">
        <label class="field-label">快速填充常用邮箱服务商</label>
        <div class="var-picker" data-role="presets">
          ${SMTP_PRESETS.map((p, i) => `<button class="var-chip" data-preset="${i}">${MM.esc(p.label)}</button>`).join('')}
        </div>
        <div class="field-hint" data-role="preset-hint">选择服务商会自动填入 SMTP 服务器与端口，密码栏请填写该邮箱的授权码。</div>
      </div>
      <div class="form-grid">
        <div class="field"><label class="field-label">SMTP 服务器<span class="req">*</span></label>
          <input class="input" data-role="host" value="${MM.attr(acc.host)}" placeholder="smtp.exmail.qq.com" /></div>
        <div class="field"><label class="field-label">端口</label>
          <input class="input" type="number" data-role="port" value="${MM.attr(acc.port || 465)}" /></div>
        <div class="field"><label class="field-label">加密方式</label>
          <select class="select" data-role="secure">
            <option value="true" ${acc.secure !== false ? 'selected' : ''}>SSL / TLS（推荐，常用 465）</option>
            <option value="false" ${acc.secure === false ? 'selected' : ''}>STARTTLS（常用 587 / 25）</option>
          </select></div>
        <div class="field"><label class="field-label">邮箱密码 / 授权码<span class="req">*</span></label>
          <input class="input" type="password" data-role="pass" value="${MM.attr(acc.pass)}" placeholder="邮箱授权码（多数邮箱不是登录密码）" /></div>
      </div>
      <div class="callout danger" style="margin-bottom:12px">${MM.esc(SMTP_WARNING)}</div>`;
  }

  function sesFields(acc) {
    const ses = acc.ses || {};
    return `
      <div class="form-grid">
        <div class="field"><label class="field-label">站点</label>
          <select class="select" data-role="ses-site">
            <option value="cn" ${ses.site !== 'intl' ? 'selected' : ''}>腾讯云中国站（ses.tencentcloudapi.com）</option>
            <option value="intl" ${ses.site === 'intl' ? 'selected' : ''}>腾讯云国际站（ses.intl.tencentcloudapi.com）</option>
          </select></div>
        <div class="field"><label class="field-label">地域 Region</label>
          <input class="input" data-role="ses-region" value="${MM.attr(ses.region || 'ap-guangzhou')}" placeholder="ap-guangzhou / ap-hongkong" />
          <div class="field-hint">中国站常用 ap-guangzhou、ap-hongkong；国际站仅支持 ap-singapore</div></div>
        <div class="field"><label class="field-label">SecretId<span class="req">*</span></label>
          <input class="input" data-role="ses-secretId" value="${MM.attr(ses.secretId)}" placeholder="AKIDxxxxxxxxxxxxxxxx" /></div>
        <div class="field"><label class="field-label">SecretKey<span class="req">*</span></label>
          <input class="input" type="password" data-role="ses-secretKey" value="${MM.attr(ses.secretKey)}" placeholder="访问密钥 Key（仅保存在本机）" /></div>
        <div class="field"><label class="field-label">发送方式</label>
          <select class="select" data-role="ses-sendMode">
            <option value="template" ${ses.sendMode !== 'html' ? 'selected' : ''}>模板发送（官方默认支持）</option>
            <option value="html" ${ses.sendMode === 'html' ? 'selected' : ''}>HTML / 文本直发（需控制台开通特殊配置）</option>
          </select></div>
        <div class="field"><label class="field-label">发信模板 ID <span class="field-hint">（模板发送时必填）</span></label>
          <input class="input" data-role="ses-templateId" value="${MM.attr(ses.templateId)}" placeholder="控制台「邮件推送 → 发信模板」中的模板 ID" /></div>
        <div class="field"><label class="field-label">回复地址 Reply-To</label>
          <input class="input" data-role="ses-replyTo" value="${MM.attr(ses.replyTo)}" placeholder="选填，收件人回复时使用的邮箱" /></div>
        <div class="field"><label class="field-label">退订链接语言</label>
          <select class="select" data-role="ses-unsubscribe">
            <option value="2" ${ses.unsubscribe === '2' || !ses.unsubscribe ? 'selected' : ''}>简体中文（推荐，营销邮件）</option>
            <option value="1" ${ses.unsubscribe === '1' ? 'selected' : ''}>英文</option>
            <option value="3" ${ses.unsubscribe === '3' ? 'selected' : ''}>繁体中文</option>
            <option value="0" ${ses.unsubscribe === '0' ? 'selected' : ''}>不附加退订链接</option>
          </select></div>
        <div class="field"><label class="field-label">免费额度总量（封）</label>
          <input class="input" type="number" min="0" data-role="ses-freeQuotaTotal" value="${MM.attr(ses.freeQuotaTotal || 1000)}" />
          <div class="field-hint">腾讯云官方给每个账号 1000 封免费额度（官方说明为「不限有效期，用完为止」），可按最新政策调整</div></div>
        <div class="field span-2">
          <label class="switch"><input type="checkbox" data-role="ses-allowSimple" ${ses.allowSimple ? 'checked' : ''} /><span class="track"></span>已开通 HTML 直发权限（未开通时保持关闭，否则接口会报错）</label>
        </div>
      </div>
      <div class="callout">
        使用提示：<br/>
        ① 需先在腾讯云控制台完成「发信域名 / 发信地址」验证，并把发信域名解析配置好；<br/>
        ② 模板发送需在控制台创建「发信模板」并通过审核，本应用会把邮件模板中用到的变量（如
        <span class="mono">{{公司名}}</span>、<span class="mono">{{联系人}}</span>）替换为真实内容后作为模板变量传入，因此腾讯云模板中的变量名请与本应用保持一致；<br/>
        ③ 腾讯云免费额度用完后按量计费（约 0.0019 元/封），请留意控制台账单。
      </div>`;
  }

  function accountForm(a) {
    const acc = a || { provider: 'smtp', port: 465, secure: true, enabled: true, dailyLimit: 200, ses: { freeQuotaTotal: 1000, unsubscribe: '2', region: 'ap-guangzhou', site: 'cn', sendMode: 'template' } };
    const provider = acc.provider === 'tencent-ses' ? 'tencent-ses' : 'smtp';
    return `
      <div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">① 发信渠道</div></div>
        <div class="panel-body">
          <div class="segmented" data-role="provider">
            <button data-provider="smtp" class="${provider === 'smtp' ? 'active' : ''}">普通邮箱 SMTP</button>
            <button data-provider="tencent-ses" class="${provider === 'tencent-ses' ? 'active' : ''}">腾讯云邮件推送（SES）</button>
          </div>
          <div class="field-hint" style="margin-top:8px" data-role="provider-hint"></div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">② 账号信息</div></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="field"><label class="field-label">账号名称 <span class="field-hint">（仅本地标识）</span></label>
              <input class="input" data-role="name" value="${MM.attr(acc.name)}" placeholder="例：市场部主发信账号" /></div>
            <div class="field"><label class="field-label">发信人姓名 <span class="field-hint">（收件人看到的发件人）</span></label>
              <input class="input" data-role="fromName" value="${MM.attr(acc.fromName)}" placeholder="例：市场部 · 王小明" /></div>
            <div class="field"><label class="field-label">发信邮箱地址<span class="req">*</span></label>
              <input class="input" data-role="email" value="${MM.attr(acc.email)}" placeholder="marketing@yourdomain.com" /></div>
            <div class="field"><label class="field-label">每日发送上限（0 = 不限）</label>
              <input class="input" type="number" min="0" data-role="dailyLimit" value="${MM.attr(acc.dailyLimit || 0)}" /></div>
            <div class="field span-2"><label class="field-label">备注</label>
              <input class="input" data-role="remark" value="${MM.attr(acc.remark)}" placeholder="选填，便于区分用途" /></div>
            <div class="field span-2">
              <label class="switch"><input type="checkbox" data-role="enabled" ${acc.enabled !== false ? 'checked' : ''} /><span class="track"></span>启用该发信账号（停用后不可被推广任务选择）</label>
            </div>
          </div>
        </div>
      </div>

      <div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">③ 渠道配置</div></div>
        <div class="panel-body">
          <div data-role="fields-smtp" class="${provider === 'smtp' ? '' : 'hidden'}">${smtpFields(acc)}</div>
          <div data-role="fields-ses" class="${provider === 'tencent-ses' ? '' : 'hidden'}">${sesFields(acc)}</div>
        </div>
      </div>

      <div data-role="test-result"></div>`;
  }

  function collect(ctx, provider) {
    const base = {
      id: ctx.$('[data-role="email"]').dataset.id || undefined,
      provider,
      name: ctx.$('[data-role="name"]').value.trim(),
      fromName: ctx.$('[data-role="fromName"]').value.trim(),
      email: ctx.$('[data-role="email"]').value.trim(),
      dailyLimit: Number(ctx.$('[data-role="dailyLimit"]').value) || 0,
      remark: ctx.$('[data-role="remark"]').value,
      enabled: ctx.$('[data-role="enabled"]').checked,
    };
    if (provider === 'smtp') {
      return Object.assign(base, {
        host: ctx.$('[data-role="host"]').value.trim(),
        port: Number(ctx.$('[data-role="port"]').value) || 465,
        secure: ctx.$('[data-role="secure"]').value === 'true',
        pass: ctx.$('[data-role="pass"]').value,
        user: base.email,
      });
    }
    return Object.assign(base, {
      host: '',
      port: 465,
      secure: true,
      pass: '',
      user: '',
      ses: {
        secretId: ctx.$('[data-role="ses-secretId"]').value.trim(),
        secretKey: ctx.$('[data-role="ses-secretKey"]').value.trim(),
        region: ctx.$('[data-role="ses-region"]').value.trim() || 'ap-guangzhou',
        site: ctx.$('[data-role="ses-site"]').value,
        templateId: ctx.$('[data-role="ses-templateId"]').value.trim(),
        replyTo: ctx.$('[data-role="ses-replyTo"]').value.trim(),
        unsubscribe: ctx.$('[data-role="ses-unsubscribe"]').value,
        sendMode: ctx.$('[data-role="ses-sendMode"]').value,
        allowSimple: ctx.$('[data-role="ses-allowSimple"]').checked,
        freeQuotaTotal: Number(ctx.$('[data-role="ses-freeQuotaTotal"]').value) || 1000,
      },
    });
  }

  function openEditor(account, onDone) {
    const ctx = MM.modal({
      title: account ? `编辑发信账号：${account.email}` : '新增发信账号',
      size: 'wide',
      body: accountForm(account),
      footer: `<button class="btn" data-cancel>取消</button><button class="btn" data-test>测试连接</button><button class="btn btn-primary" data-save>保存账号</button>`,
    });

    if (account && account.id) ctx.$('[data-role="email"]').dataset.id = account.id;

    let provider = account && account.provider === 'tencent-ses' ? 'tencent-ses' : 'smtp';

    const paintProvider = () => {
      ctx.$$('[data-role="provider"] button').forEach((b) => b.classList.toggle('active', b.dataset.provider === provider));
      ctx.$('[data-role="fields-smtp"]').classList.toggle('hidden', provider !== 'smtp');
      ctx.$('[data-role="fields-ses"]').classList.toggle('hidden', provider !== 'tencent-ses');
      ctx.$('[data-role="provider-hint"]').innerHTML =
        provider === 'smtp'
          ? '使用自有邮箱账号通过 SMTP 协议发送。配置简单，但群发推广存在被服务商限速 / 封号的风险，请控制发送频率与名单质量。'
          : '使用腾讯云邮件推送（SES）通道发送，送达率更高、具备免费额度与合规退订机制；需要腾讯云账号的 SecretId / SecretKey 与已审核的发信模板（或发信域名 / 地址）。';
    };
    paintProvider();

    ctx.$$('[data-role="provider"] button').forEach((btn) => {
      btn.onclick = () => {
        provider = btn.dataset.provider;
        paintProvider();
      };
    });

    ctx.$$('[data-preset]').forEach((btn) => {
      btn.onclick = () => {
        const p = SMTP_PRESETS[Number(btn.dataset.preset)];
        ctx.$('[data-role="host"]').value = p.host;
        ctx.$('[data-role="port"]').value = p.port;
        ctx.$('[data-role="secure"]').value = String(p.secure);
        ctx.$('[data-role="preset-hint"]').textContent = `${p.label}：${p.hint}（服务器 ${p.host}）`;
      };
    });

    ctx.$('[data-cancel]').onclick = ctx.close;

    ctx.$('[data-test]').onclick = async (e) => {
      const data = collect(ctx, provider);
      const restore = MM.spinBtn(e.target, '连接中');
      const res = await MM.api.testAccount(data);
      restore();
      const box = ctx.$('[data-role="test-result"]');
      if (!res.ok) {
        box.innerHTML = `<div class="callout danger">测试失败：${MM.esc(res.error)}</div>`;
        return;
      }
      const d = res.data;
      box.innerHTML = `<div class="callout ${d.ok ? '' : 'danger'}">${d.ok ? '✓' : '✕'} ${MM.esc(d.message)}（耗时 ${d.durationMs} ms）${
        d.senders && d.senders.length ? `<br/>控制台已配置发信地址：${d.senders.map((s) => MM.esc(s.email)).join('、')}` : ''
      }</div>`;
      MM.toast(`${d.ok ? '✓' : '✕'} ${d.message}`, d.ok ? 'success' : 'error', 8000);
    };

    ctx.$('[data-save]').onclick = async (e) => {
      const restore = MM.spinBtn(e.target, '保存中');
      const res = await MM.api.saveAccount(collect(ctx, provider));
      restore();
      if (!res.ok) {
        MM.toast(res.error, 'error', 7000);
        return;
      }
      MM.toast(account ? '发信账号已更新' : '发信账号已添加', 'success');
      ctx.close();
      onDone();
    };
  }

  function showQuota(account, render) {
    if (!account || !account.id) {
      MM.toast('未找到该发信账号，页面数据可能已刷新，请重试', 'error');
      return;
    }
    const ctx = MM.modal({
      title: `腾讯云邮件推送额度：${account.email}`,
      size: '',
      body: '<div class="empty">正在查询腾讯云接口…</div>',
      footer: `<button class="btn" data-modal-close>关闭</button><button class="btn btn-primary" data-refresh>重新查询</button>`,
    });

    const paint = async () => {
      const res = await MM.api.querySesQuota({ id: account.id });
      const body = ctx.$('.modal-body');
      if (!res.ok) {
        body.innerHTML = `<div class="callout danger">查询失败：${MM.esc(res.error)}</div>`;
        return;
      }
      const d = res.data;
      const q = d.quota;
      const local = d.local || {};
      body.innerHTML = `
        ${d.remote ? `<div class="callout ${d.ok ? '' : 'warn'}">${MM.esc(d.message)}</div>` : `<div class="callout warn">${MM.esc(d.message)}</div>`}
        ${
          q
            ? `<div class="cards c3" style="margin-bottom:14px">
                 ${MM.statCard({ label: '免费额度剩余（腾讯云）', value: q.remaining == null ? '—' : q.remaining, tone: 's-success', sub: '来自套餐包 / 账户接口' })}
                 ${MM.statCard({ label: '额度总量', value: q.total == null ? '—' : q.total, sub: q.expireTime ? `有效期至 ${MM.esc(String(q.expireTime))}` : '' })}
                 ${MM.statCard({ label: '已使用', value: q.used == null ? '—' : q.used, tone: 's-warn' })}
               </div>`
            : ''
        }
        <div class="cards c3" style="margin-bottom:14px">
          ${MM.statCard({ label: '本地估算剩余', value: local.freeQuotaRemainingLocal == null ? '—' : local.freeQuotaRemainingLocal, tone: 's-info', sub: `按免费额度 ${local.freeQuotaTotal || 0} 封 − 本应用累计真实发送 ${local.totalUsed || 0} 封` })}
          ${MM.statCard({ label: '本月已发', value: local.monthUsed || 0 })}
          ${MM.statCard({ label: '今日已发', value: local.todayUsed || 0 })}
        </div>
        ${
          d.packages && d.packages.length
            ? `<div class="panel"><div class="panel-head"><div class="panel-title">套餐包明细（腾讯云原样返回）</div></div>
                 <div class="panel-body tight"><table class="table"><thead><tr>${Object.keys(d.packages[0]).slice(0, 8).map((k) => `<th>${MM.esc(k)}</th>`).join('')}</tr></thead>
                 <tbody>${d.packages
                   .map((p) => `<tr>${Object.keys(p).slice(0, 8).map((k) => `<td class="mono" style="font-size:11.5px">${MM.esc(typeof p[k] === 'object' ? JSON.stringify(p[k]) : p[k])}</td>`).join('')}</tr>`)
                   .join('')}</tbody></table></div></div>`
            : d.raw
              ? `<div class="field"><label class="field-label">接口返回（未识别出标准额度字段，可据此在控制台核对）</label>
                   <textarea class="textarea" rows="6" readonly>${MM.esc(JSON.stringify(d.raw, null, 2))}</textarea></div>`
              : ''
        }
        <div class="field-hint">说明：腾讯云官方为每个账号提供 1000 封免费额度（官方标注「不限有效期，用完为止」）；若已购买套餐包，以套餐包剩余量为准。最终以腾讯云控制台「邮件推送 → 用量统计 / 账单」为准。</div>`;
    };

    ctx.$('[data-refresh]').onclick = paint;
    paint().catch((err) => {
      ctx.$('.modal-body').innerHTML = `<div class="callout danger">${MM.esc(err.message)}</div>`;
    });
  }

  MM.pages.accounts = {
    title: '发信邮箱配置',

    async render(view) {
      const [res, settings] = await Promise.all([MM.api.listAccounts(), MM.loadSettings(true)]);
      const accounts = res.ok ? res.data : [];
      const enabled = accounts.filter((a) => a.enabled !== false);
      const def = accounts.find((a) => a.isDefault) || enabled[0];
      const totalToday = accounts.reduce((n, a) => n + (a.todayUsed || 0), 0);
      const smtpAccounts = accounts.filter((a) => a.provider !== 'tencent-ses');
      const sesAccounts = accounts.filter((a) => a.provider === 'tencent-ses');
      const unconfigured = accounts.filter((a) => (a.provider === 'tencent-ses' ? !(a.ses?.secretId && a.ses?.secretKey) : !a.pass));
      const sesFreeLeft = sesAccounts.length ? sesAccounts.reduce((n, a) => n + (a.freeQuotaRemaining || 0), 0) : null;

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            配置用于群发推广邮件的发信账号，支持两类渠道：<b>普通邮箱 SMTP</b>（自有邮箱账号，配置简单但存在封号风险）与
            <b>腾讯云邮件推送 SES</b>（专业发信通道，送达率更高，自带免费额度）。可添加多个账号，为不同推广任务指定不同发信地址。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="goto-settings">其他设置</button>
            <button class="btn btn-primary" data-act="create">＋ 新增发信账号</button>
          </div>
        </div>

        <div class="cards c4">
          ${MM.statCard({ label: '发信账号总数', value: accounts.length, sub: `启用中 ${enabled.length} 个 · SMTP ${smtpAccounts.length} / 腾讯云 ${sesAccounts.length}` })}
          ${MM.statCard({ label: '默认发信账号', value: def ? MM.esc(def.email) : '—', sub: def ? `${def.provider === 'tencent-ses' ? '腾讯云邮件推送' : '普通邮箱 SMTP'} · ${MM.esc(def.name)}` : '尚未配置任何账号', tone: 's-info' })}
          ${MM.statCard({ label: '今日总发送量', value: totalToday, sub: '按账号独立统计，仅计真实发送', tone: 's-success' })}
          ${
            sesAccounts.length
              ? MM.statCard({ label: '腾讯云免费额度剩余', value: sesFreeLeft == null ? '—' : sesFreeLeft, sub: '本地估算，可点击账号卡片「查询额度」以接口数据为准', tone: 's-warn' })
              : MM.statCard({ label: '待完善账号', value: unconfigured.length, sub: unconfigured.length ? '缺少密码/密钥等必要配置' : '全部已配置完整', tone: unconfigured.length ? 's-warn' : '' })
          }
        </div>

        <div class="callout danger">
          <div>${MM.esc(SMTP_WARNING).split('\n')[0]}</div>
        </div>

        ${
          MM.sendMode(settings) !== 'live'
            ? '<div class="callout">当前为「试运行模式」：推广任务不会真实投递，便于先验证模板与流程；确认无误后在「系统设置」中切换为真实发送。</div>'
            : '<div class="callout danger">当前为「真实发送模式」：推广任务将使用所选发信账号真实投递邮件，请确认账号、密码与发信模板配置正确。</div>'
        }
        ${
          unconfigured.length
            ? `<div class="callout warn">有 ${unconfigured.length} 个账号缺少必要配置（${unconfigured.map((a) => MM.esc(a.email)).join('、')}），真实发送前需要补全。普通邮箱多数需要使用「授权码 / 应用专用密码」；腾讯云渠道需要 SecretId / SecretKey（模板发送还需模板 ID）。</div>`
            : ''
        }

        <div data-role="list">
          ${accounts.length ? accounts.map(accountCard).join('') : '<div class="empty"><strong>还没有配置发信账号</strong>点击右上角「新增发信账号」添加第一个用于群发推广的通道。</div>'}
        </div>
      `;

      const reload = () => MM.renderRoute('accounts');
      view.querySelector('[data-act="goto-settings"]').onclick = () => MM.navigate('settings');
      view.querySelector('[data-act="create"]').onclick = () => openEditor(null, reload);

      view.querySelectorAll('[data-id]').forEach((card) => {
        const id = card.dataset.id;
        const account = accounts.find((a) => a.id === id);
        card.querySelectorAll('[data-act]').forEach((btn) => {
          btn.onclick = async (e) => {
            const act = btn.dataset.act;
            if (!account || !account.id) {
              MM.toast('未找到该发信账号，页面数据可能已刷新，请重试', 'error');
              return;
            }

            if (act === 'edit') openEditor(account, reload);
            if (act === 'quota') showQuota(account, reload);

            if (act === 'default') {
              const r = await MM.api.setDefaultAccount(id);
              if (!r.ok) {
                MM.toast(r.error, 'error');
                return;
              }
              MM.toast(`已将 ${account.email} 设为默认发信账号`, 'success');
              reload();
            }

            if (act === 'toggle') {
              const enable = account.enabled === false;
              const r = await MM.api.saveAccount(Object.assign({}, account, { enabled: enable }));
              if (!r.ok) {
                MM.toast(r.error, 'error');
                return;
              }
              MM.toast(enable ? '已启用该发信账号' : '已停用该发信账号', 'success');
              reload();
            }

            if (act === 'test') {
              const restore = MM.spinBtn(e.target, '连接中');
              const r = await MM.api.testAccount({ id });
              restore();
              if (!r.ok) {
                MM.toast(r.error, 'error');
                return;
              }
              MM.toast(`${r.data.ok ? '✓' : '✕'} ${r.data.message}（${r.data.durationMs} ms）`, r.data.ok ? 'success' : 'error', 8000);
            }

            if (act === 'remove') {
              const yes = await MM.confirm({
                title: '删除发信账号',
                message: `确定删除 <b>${MM.esc(account.email)}</b>（${MM.esc(account.name)}）吗？历史投递记录会保留。`,
                confirmText: '删除',
                danger: true,
              });
              if (!yes) return;
              const r = await MM.api.removeAccount(id);
              if (!r.ok) {
                MM.toast(r.error, 'error', 7000);
                return;
              }
              MM.toast('发信账号已删除', 'success');
              reload();
            }
          };
        });
      });
    },
  };
})();
