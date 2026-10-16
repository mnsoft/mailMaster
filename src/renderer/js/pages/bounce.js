/* 页面：退信监听（IMAP 自动监听退信 → 标记 → 从发送列表剔除 → 可手动解除） */
(function () {
  const MM = window.MM;

  const state = {
    keyword: '',
    type: 'all',
    matched: 'all',
    accountId: '',
  };

  const TYPE_TEXT = { hard: '硬退信', soft: '临时退信', blocked: '被拒收' };
  const TYPE_CLASS = { hard: 'badge-bounced', soft: 'badge-pending', blocked: 'badge-paused' };

  function typeBadge(type) {
    const text = TYPE_TEXT[type] || type || '未知';
    return `<span class="badge ${TYPE_CLASS[type] || 'badge-pending'}">${MM.esc(text)}</span>`;
  }

  async function loadAll() {
    const [stateRes, eventsRes, contactsRes] = await Promise.all([
      MM.api.bounceState(),
      MM.api.listBounces({ keyword: state.keyword, type: state.type, matched: state.matched, accountId: state.accountId || undefined }),
      MM.api.listContacts({ status: 'bounceMarked' }),
    ]);
    return {
      bs: stateRes.ok ? stateRes.data : { accounts: [] },
      events: eventsRes.ok ? eventsRes.data : { total: 0, items: [] },
      marked: contactsRes.ok ? contactsRes.data.items : [],
    };
  }

  function accountsTable(bs) {
    const list = bs.accounts || [];
    if (!list.length) {
      return `<div class="empty"><strong>还没有发信账号</strong>请先在「发信邮箱配置」添加账号，并在账号里开启 IMAP 退信监听。</div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>发信账号</th><th>IMAP 服务器</th><th>收件箱</th><th>监听状态</th>
        <th>上次检查</th><th class="num">上次命中</th><th>说明</th><th style="width:190px"></th>
      </tr></thead>
      <tbody>
        ${list
          .map(
            (a) => `<tr data-acc="${a.id}">
              <td><span class="cell-strong">${MM.esc(a.email)}</span><span class="cell-sub">${MM.esc(a.name || '')}</span></td>
              <td class="mono" style="font-size:11.5px">${MM.esc(a.host || '—')}</td>
              <td class="mono" style="font-size:11.5px">${MM.esc(a.mailbox || 'INBOX')}</td>
              <td>${a.enabled ? '<span class="badge badge-success">监听中</span>' : '<span class="badge badge-paused">未开启</span>'}</td>
              <td style="font-size:11.5px;color:var(--text-faint)">${a.lastCheckAt ? MM.esc(MM.fmtDate(a.lastCheckAt, true)) : '—'}</td>
              <td class="num">${a.lastFound || 0}</td>
              <td style="font-size:11.5px;color:${a.readiness ? 'var(--warn)' : a.lastError ? 'var(--danger)' : 'var(--text-faint)'}">
                ${MM.esc(a.readiness || a.lastError || '配置完整，可正常监听')}
              </td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-sm" data-act="check-one" data-id="${a.id}">检查该账号</button>
                  <button class="btn btn-sm btn-ghost" data-act="test" data-id="${a.id}">测试连接</button>
                  <button class="btn btn-sm btn-ghost" data-act="goto-account">去配置</button>
                </div>
              </td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
  }

  function eventsTable(events) {
    if (!events.items.length) {
      return `<div class="empty"><strong>还没有退信记录</strong>退信监听每轮会扫描发信账号收件箱中的投递失败报告（DSN），命中后自动登记在这里。</div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>时间</th><th>发信账号</th><th>收件人</th><th>归类</th><th>状态码</th>
        <th>诊断信息</th><th>关联任务</th><th>匹配情况</th><th style="width:130px"></th>
      </tr></thead>
      <tbody>
        ${events.items
          .map((e) => {
            const diag = e.diagnostic || e.reason || '';
            return `<tr data-ev="${e.id}">
              <td class="mono" style="font-size:11.5px;white-space:nowrap">${MM.esc(MM.fmtDate(e.createdAt, true))}</td>
              <td class="mono" style="font-size:11.5px">${MM.esc(e.accountEmail || '—')}</td>
              <td>
                <span class="cell-strong mono" style="font-size:11.5px">${MM.esc(e.email || '—')}</span>
                <span class="cell-sub">${MM.esc([e.company, e.contactName].filter(Boolean).join(' · ') || '未匹配到联系人')}</span>
              </td>
              <td>${typeBadge(e.type)}</td>
              <td class="mono" style="font-size:11.5px">${MM.esc(e.status || '—')}</td>
              <td style="max-width:280px;font-size:11.5px;color:var(--text-faint)" title="${MM.attr(diag)}">${MM.esc(diag.slice(0, 90) || '—')}</td>
              <td style="font-size:11.5px;color:var(--text-faint)">${MM.esc(e.campaignName || '—')}</td>
              <td>${
                e.matched
                  ? '<span class="badge badge-success">已匹配联系人</span>'
                  : '<span class="badge badge-pending" title="报告里的地址不在当前邮件列表中，未做任何标记">未匹配</span>'
              }</td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-sm btn-ghost" data-act="view-event" data-id="${e.id}">详情</button>
                  ${
                    e.matched && e.contactId
                      ? `<button class="btn btn-sm" data-act="release-contact" data-id="${e.contactId}" data-email="${MM.attr(e.email)}">解除标记</button>`
                      : ''
                  }
                </div>
              </td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table></div>`;
  }

  function markedTable(list) {
    if (!list.length) {
      return `<div class="empty" style="padding:20px"><strong>当前没有被标记为退信的地址</strong>被标记的地址会从所有推广任务的发送列表中自动剔除，直到手动解除。</div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>公司名 / 联系人</th><th>邮件地址</th><th>退信类型</th><th>状态码</th><th>来源</th>
        <th>标记时间</th><th>原因 / 诊断</th><th style="width:120px"></th>
      </tr></thead>
      <tbody>
        ${list
          .map((c) => {
            const info = c.bounceInfo || {};
            return `<tr data-id="${c.id}">
              <td><span class="cell-strong">${MM.esc(c.company || '—')}</span><span class="cell-sub">${MM.esc(c.contact || '')}</span></td>
              <td class="mono" style="font-size:11.5px">${MM.esc(c.email)}</td>
              <td>${typeBadge(info.type)}</td>
              <td class="mono" style="font-size:11.5px">${MM.esc(info.status || '—')}</td>
              <td style="font-size:11.5px;color:var(--text-faint)">${MM.esc(info.source === 'manual' ? '人工标记' : 'IMAP 自动监听')}</td>
              <td style="font-size:11.5px;color:var(--text-faint)">${info.at ? MM.esc(MM.fmtDate(info.at, true)) : '—'}</td>
              <td style="max-width:260px;font-size:11.5px;color:var(--text-faint)" title="${MM.attr(info.diagnostic || info.reason || '')}">
                ${MM.esc((info.reason || info.diagnostic || '—').slice(0, 80))}
              </td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-sm btn-primary" data-act="release" data-id="${c.id}">解除标记</button>
                </div>
              </td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table></div>`;
  }

  MM.pages.bounce = {
    title: '退信监听',

    async render(view) {
      const data = await loadAll();
      const bs = data.bs;
      const last = bs.lastCheckAt || null;
      const summary = bs.lastSummary || null;

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            通过 IMAP 定时扫描发信邮箱收件箱中的<b>投递失败报告（退信 / DSN）</b>，自动识别收件人地址、归类硬退信与临时退信，
            并<b>把退信地址从后续所有推广的发送列表中剔除</b>——直到你在这里手动解除标记为止。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="goto-accounts">配置 IMAP 账号</button>
            <button class="btn btn-primary" data-act="check">立即检查退信</button>
          </div>
        </div>

        ${
          !bs.enabledAccountCount
            ? `<div class="callout warn">目前没有任何账号开启 IMAP 退信监听，自动检查不会产生效果。请前往「发信邮箱配置」→ 编辑账号 → 打开「退信监听（IMAP）」并填写 IMAP 服务器、登录名与密码。</div>`
            : bs.autoCheck == null
              ? ''
              : !bs.autoCheck
                ? `<div class="callout">自动轮询当前为<b>关闭</b>状态，只在你点击「立即检查退信」时扫描。可在下方「监听总开关」中开启自动轮询。</div>`
                : `<div class="callout">退信监听运行中：每 <b>${bs.pollMinutes}</b> 分钟自动检查一次，覆盖 <b>${bs.enabledAccountCount}</b> 个账号。下次检查由后台定时器触发，关闭窗口后仍会继续。</div>`
        }

        ${
          summary && !summary.skipped
            ? `<div class="callout ${summary.errors && summary.errors.length ? 'warn' : ''}">
                 最近一次检查（${MM.esc(MM.fmtDate(summary.checkedAt, true))} · ${MM.esc(summary.reason === 'auto' ? '自动轮询' : summary.reason === 'startup' ? '启动时检查' : '手动触发')}）：
                 扫描 <b>${summary.scanned || 0}</b> 封邮件，识别退信 <b>${summary.bounced || 0}</b> 条，新标记地址 <b>${summary.marked || 0}</b> 个。
                 ${summary.errors && summary.errors.length ? `<br/>${summary.errors.map((e) => `${MM.esc(e.account)}：${MM.esc(e.message)}`).join('<br/>')}` : ''}
               </div>`
            : ''
        }

        <div class="cards c4">
          ${MM.statCard({
            label: '监听状态',
            value: bs.enabledAccountCount ? (bs.autoCheck ? '运行中' : '仅手动') : '未启用',
            sub: `${bs.enabledAccountCount || 0} 个账号已开启 IMAP · 每 ${bs.pollMinutes || 5} 分钟`,
            tone: bs.enabledAccountCount ? 's-success' : 's-warn',
          })}
          ${MM.statCard({ label: '已标记退信地址', value: bs.markedCount || 0, sub: '已从推广发送列表中剔除', tone: bs.markedCount ? 's-danger' : '' })}
          ${MM.statCard({ label: '退信事件总数', value: bs.eventCount || 0, sub: 'IMAP 监听累计识别到的退信', tone: 's-warn' })}
          ${MM.statCard({
            label: '上次检查时间',
            value: last ? `<span class="mono" style="font-size:17px">${MM.esc(MM.fmtDate(last, true).slice(5))}</span>` : '—',
            sub: last ? MM.esc(MM.fmtRelative(last)) : '尚未执行过检查',
            tone: 's-info',
          })}
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">监听总开关 <span class="hint">影响所有账号的自动轮询</span></div>
            <button class="btn btn-sm" data-act="save-options">保存监听设置</button>
          </div>
          <div class="panel-body">
            <div class="form-grid c4">
              <div class="field">
                <label class="switch"><input type="checkbox" data-role="autoCheck" ${bs.autoCheck !== false ? 'checked' : ''} /><span class="track"></span>开启自动轮询</label>
                <div class="field-hint">关闭后只在你手动点击时检查</div>
              </div>
              <div class="field">
                <label class="field-label">轮询间隔（分钟）</label>
                <input class="input" type="number" min="1" max="1440" data-role="pollMinutes" value="${MM.attr(bs.pollMinutes || 5)}" />
                <div class="field-hint">建议 5～30 分钟；过于频繁会持续登录邮箱</div>
              </div>
              <div class="field">
                <label class="switch"><input type="checkbox" data-role="autoMark" ${bs.autoMarkBounce !== false ? 'checked' : ''} /><span class="track"></span>自动标记退信地址</label>
                <div class="field-hint">关闭后仅登记退信事件，不自动剔除地址</div>
              </div>
              <div class="field">
                <label class="field-label">自动标记的退信类型</label>
                <select class="select" data-role="bounceType">
                  <option value="hard" ${bs.minType !== 'all' ? 'selected' : ''}>仅硬退信 / 被拒收（推荐）</option>
                  <option value="all" ${bs.minType === 'all' ? 'selected' : ''}>所有退信（含临时退信）</option>
                </select>
                <div class="field-hint">临时退信（4.x.x）多为短时限流，建议仅在连续退信时人工处理</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">各账号监听状态 <span class="hint">共 ${(bs.accounts || []).length} 个发信账号</span></div>
          </div>
          <div class="panel-body tight" data-role="accounts">${accountsTable(bs)}</div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">已标记退信的地址 <span class="hint">被剔除的地址不会出现在任何推广的发送列表中</span></div>
            <span class="hint">共 ${data.marked.length} 个</span>
          </div>
          <div class="panel-body tight" data-role="marked">${markedTable(data.marked)}</div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">退信事件明细 <span class="hint" data-role="event-count">共 ${data.events.total} 条</span></div>
            <div class="panel-head-actions">
              <select class="select" data-role="f-account" style="min-width:170px">
                <option value="">全部发信账号</option>
                ${(bs.accounts || []).map((a) => `<option value="${a.id}" ${state.accountId === a.id ? 'selected' : ''}>${MM.esc(a.email)}</option>`).join('')}
              </select>
              <select class="select" data-role="f-type">
                <option value="all" ${state.type === 'all' ? 'selected' : ''}>全部类型</option>
                <option value="hard" ${state.type === 'hard' ? 'selected' : ''}>仅硬退信</option>
                <option value="soft" ${state.type === 'soft' ? 'selected' : ''}>仅临时退信</option>
                <option value="blocked" ${state.type === 'blocked' ? 'selected' : ''}>仅被拒收</option>
              </select>
              <select class="select" data-role="f-matched">
                <option value="all" ${state.matched === 'all' ? 'selected' : ''}>全部匹配情况</option>
                <option value="matched" ${state.matched === 'matched' ? 'selected' : ''}>已匹配联系人</option>
                <option value="unmatched" ${state.matched === 'unmatched' ? 'selected' : ''}>未匹配</option>
              </select>
              <input class="input" data-role="f-keyword" placeholder="搜索地址 / 公司 / 状态码…" value="${MM.attr(state.keyword)}" style="width:200px" />
            </div>
          </div>
          <div class="panel-body tight" data-role="events">${eventsTable(data.events)}</div>
        </div>
      `;

      const rerender = () => MM.renderRoute('bounce');

      view.querySelector('[data-act="goto-accounts"]').onclick = () => MM.navigate('accounts');

      /** 立即检查全部启用监听的账号 */
      view.querySelector('[data-act="check"]').onclick = async (e) => {
        if (!bs.enabledAccountCount) {
          MM.toast('还没有账号开启 IMAP 退信监听，请先前往「发信邮箱配置」开启', 'warn', 7000);
          return;
        }
        const restore = MM.spinBtn(e.target, '检查中');
        const res = await MM.api.checkBounces({ manual: true });
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error', 8000);
          return;
        }
        const d = res.data || {};
        if (d.skipped) {
          MM.toast(d.reason || '已有一次检查正在进行中', 'warn', 6000);
          return;
        }
        MM.toast(
          `检查完成：扫描 ${d.scanned || 0} 封 · 识别退信 ${d.bounced || 0} 条 · 新标记 ${d.marked || 0} 个地址`,
          (d.errors && d.errors.length) ? 'warn' : 'success',
          8000,
        );
        rerender();
      };

      /** 监听总开关 */
      view.querySelector('[data-act="save-options"]').onclick = async (e) => {
        const restore = MM.spinBtn(e.target, '保存中');
        const res = await MM.api.saveSettings({
          imapAutoCheck: view.querySelector('[data-role="autoCheck"]').checked,
          imapPollMinutes: Number(view.querySelector('[data-role="pollMinutes"]').value) || 5,
          imapAutoMarkBounce: view.querySelector('[data-role="autoMark"]').checked,
          imapBounceType: view.querySelector('[data-role="bounceType"]').value,
        });
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        MM.state.settings = res.data;
        MM.toast('退信监听设置已保存', 'success');
        rerender();
      };

      /** 单账号检查 / 测试连接 / 去配置 */
      view.querySelectorAll('[data-acc] [data-act]').forEach((btn) => {
        btn.onclick = async (e) => {
          const act = btn.dataset.act;
          if (act === 'goto-account') {
            MM.navigate('accounts');
            return;
          }
          const restore = MM.spinBtn(e.target, act === 'test' ? '连接中' : '检查中');
          const res = act === 'test' ? await MM.api.testImap({ id: btn.dataset.id }) : await MM.api.checkBounces({ manual: true, accountId: btn.dataset.id });
          restore();
          if (!res.ok) {
            MM.toast(res.error, 'error', 8000);
            return;
          }
          const d = res.data || {};
          if (act === 'test') {
            MM.toast(`${d.ok ? '✓' : '✕'} ${d.message}（${d.durationMs} ms）`, d.ok ? 'success' : 'error', 9000);
            return;
          }
          if (d.skipped) {
            MM.toast(d.reason || '已有一次检查正在进行中', 'warn');
            return;
          }
          MM.toast(`该账号检查完成：扫描 ${d.scanned || 0} 封 · 识别退信 ${d.bounced || 0} 条 · 新标记 ${d.marked || 0} 个`, 'success', 8000);
          rerender();
        };
      });

      const releaseContact = async (btn, id, email) => {
        const yes = await MM.confirm({
          title: '解除退信标记',
          message: `将解除 <b>${MM.esc(email || '该地址')}</b> 的退信标记，该地址会<b>重新进入下一轮推广的发送列表</b>。<br/>若地址确实无效，重新发送会再次产生退信。`,
          confirmText: '解除标记',
        });
        if (!yes) return;
        const restore = MM.spinBtn(btn, '解除中');
        const res = await MM.api.releaseBounce({ id });
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        MM.toast('已解除退信标记，该地址重新进入发送列表', 'success');
        rerender();
      };

      view.querySelectorAll('[data-role="marked"] [data-act="release"]').forEach((btn) => {
        const row = data.marked.find((c) => c.id === btn.dataset.id);
        btn.onclick = () => releaseContact(btn, btn.dataset.id, row && row.email);
      });

      /** 退信事件详情弹窗 */
      const showEvent = (e) => {
        if (!e) return;
        const rows = [
          ['识别时间', MM.fmtDate(e.createdAt, true)],
          ['发信账号', e.accountEmail || '—'],
          ['收件人地址', e.email || '—'],
          ['归类', TYPE_TEXT[e.type] || e.type || '—'],
          ['状态码', e.status || '—'],
          ['退信原因', e.reason || '（邮件中未给出可解析的原因）'],
          ['诊断信息', e.diagnostic || '—'],
          ['原邮件主题', e.subject || '—'],
          ['原邮件 Message-ID', e.originalMessageId || '（退信中未包含）'],
          ['退信报告发件人', e.from || '—'],
          ['报告日期', e.date || '—'],
          ['关联推广任务', e.campaignName || '—'],
          ['匹配到的联系人', e.contactId ? `${e.company || ''} ${e.contactName || ''}`.trim() || e.email : '未匹配'],
          ['邮箱 UID', e.uid != null ? String(e.uid) : '—'],
        ];
        MM.modal({
          title: '退信事件详情',
          size: '',
          body: `<dl class="kv" style="grid-template-columns:150px 1fr">
            ${rows.map(([k, v]) => `<dt>${MM.esc(k)}</dt><dd style="word-break:break-all">${MM.esc(v)}</dd>`).join('')}
          </dl>
          ${
            e.recipients && e.recipients.length > 1
              ? `<div class="field-hint" style="margin-top:10px">该退信报告涉及多个收件人：${e.recipients.map(MM.esc).join('、')}</div>`
              : ''
          }`,
          footer: `<button class="btn" data-modal-close>关闭</button>`,
        });
      };

      /** 事件列表（含重绘后）的行内按钮统一绑定 */
      const bindEventRows = () => {
        view.querySelectorAll('[data-role="events"] [data-act="view-event"]').forEach((btn) => {
          btn.onclick = () => showEvent(data.events.items.find((x) => x.id === btn.dataset.id));
        });
        view.querySelectorAll('[data-role="events"] [data-act="release-contact"]').forEach((btn) => {
          btn.onclick = () => releaseContact(btn, btn.dataset.id, btn.dataset.email);
        });
      };
      bindEventRows();

      /** 事件筛选 */
      let timer = null;
      const filterChange = () => {
        state.accountId = view.querySelector('[data-role="f-account"]').value;
        state.type = view.querySelector('[data-role="f-type"]').value;
        state.matched = view.querySelector('[data-role="f-matched"]').value;
        state.keyword = view.querySelector('[data-role="f-keyword"]').value.trim();
        refreshEvents();
      };
      const refreshEvents = async () => {
        const res = await MM.api.listBounces({ keyword: state.keyword, type: state.type, matched: state.matched, accountId: state.accountId || undefined });
        if (!res.ok) return;
        data.events = res.data;
        view.querySelector('[data-role="events"]').innerHTML = eventsTable(res.data);
        view.querySelector('[data-role="event-count"]').textContent = `共 ${res.data.total} 条`;
        bindEventRows();
      };

      view.querySelector('[data-role="f-account"]').onchange = filterChange;
      view.querySelector('[data-role="f-type"]').onchange = filterChange;
      view.querySelector('[data-role="f-matched"]').onchange = filterChange;
      view.querySelector('[data-role="f-keyword"]').oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(filterChange, 260);
      };
    },

    onEvent(payload) {
      if (!payload) return;
      if (payload.type === 'bounce-event' || payload.type === 'bounce-state') {
        // 新退信或监听状态变化：整页刷新，保证「已标记地址」与事件列表同步
        MM.renderRoute('bounce');
      }
    },
  };
})();
