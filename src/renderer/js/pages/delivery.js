/* 页面：投递状态跟踪 */
(function () {
  const MM = window.MM;

  const state = {
    campaignId: '',
    status: 'all',
    keyword: '',
    offset: 0,
    limit: 50,
    total: 0,
    items: [],
  };

  function statsFromItems(items) {
    return items.reduce(
      (acc, l) => {
        acc[l.status] = (acc[l.status] || 0) + 1;
        return acc;
      },
      { success: 0, failed: 0, bounced: 0, pending: 0, sending: 0 },
    );
  }

  function rowsHtml(items) {
    if (!items.length) {
      return `<div class="empty"><strong>暂无投递记录</strong>执行一次推广任务后，这里会显示每一封邮件的投递结果。</div>`;
    }
    return items
      .map(
        (l) => `<tr data-id="${l.id}">
          <td class="mono" style="font-size:11.5px;white-space:nowrap">${MM.esc(MM.fmtDate(l.createdAt, true))}</td>
          <td style="font-size:11.5px">${MM.esc(l.campaignName || '—')}${l.dryRun ? '<span class="cell-sub">试运行</span>' : ''}</td>
          <td style="font-size:11.5px" class="mono">${MM.esc(l.accountEmail || '—')}</td>
          <td><span class="cell-strong">${MM.esc(l.company || '—')}</span><span class="cell-sub">${MM.esc(l.contact || '')}${l.salutation ? ` · ${MM.esc(l.salutation)}` : ''}</span></td>
          <td class="mono" style="font-size:11.5px">${MM.esc(l.email)}</td>
          <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${MM.attr(l.subject)}">${MM.esc(l.subject || '—')}</td>
          <td>${MM.statusBadge(l.status)}</td>
          <td class="num">${l.attempts || 1}</td>
          <td class="num" style="font-size:11.5px;color:var(--text-faint)">${MM.esc(MM.fmtDuration(l.durationMs))}</td>
          <td style="max-width:250px;font-size:11.5px;color:${l.status === 'success' ? 'var(--text-faint)' : 'var(--warn)'}">${MM.esc(l.error || '—')}</td>
          <td>
            <div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-act="view">邮件内容</button>
              ${l.status === 'failed' || l.status === 'bounced' ? '<button class="btn btn-sm" data-act="resend">重发</button>' : ''}
            </div>
          </td>
        </tr>`,
      )
      .join('');
  }

  MM.pages.delivery = {
    title: '投递状态跟踪',

    async render(view) {
      const campaigns = await MM.loadCampaigns();
      state.offset = 0;
      state.items = [];

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            每一封推广邮件的投递结果都会在这里留痕：成功、失败（含原因）与硬退信。SMTP 即时返回的退信会打上标记并停用该地址；
            服务器事后回执的退信由「退信监听」通过 IMAP 扫描收件箱自动识别，同样会从后续推广的发送列表中剔除。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="goto-bounce">退信监听</button>
            <button class="btn" data-act="retry-failed">重发本次失败项</button>
            <button class="btn" data-act="export">导出记录 CSV</button>
          </div>
        </div>

        <div class="cards c4" data-role="stats">
          ${MM.statCard({ label: '成功', value: 0, sub: '筛选结果内', tone: 's-success' })}
          ${MM.statCard({ label: '失败', value: 0, sub: '含临时性失败', tone: 's-danger' })}
          ${MM.statCard({ label: '退信', value: 0, sub: '地址不存在/被拒收', tone: 's-warn' })}
          ${MM.statCard({ label: '记录总数', value: 0, sub: '当前筛选条件', tone: 's-info' })}
        </div>

        <div class="toolbar">
          <select class="select" data-role="campaign">
            <option value="">全部推广任务</option>
            ${campaigns.map((c) => `<option value="${c.id}">${MM.esc(c.name)}</option>`).join('')}
          </select>
          <select class="select" data-role="status">
            <option value="all">全部状态</option>
            <option value="success">仅成功</option>
            <option value="failed">仅失败</option>
            <option value="bounced">仅退信</option>
          </select>
          <input class="input grow" data-role="keyword" placeholder="搜索公司名 / 联系人 / 邮箱 / 主题 / 失败原因…" />
          <div class="spacer"></div>
          <button class="btn btn-sm" data-act="refresh">刷新</button>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">投递明细 <span class="hint" data-role="count"></span></div>
          </div>
          <div class="panel-body tight" data-role="table"></div>
        </div>
        <div style="text-align:center;padding-bottom:20px"><button class="btn hidden" data-act="more">加载更多</button></div>
      `;

      const table = view.querySelector('[data-role="table"]');
      const moreBtn = view.querySelector('[data-act="more"]');
      const countEl = view.querySelector('[data-role="count"]');

      const updateStats = () => {
        const s = statsFromItems(state.items);
        const cards = view.querySelectorAll('[data-role="stats"] .stat-value');
        cards[0].textContent = MM.fmtNumber(s.success || 0);
        cards[1].textContent = MM.fmtNumber(s.failed || 0);
        cards[2].textContent = MM.fmtNumber(s.bounced || 0);
        cards[3].textContent = MM.fmtNumber(state.total || 0);
      };

      const fetchPage = async (append) => {
        const res = await MM.api.listLogs({
          campaignId: state.campaignId || undefined,
          status: state.status,
          keyword: state.keyword,
          offset: state.offset,
          limit: state.limit,
        });
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        const d = res.data;
        state.total = d.total;
        state.items = append ? state.items.concat(d.items) : d.items;
        table.innerHTML = `
          <div class="table-wrap"><table class="table">
            <thead><tr>
              <th>时间</th><th>推广任务</th><th>发信邮箱</th><th>公司名 / 联系人</th><th>邮件地址</th><th>主题</th>
              <th>状态</th><th class="num">尝试</th><th class="num">耗时</th><th>说明 / 失败原因</th><th style="width:150px"></th>
            </tr></thead>
            <tbody>${rowsHtml(state.items)}</tbody>
          </table></div>`;
        countEl.textContent = `共 ${d.total} 条，已显示 ${state.items.length} 条`;
        moreBtn.classList.toggle('hidden', state.items.length >= d.total);
        updateStats();
        bindRows();
      };

      const bindRows = () => {
        table.querySelectorAll('tr[data-id]').forEach((tr) => {
          const log = state.items.find((x) => x.id === tr.dataset.id);
          tr.querySelectorAll('[data-act]').forEach((btn) => {
            btn.onclick = async (e) => {
              if (btn.dataset.act === 'view') {
                const campaign = MM.state.campaigns.find((c) => c.id === log.campaignId);
                const res = await MM.api.logMailPreview({ id: log.id, templateId: campaign && campaign.templateId });
                if (!res.ok) {
                  MM.toast(res.error, 'error');
                  return;
                }
                const m = res.data;
                MM.modal({
                  title: `该次投递的邮件内容（${log.email}）`,
                  size: 'wide',
                  body: `
                    <div class="pill-row" style="margin-bottom:12px">
                      <span class="pill">状态 <b>${MM.esc(MM.STATUS_TEXT[log.status] || log.status)}</b></span>
                      <span class="pill">发信邮箱 <b>${MM.esc(log.accountEmail || '—')}</b></span>
                      <span class="pill">时间 <b>${MM.esc(MM.fmtDate(log.createdAt, true))}</b></span>
                      <span class="pill">尝试 <b>${log.attempts || 1}</b> 次</span>
                      <span class="pill">耗时 <b>${MM.esc(MM.fmtDuration(log.durationMs))}</b></span>
                      ${log.error ? `<span class="pill">说明 <b style="color:var(--warn)">${MM.esc(log.error)}</b></span>` : ''}
                    </div>
                    <div class="mail-preview">
                      <div class="mail-subject">${MM.esc(m.subject)}</div>${MM.esc(m.text)}
                    </div>`,
                  footer: `
                    <button class="btn" data-modal-close>关闭</button>
                    <button class="btn btn-primary" data-act="open-window">独立窗口预览</button>`,
                  onMount: (ctx) => {
                    ctx.$('[data-act="open-window"]').onclick = () => {
                      MM.openMailPreviewWindow({
                        templateName: campaign ? campaign.name : '',
                        subject: m.subject || '',
                        body: m.text || '',
                        missing: m.missing || [],
                        contact: m.contact || { company: log.company || '', contact: log.contact || '', email: log.email || '' },
                        from: m.account
                          ? { name: m.account.fromName || m.account.name || '', email: m.account.email || '' }
                          : { name: '', email: log.accountEmail || '' },
                        at: log.createdAt,
                        source: 'delivery',
                      });
                    };
                  },
                });
                return;
              }

              if (btn.dataset.act === 'resend') {
                const dry = MM.effectiveDryRun({ dryRun: log.dryRun });
                const yes = await MM.confirm({
                  title: '重新发送该邮件',
                  message: `将向 <b>${MM.esc(log.email)}</b> 重新投递一次，使用该任务当前关联的模板。<br/>发送模式：<b>${dry ? '试运行' : '真实发送'}</b>`,
                  confirmText: '重新发送',
                  danger: !dry,
                });
                if (!yes) return;
                const restore = MM.spinBtn(btn, '发送中');
                const res = await MM.api.resendLog({ id: log.id });
                restore();
                if (!res.ok) {
                  MM.toast(res.error, 'error', 6000);
                  return;
                }
                MM.toast(`已重新投递：${MM.STATUS_TEXT[res.data.status] || res.data.status}`, res.data.status === 'success' ? 'success' : 'warn');
                fetchPage(false);
              }
            };
          });
        });
      };

      view.querySelector('[data-role="campaign"]').onchange = (e) => {
        state.campaignId = e.target.value;
        state.offset = 0;
        fetchPage(false);
      };
      view.querySelector('[data-role="status"]').onchange = (e) => {
        state.status = e.target.value;
        state.offset = 0;
        fetchPage(false);
      };
      let timer = null;
      view.querySelector('[data-role="keyword"]').oninput = (e) => {
        state.keyword = e.target.value;
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.offset = 0;
          fetchPage(false);
        }, 260);
      };
      view.querySelector('[data-act="refresh"]').onclick = () => {
        state.offset = 0;
        fetchPage(false);
        MM.toast('已刷新投递记录', 'success');
      };
      moreBtn.onclick = () => {
        state.offset = state.items.length;
        fetchPage(true);
      };

      view.querySelector('[data-act="goto-bounce"]').onclick = () => MM.navigate('bounce');

      view.querySelector('[data-act="export"]').onclick = async (e) => {
        const restore = MM.spinBtn(e.target, '导出中');
        const res = await MM.api.exportLogsCsv({
          campaignId: state.campaignId || undefined,
          status: state.status,
          keyword: state.keyword,
        });
        restore();
        if (!res.ok) {
          MM.toast(res.error, 'error');
          return;
        }
        if (res.data && res.data.canceled) return;
        MM.toast(`已导出到：${res.data.filePath}`, 'success');
      };

      view.querySelector('[data-act="retry-failed"]').onclick = async () => {
        const target =
          MM.state.campaigns.find((c) => c.id === state.campaignId) ||
          MM.state.campaigns.find((c) => c.status !== 'finished') ||
          MM.state.campaigns[0];
        if (!target) {
          MM.toast('暂无可重发的任务', 'warn');
          return;
        }
        const yes = await MM.confirm({
          title: '重发失败项',
          message: `将对任务「<b>${MM.esc(target.name)}</b>」中历史失败与退信的联系人重新投递。退信地址默认已停用，会被自动排除。`,
          confirmText: '开始重发',
        });
        if (!yes) return;
        const res = await MM.api.runCampaign({ id: target.id, onlyFailed: true });
        if (!res.ok) {
          MM.toast(res.error, 'error', 6000);
          return;
        }
        MM.toast('重发任务已启动，请关注进度', 'success');
        setTimeout(() => fetchPage(false), 1500);
      };

      await fetchPage(false);
    },

    onEvent(payload) {
      if (payload.type === 'log' && MM.state.route === 'delivery') {
        // 追加到当前列表顶部（不打断滚动位置）
        const table = document.querySelector('#view [data-role="table"] tbody');
        if (!table) return;
        state.items.unshift(payload.log);
        table.insertAdjacentHTML('afterbegin', rowsHtml([payload.log]));
      }
    },
  };
})();
