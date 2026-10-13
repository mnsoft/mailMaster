/* 页面：推广任务（临时推广 / 定时推广） */
(function () {
  const MM = window.MM;

  const state = {
    filterKind: 'manual',
    keyword: '',
    contacts: [],
    tags: [],
  };

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const SCHEDULE_TYPES = [
    { value: 'manual', label: '仅手动' },
    { value: 'interval', label: '每 N 分钟' },
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每周' },
    { value: 'monthly', label: '每月' },
    { value: 'once', label: '指定时间一次' },
  ];

  function scheduleFormHtml(schedule) {
    const s = schedule || { type: 'manual' };
    return `
      <div class="field">
        <label class="field-label">执行方式</label>
        <div class="segmented" data-role="sched-types">
          ${SCHEDULE_TYPES.map((t) => `<button data-type="${t.value}" class="${s.type === t.value ? 'active' : ''}">${t.label}</button>`).join('')}
        </div>
      </div>
      <div data-role="sched-extra"></div>`;
  }

  function scheduleExtraHtml(s) {
    switch (s.type) {
      case 'once':
        return `<div class="field span-2"><label class="field-label">执行时间</label>
          <input class="input" type="datetime-local" data-role="sched-at" value="${MM.attr(s.at ? String(s.at).slice(0, 16) : '')}" /></div>`;
      case 'interval':
        return `<div class="field"><label class="field-label">间隔（分钟）</label>
          <input class="input" type="number" min="1" data-role="sched-every" value="${MM.attr(s.everyMinutes || 30)}" /></div>
          <div class="field"><label class="field-label">每日发送上限（0 = 不限制）</label>
          <input class="input" type="number" min="0" data-role="limit" value="200" /></div>`;
      case 'daily':
        return `<div class="field"><label class="field-label">每天执行时间</label>
          <input class="input" type="time" data-role="sched-time" value="${MM.attr(s.time || '09:30')}" /></div>`;
      case 'weekly':
        return `<div class="field span-2"><label class="field-label">执行星期</label>
          <div class="weekday-picker" data-role="sched-weekdays">
            ${WEEKDAYS.map((w, i) => `<button data-day="${i}" class="${(s.weekdays || [1]).includes(i) ? 'on' : ''}">${w}</button>`).join('')}
          </div></div>
          <div class="field"><label class="field-label">执行时间</label>
          <input class="input" type="time" data-role="sched-time" value="${MM.attr(s.time || '09:30')}" /></div>`;
      case 'monthly':
        return `<div class="field span-2"><label class="field-label">每月执行日期（可多选，不存在的日期自动顺延到当月最后一天）</label>
          <div class="var-picker" data-role="sched-days">
            ${Array.from({ length: 31 }, (_, i) => i + 1)
              .map((d) => `<button class="var-chip ${(s.days || [1]).includes(d) ? 'on' : ''}" data-day="${d}" style="${(s.days || [1]).includes(d) ? 'background:var(--accent-soft);border-color:rgba(76,141,255,.4)' : ''}">${d}</button>`)
              .join('')}
          </div></div>
          <div class="field"><label class="field-label">执行时间</label>
          <input class="input" type="time" data-role="sched-time" value="${MM.attr(s.time || '09:30')}" /></div>`;
      default:
        return `<div class="callout" style="margin:0">该任务不会自动触发，只在你点击「立即执行」时发送。适合临时推广。</div>`;
    }
  }

  function audienceFormHtml(audience, contacts, tags) {
    const a = audience || { mode: 'all', tags: [], ids: [] };
    return `
      <div class="field">
        <label class="field-label">收件人范围</label>
        <div class="segmented" data-role="aud-modes">
          <button data-mode="all" class="${a.mode === 'all' ? 'active' : ''}">全部可发送联系人</button>
          <button data-mode="tags" class="${a.mode === 'tags' ? 'active' : ''}">按标签筛选</button>
          <button data-mode="ids" class="${a.mode === 'ids' ? 'active' : ''}">手动勾选</button>
        </div>
      </div>
      <div data-role="aud-extra">
        <div data-role="aud-tags" class="field ${a.mode === 'tags' ? '' : 'hidden'}">
          <label class="field-label">选择标签</label>
          <div class="checkbox-list">
            ${tags.length ? tags.map((t) => `<label><input type="checkbox" value="${MM.attr(t)}" ${a.tags.includes(t) ? 'checked' : ''} /> ${MM.esc(t)}</label>`).join('') : '<div style="color:var(--text-faint)">暂无标签，请先在邮件列表中为联系人设置标签</div>'}
          </div>
        </div>
        <div data-role="aud-ids" class="field ${a.mode === 'ids' ? '' : 'hidden'}">
          <label class="field-label">勾选联系人（可搜索）</label>
          <input class="input" data-role="aud-search" placeholder="搜索公司名 / 联系人 / 邮箱…" style="margin-bottom:8px" />
          <div class="checkbox-list" data-role="aud-list">
            ${contacts
              .map(
                (c) => `<label data-search="${MM.attr(`${c.company} ${c.contact} ${c.email} ${c.salutation}`)}"><input type="checkbox" value="${c.id}" ${a.ids.includes(c.id) ? 'checked' : ''} /> ${MM.esc(c.company)} · ${MM.esc(c.contact)}</label>`,
              )
              .join('')}
          </div>
        </div>
        <div class="field">
          <div class="pill-row">
            <button class="btn btn-sm" data-role="preview-aud">统计命中人数</button>
            <span class="pill" data-role="aud-result">尚未统计</span>
          </div>
        </div>
      </div>`;
  }

  function campaignFormHtml(campaign) {
    const c = campaign || {};
    const tplId = c.templateId || (MM.state.templates[0] && MM.state.templates[0].id);
    const throttle = Object.assign({ intervalSeconds: 6, dailyLimit: 200, maxRetries: 1 }, c.throttle || {});
    const accounts = MM.state.accounts || [];
    const defaultAccount = accounts.find((a) => a.isDefault) || accounts.find((a) => a.enabled !== false) || accounts[0];
    const accId = c.accountId || (defaultAccount && defaultAccount.id) || '';
    return `
      <div class="form-grid">
        <div class="field span-2">
          <label class="field-label">任务名称<span class="req">*</span></label>
          <input class="input" data-role="name" value="${MM.attr(c.name || '')}" placeholder="例：10月常规推广 / 临时医疗行业触达" />
        </div>
        <div class="field span-2">
          <label class="field-label">任务说明</label>
          <input class="input" data-role="description" value="${MM.attr(c.description || '')}" placeholder="选填，便于后续识别任务用途" />
        </div>
        <div class="field span-2">
          <label class="field-label">使用邮件模板<span class="req">*</span></label>
          <select class="select" data-role="templateId">
            ${MM.state.templates
              .map((t) => `<option value="${t.id}" ${t.id === tplId ? 'selected' : ''}>${MM.esc(t.name)} — ${MM.esc((t.subject || '').slice(0, 40))}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field span-2">
          <label class="field-label">发信邮箱账号<span class="req">*</span> <span class="field-hint">（不同任务可使用不同的发信地址）</span></label>
          ${
            accounts.length
              ? `<select class="select" data-role="accountId">
                   ${accounts
                     .map(
                       (a) =>
                         `<option value="${a.id}" ${a.id === accId ? 'selected' : ''} ${a.enabled === false ? 'disabled' : ''}>${MM.esc(a.email)}　·　${MM.esc(a.name)}${a.isDefault ? '（默认）' : ''}${a.enabled === false ? '（已停用）' : ''}</option>`,
                     )
                     .join('')}
                 </select>
                 <div class="field-hint">该任务的邮件将从所选邮箱发出，模板中的 <span class="mono">{{发件人}}</span> 取该账号的发信人姓名。</div>`
              : `<div class="callout warn" style="margin:0">尚未配置发信邮箱账号，请先前往「发信邮箱配置」添加。</div>`
          }
        </div>
      </div>

      <div class="panel"><div class="panel-head"><div class="panel-title">① 发送范围与执行方式</div></div>
        <div class="panel-body">
          ${audienceFormHtml(c.audience, state.contacts, state.tags)}
          <div class="form-grid" style="margin-top:10px">${scheduleFormHtml(c.schedule)}</div>
        </div>
      </div>

      <div class="panel"><div class="panel-head"><div class="panel-title">② 发送节流与重试</div></div>
        <div class="panel-body">
          <div class="form-grid c3">
            <div class="field"><label class="field-label">每封间隔（秒）</label>
              <input class="input" type="number" min="0" data-role="intervalSeconds" value="${MM.attr(throttle.intervalSeconds)}" />
              <div class="field-hint">建议 5～15 秒，过快易被判为垃圾邮件</div></div>
            <div class="field"><label class="field-label">每日发送上限（0 = 不限）</label>
              <input class="input" type="number" min="0" data-role="dailyLimit" value="${MM.attr(throttle.dailyLimit)}" /></div>
            <div class="field"><label class="field-label">失败重试次数</label>
              <input class="input" type="number" min="0" max="5" data-role="maxRetries" value="${MM.attr(throttle.maxRetries)}" />
              <div class="field-hint">仅对临时性失败（如超时）重试</div></div>
          </div>
          <label class="switch" style="margin-top:6px"><input type="checkbox" data-role="dryRun" ${c.dryRun !== false ? 'checked' : ''} /><span class="track"></span>本次任务使用「试运行」（模拟发送并记录结果，不真正发出邮件）</label>
        </div>
      </div>`;
  }

  function cardHtml(c) {
    const p = c.progress || {};
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const effectiveDry = MM.effectiveDryRun(c);
    return `<div class="panel" data-id="${c.id}">
      <div class="panel-head">
        <div class="panel-title">
          ${c.running ? '<span class="running-dot"></span>' : ''}
          ${MM.esc(c.name)}
          ${MM.statusBadge(c.status)}
          ${c.kind === 'manual' ? '<span class="badge badge-info">临时任务</span>' : '<span class="badge badge-pending">定时任务</span>'}
          ${effectiveDry ? '<span class="badge badge-draft" title="不会真正发出邮件">试运行</span>' : '<span class="badge badge-bounced" title="会真实投递">真实发送</span>'}
        </div>
        <div class="row-actions">
          ${c.running
            ? `<button class="btn btn-sm" data-act="pause" data-paused="false">暂停</button>
               <button class="btn btn-sm btn-danger" data-act="cancel">中止</button>`
            : `<button class="btn btn-sm btn-primary" data-act="run">${c.kind === 'manual' ? '立即推广' : '立即执行一次'}</button>
               ${c.kind === 'manual' ? '' : `<button class="btn btn-sm" data-act="pause" data-paused="true">${c.status === 'active' ? '停用定时' : '启用定时'}</button>`}
               <button class="btn btn-sm" data-act="edit">编辑</button>
               <button class="btn btn-sm btn-danger" data-act="remove">删除</button>`}
        </div>
      </div>
      <div class="panel-body">
        <div style="color:var(--text-dim);font-size:12px;margin-bottom:10px">${MM.esc(c.description || '（无说明）')}</div>
        <div class="pill-row" style="margin-bottom:10px">
          <span class="pill">模板 <b>${MM.esc((MM.state.templates.find((t) => t.id === c.templateId) || {}).name || '未关联')}</b></span>
          <span class="pill">发信邮箱 <b>${MM.esc(c.accountEmail || '未指定')}</b></span>
          <span class="pill">执行计划 <b>${MM.esc(c.scheduleText || '—')}</b></span>
          ${c.nextRunAt ? `<span class="pill">下次执行 <b>${MM.esc(MM.fmtDate(c.nextRunAt, true))}</b></span>` : ''}
          <span class="pill">间隔 <b>${c.throttle?.intervalSeconds ?? '—'} 秒</b></span>
          <span class="pill">每日上限 <b>${c.throttle?.dailyLimit ?? '—'}</b></span>
          <span class="pill">运行次数 <b>${c.runCount || 0}</b></span>
        </div>
        ${
          p.total
            ? `<div class="progress" style="margin-bottom:6px"><div class="progress-bar ${p.failed === 0 && p.bounced === 0 ? 'ok' : ''}" style="width:${pct}%"></div></div>
               <div style="display:flex;gap:16px;font-size:11.5px;color:var(--text-faint)">
                 <span>进度 ${p.done || 0}/${p.total}（${pct}%）</span>
                 <span style="color:var(--success)">成功 ${p.success || 0}</span>
                 <span style="color:var(--danger)">失败 ${p.failed || 0}</span>
                 <span style="color:var(--warn)">退信 ${p.bounced || 0}</span>
                 ${p.finishedAt ? `<span>上次结束 ${MM.fmtDate(p.finishedAt, true)}</span>` : ''}
               </div>`
            : `<div style="font-size:11.5px;color:var(--text-faint)">尚未执行过。${c.nextRunAt ? `将于 ${MM.esc(MM.fmtDate(c.nextRunAt, true))} 自动启动。` : '点击右上角按钮开始推广。'}</div>`
        }
      </div>
    </div>`;
  }

  MM.pages.campaigns = {
    title: '推广任务',

    async render(view) {
      await Promise.all([MM.loadTemplates(), MM.loadCampaigns(), MM.loadAccounts()]);
      const res = await MM.api.listContacts({ status: 'active' });
      state.contacts = res.ok ? res.data.items : [];
      state.tags = res.ok ? res.data.tags : [];

      const list = MM.state.campaigns.filter((c) => c.kind === state.filterKind);

      view.innerHTML = `
        <div class="page-head">
          <div>
            <div class="segmented" data-role="kind-switch">
              <button data-kind="manual" class="${state.filterKind === 'manual' ? 'active' : ''}">临时推广任务</button>
              <button data-kind="scheduled" class="${state.filterKind === 'scheduled' ? 'active' : ''}">定时推广任务</button>
            </div>
            <div class="page-desc" style="margin-top:8px">
              ${
                state.filterKind === 'manual'
                  ? '临时推广任务：不参与自动调度，创建后可随时点击「立即推广」向指定范围发一次，适合活动通知、临时触达。'
                  : '定时推广任务：按设定规则（每天 / 每周 / 每月 / 每 N 分钟）自动启动，可随时停用或改为临时任务。'
              }
            </div>
          </div>
          <div class="page-actions">
            <button class="btn" data-act="goto-tasks">定时任务管理</button>
            <button class="btn btn-primary" data-act="create">＋ 新建${state.filterKind === 'manual' ? '临时' : '定时'}推广任务</button>
          </div>
        </div>

        ${
          state.filterKind === 'manual'
            ? `<div class="callout">💡 需要在固定时间自动推广？切换到「定时推广任务」，可配置每天 / 每周 / 每月（例如每月 1 日、15 日）自动执行。</div>`
            : `<div class="callout">💡 定时任务由后台调度器驱动，关闭窗口后仍会驻留托盘继续执行；可在「定时任务管理」页查看下次执行时间与启停状态。</div>`
        }

        <div data-role="list">
          ${list.length ? list.map(cardHtml).join('') : '<div class="empty"><strong>当前分类下还没有推广任务</strong>点击右上角「新建推广任务」开始配置。</div>'}
        </div>
      `;

      const rerender = () => MM.renderRoute('campaigns');

      view.querySelectorAll('[data-role="kind-switch"] button').forEach((btn) => {
        btn.onclick = () => {
          state.filterKind = btn.dataset.kind;
          rerender();
        };
      });
      view.querySelector('[data-act="goto-tasks"]').onclick = () => MM.navigate('tasks');
      view.querySelector('[data-act="create"]').onclick = () => openCampaignEditor(null, state.filterKind, rerender);

      view.querySelectorAll('[data-id]').forEach((card) => {
        const id = card.dataset.id;
        card.querySelectorAll('[data-act]').forEach((btn) => {
          btn.onclick = async (e) => {
            const campaign = MM.state.campaigns.find((c) => c.id === id);
            const act = btn.dataset.act;

            if (act === 'run') {
              const effectiveDry = MM.effectiveDryRun(campaign);
              const yes = await MM.confirm({
                title: '确认执行推广任务',
                message: `即将向「<b>${MM.esc(campaign.name)}</b>」配置的范围内所有可发送联系人投递邮件。<br/>
                  发信邮箱：<b>${MM.esc(campaign.accountEmail || '（默认发信账号）')}</b><br/>
                  发送模式：<b style="color:${effectiveDry ? 'var(--warn)' : 'var(--danger)'}">${effectiveDry ? '试运行（不会真正发出）' : '真实发送（会真实投递）'}</b><br/>
                  每封间隔 ${campaign.throttle?.intervalSeconds ?? 6} 秒，每日上限 ${campaign.throttle?.dailyLimit ?? '不限'} 封。`,
                confirmText: effectiveDry ? '开始试运行' : '确认真实发送',
                danger: !effectiveDry,
              });
              if (!yes) return;
              const restore = MM.spinBtn(btn, '启动中');
              const res = await MM.api.runCampaign({ id, activate: true });
              restore();
              if (!res.ok) {
                MM.toast(res.error, 'error', 6000);
                return;
              }
              MM.toast('任务已开始执行，进度将实时更新', 'success');
              setTimeout(rerender, 600);
            }

            if (act === 'pause') {
              const paused = btn.dataset.paused === 'true';
              const res = await MM.api.pauseCampaign({ id, paused });
              if (!res.ok) {
                MM.toast(res.error, 'error');
                return;
              }
              MM.toast(paused ? '已停用该任务的自动调度' : '已启用该任务的自动调度', 'success');
              rerender();
            }

            if (act === 'cancel') {
              await MM.api.cancelCampaign(id);
              MM.toast('已请求中止，等待当前邮件结束', 'warn');
            }

            if (act === 'edit') openCampaignEditor(campaign, campaign.kind, rerender);

            if (act === 'remove') {
              const yes = await MM.confirm({
                title: '删除推广任务',
                message: `确定删除任务「<b>${MM.esc(campaign.name)}</b>」吗？历史投递记录会被保留。`,
                confirmText: '删除',
                danger: true,
              });
              if (!yes) return;
              const res = await MM.api.removeCampaign(id);
              if (!res.ok) {
                MM.toast(res.error, 'error');
                return;
              }
              MM.toast('任务已删除', 'success');
              rerender();
            }
          };
        });
      });
    },

    onEvent(payload) {
      if (payload.type !== 'campaign') return;
      // 局部更新卡片上的进度，避免整页重绘打断交互
      const card = document.querySelector(`#view [data-id="${payload.campaign.id}"]`);
      if (!card) return;
      const p = payload.campaign.progress || {};
      const bar = card.querySelector('.progress-bar');
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      if (bar) bar.style.width = `${pct}%`;
      const info = card.querySelector('.progress + div');
      if (info) {
        info.innerHTML = `<span>进度 ${p.done || 0}/${p.total || 0}（${pct}%）</span>
          <span style="color:var(--success)">成功 ${p.success || 0}</span>
          <span style="color:var(--danger)">失败 ${p.failed || 0}</span>
          <span style="color:var(--warn)">退信 ${p.bounced || 0}</span>`;
      }
      if (!payload.campaign.running) setTimeout(() => MM.renderRoute('campaigns'), 400);
    },
  };

  function openCampaignEditor(campaign, kind, onDone) {
    if (!MM.state.templates.length) {
      MM.toast('请先在「内容模板」中创建至少一个邮件模板', 'warn', 6000);
      return;
    }
    if (!(MM.state.accounts || []).length) {
      MM.toast('请先在「发信邮箱配置」中添加用于群发的邮箱账号', 'warn', 6000);
      MM.navigate('accounts');
      return;
    }
    const ctx = MM.modal({
      title: campaign ? `编辑推广任务：${campaign.name}` : `新建${kind === 'manual' ? '临时' : '定时'}推广任务`,
      size: 'wide',
      body: campaignFormHtml(campaign),
      footer: `<button class="btn" data-cancel>取消</button>
               <button class="btn" data-preview>预览收件人</button>
               <button class="btn btn-primary" data-save>保存任务</button>`,
    });

    // ----- 执行方式切换 -----
    let schedule = Object.assign({}, (campaign && campaign.schedule) || { type: kind === 'manual' ? 'manual' : 'daily', time: '09:30' });
    if (!campaign) {
      schedule = kind === 'manual' ? { type: 'manual' } : { type: 'monthly', days: [1, 15], time: '09:30' };
    }
    const extra = ctx.$('[data-role="sched-extra"]');

    // 执行方式按钮的高亮以 schedule 为准：新建「定时推广任务」时表单默认是「每月」，
    // 而初始 HTML 是按 campaign 渲染的（新建时为「仅手动」），必须在渲染后同步一次，
    // 否则会出现「上方高亮仅手动、下方却是每月日期选择器」的错位。
    const paintScheduleTypes = () => {
      ctx.$$('[data-role="sched-types"] button').forEach((b) => b.classList.toggle('active', b.dataset.type === schedule.type));
    };

    const renderExtra = () => {
      paintScheduleTypes();
      extra.innerHTML = `<div class="form-grid">${scheduleExtraHtml(schedule)}</div>`;
      const dayPicker = extra.querySelector('[data-role="sched-days"]');
      if (dayPicker) {
        dayPicker.querySelectorAll('[data-day]').forEach((btn) => {
          btn.onclick = () => {
            const day = Number(btn.dataset.day);
            const days = new Set(schedule.days || []);
            if (days.has(day)) days.delete(day);
            else days.add(day);
            schedule.days = Array.from(days).sort((a, b) => a - b);
            renderExtra();
          };
        });
      }
      const wdPicker = extra.querySelector('[data-role="sched-weekdays"]');
      if (wdPicker) {
        wdPicker.querySelectorAll('[data-day]').forEach((btn) => {
          btn.onclick = () => {
            const day = Number(btn.dataset.day);
            const days = new Set(schedule.weekdays || []);
            if (days.has(day)) days.delete(day);
            else days.add(day);
            schedule.weekdays = Array.from(days).sort((a, b) => a - b);
            renderExtra();
          };
        });
      }
    };

    ctx.$$('[data-role="sched-types"] button').forEach((btn) => {
      btn.onclick = () => {
        schedule = { type: btn.dataset.type, time: schedule.time || '09:30' };
        if (schedule.type === 'monthly') schedule.days = [1, 15];
        if (schedule.type === 'weekly') schedule.weekdays = [1];
        if (schedule.type === 'interval') schedule.everyMinutes = 30;
        renderExtra();
      };
    });
    renderExtra();

    // ----- 受众切换 -----
    let audience = Object.assign({ mode: 'all', tags: [], ids: [] }, (campaign && campaign.audience) || {});
    const audTags = ctx.$('[data-role="aud-tags"]');
    const audIds = ctx.$('[data-role="aud-ids"]');

    const syncAudience = () => {
      audTags.classList.toggle('hidden', audience.mode !== 'tags');
      audIds.classList.toggle('hidden', audience.mode !== 'ids');
    };

    const collectAudience = () => {
      audience.tags = audTags ? Array.from(audTags.querySelectorAll('input:checked')).map((el) => el.value) : [];
      audience.ids = audIds ? Array.from(audIds.querySelectorAll('input:checked')).map((el) => el.value) : [];
      return audience;
    };

    ctx.$$('[data-role="aud-modes"] button').forEach((btn) => {
      btn.onclick = () => {
        ctx.$$('[data-role="aud-modes"] button').forEach((b) => b.classList.toggle('active', b === btn));
        audience.mode = btn.dataset.mode;
        syncAudience();
      };
    });
    syncAudience();

    const searchEl = ctx.$('[data-role="aud-search"]');
    if (searchEl) {
      searchEl.oninput = () => {
        const kw = searchEl.value.trim().toLowerCase();
        audIds.querySelectorAll('label[data-search]').forEach((label) => {
          label.classList.toggle('hidden', kw && !label.dataset.search.toLowerCase().includes(kw));
        });
      };
    }

    const collectSchedule = () => {
      const timeEl = extra.querySelector('[data-role="sched-time"]');
      if (timeEl) schedule.time = timeEl.value || '09:30';
      const atEl = extra.querySelector('[data-role="sched-at"]');
      if (atEl) schedule.at = atEl.value;
      const everyEl = extra.querySelector('[data-role="sched-every"]');
      if (everyEl) schedule.everyMinutes = Number(everyEl.value) || 30;
      return schedule;
    };

    const runAudiencePreview = async (e) => {
      collectAudience();
      const restore = MM.spinBtn(e.target, '统计中');
      const res = await MM.api.previewCampaignAudience(audience);
      restore();
      if (!res.ok) {
        MM.toast(res.error, 'error');
        return;
      }
      const d = res.data;
      ctx.$('[data-role="aud-result"]').innerHTML = `命中 <b>${d.total}</b> 位收件人`;
      if (d.total) {
        MM.modal({
          title: `命中收件人预览（共 ${d.total} 位，显示前 30 位）`,
          body: `<table class="table"><thead><tr><th>公司名</th><th>联系人</th><th>称呼</th><th>邮件地址</th><th>电话</th></tr></thead><tbody>
            ${d.sample.map((c) => `<tr><td>${MM.esc(c.company)}</td><td>${MM.esc(c.contact)}</td><td>${MM.esc(c.salutation)}</td><td class="mono">${MM.esc(c.email)}</td><td class="mono">${MM.esc(c.phone || '—')}</td></tr>`).join('')}
          </tbody></table>`,
          footer: `<button class="btn" data-modal-close>关闭</button>`,
        });
      } else {
        MM.toast('当前条件下没有命中任何收件人', 'warn');
      }
    };

    ctx.$('[data-role="preview-aud"]').onclick = runAudiencePreview;
    // 页脚的「预览收件人」与受众区的「统计命中人数」是同一个动作，复用同一处理
    if (ctx.$('[data-preview]')) ctx.$('[data-preview]').onclick = runAudiencePreview;

    ctx.$('[data-cancel]').onclick = ctx.close;
    ctx.$('[data-save]').onclick = async (e) => {
      const name = ctx.$('[data-role="name"]').value.trim();
      if (!name) {
        MM.toast('请填写任务名称', 'warn');
        return;
      }
      collectAudience();
      collectSchedule();
      const payload = {
        id: campaign ? campaign.id : undefined,
        name,
        description: ctx.$('[data-role="description"]').value,
        templateId: ctx.$('[data-role="templateId"]').value,
        accountId: ctx.$('[data-role="accountId"]') ? ctx.$('[data-role="accountId"]').value : undefined,
        kind,
        schedule,
        audience,
        throttle: {
          intervalSeconds: Number(ctx.$('[data-role="intervalSeconds"]').value) || 6,
          dailyLimit: Number(ctx.$('[data-role="dailyLimit"]').value) || 0,
          maxRetries: Number(ctx.$('[data-role="maxRetries"]').value) || 0,
        },
        dryRun: ctx.$('[data-role="dryRun"]').checked,
        status: campaign ? campaign.status : kind === 'manual' ? 'active' : 'active',
      };
      const restore = MM.spinBtn(e.target, '保存中');
      const res = await MM.api.saveCampaign(payload);
      restore();
      if (!res.ok) {
        MM.toast(res.error, 'error', 6000);
        return;
      }
      MM.toast('推广任务已保存', 'success');
      ctx.close();
      onDone();
    };
  }
})();
