/* 页面：定时任务管理 */
(function () {
  const MM = window.MM;

  async function load() {
    return MM.loadCampaigns();
  }

  function rowsHtml(campaigns) {
    if (!campaigns.length) {
      return `<div class="empty"><strong>还没有定时推广任务</strong>在「推广任务」页切换到「定时推广任务」即可创建，支持每天 / 每周 / 每月 / 每 N 分钟自动执行。</div>`;
    }
    return `<div class="table-wrap"><table class="table">
      <thead><tr>
        <th>任务名称</th><th>执行计划</th><th>下次执行</th><th>倒计时</th><th>状态</th>
        <th class="num">运行次数</th><th>上次执行</th><th>上次结果</th><th style="width:230px"></th>
      </tr></thead>
      <tbody>
        ${campaigns
          .map((c) => {
            const p = c.progress || {};
            return `<tr data-id="${c.id}">
              <td><span class="cell-strong">${MM.esc(c.name)}</span><span class="cell-sub">${MM.esc((c.description || '').slice(0, 42))}</span></td>
              <td style="font-size:11.5px">${MM.esc(c.scheduleText || '—')}</td>
              <td class="mono" style="font-size:11.5px">${c.nextRunAt ? MM.esc(MM.fmtDate(c.nextRunAt, true)) : '—'}</td>
              <td class="mono" style="font-size:12px;color:#9fd0ff" data-role="cd">${c.nextRunAt ? MM.fmtCountdown(c.nextRunAt).text : '—'}</td>
              <td>${c.running ? `${MM.statusBadge('sending')} <span class="running-dot"></span>` : MM.statusBadge(c.status)}</td>
              <td class="num">${c.runCount || 0}</td>
              <td style="font-size:11.5px;color:var(--text-faint)">${c.lastRunAt ? MM.esc(MM.fmtDate(c.lastRunAt, true)) : '—'}</td>
              <td style="font-size:11.5px">
                ${
                  p.done
                    ? `<span style="color:var(--success)">成功 ${p.success || 0}</span> / <span style="color:var(--danger)">失败 ${p.failed || 0}</span> / <span style="color:var(--warn)">退信 ${p.bounced || 0}</span>`
                    : '—'
                }
              </td>
              <td>
                <div class="row-actions">
                  <button class="btn btn-sm ${c.status === 'active' ? '' : 'btn-primary'}" data-act="toggle">${c.status === 'active' ? '停用' : '启用'}</button>
                  <button class="btn btn-sm" data-act="run">立即执行</button>
                  <button class="btn btn-sm btn-ghost" data-act="schedule">执行计划</button>
                  <button class="btn btn-sm btn-danger" data-act="remove">删除</button>
                </div>
              </td>
            </tr>`;
          })
          .join('')}
      </tbody>
    </table></div>`;
  }

  MM.pages.tasks = {
    title: '定时任务管理',

    async render(view) {
      const campaigns = await load();
      const scheduled = campaigns.filter((c) => c.kind === 'scheduled' || c.schedule.type !== 'manual');
      const active = scheduled.filter((c) => c.status === 'active');
      const overview = await MM.loadOverview();
      const next = scheduled
        .filter((c) => c.nextRunAt)
        .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];

      view.innerHTML = `
        <div class="page-head">
          <div class="page-desc">
            调度器每秒检查一次任务计划，到点自动启动推广。应用关闭窗口后仍驻留系统托盘继续执行；同一任务不会并发重复执行。
          </div>
          <div class="page-actions">
            <button class="btn" data-act="recalc">重新计算执行时间</button>
            <button class="btn" data-act="goto-campaigns">前往创建任务</button>
          </div>
        </div>

        <div class="cards c4">
          ${MM.statCard({ label: '定时任务总数', value: scheduled.length, sub: `其中启用中 ${active.length} 个` })}
          ${MM.statCard({ label: '启用中任务', value: active.length, sub: '到点将自动执行' , tone: 's-info' })}
          ${MM.statCard({
            label: '下次启动推广倒计时',
            value: `<span class="mono" id="tasks-cd" style="font-size:22px;color:#9fd0ff">${MM.fmtCountdown(next && next.nextRunAt).text}</span>`,
            sub: next ? MM.esc(next.name) : '暂无启用中的定时任务',
            tone: 's-success',
          })}
          ${MM.statCard({ label: '累计任务运行次数', value: overview ? overview.totalRuns : 0, sub: '含手动触发与定时触发' })}
        </div>

        ${
          active.length === 0
            ? `<div class="callout warn">当前没有启用中的定时任务，推广不会自动执行。可在下方点击「启用」或在「推广任务」页创建新的定时任务。</div>`
            : `<div class="callout">下次自动推广：<b>${next ? MM.esc(MM.fmtDate(next.nextRunAt, true)) : '—'}</b>${next ? `（任务「${MM.esc(next.name)}」）` : ''}</div>`
        }

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">定时推广任务列表 <span class="hint">共 ${scheduled.length} 个</span></div>
          </div>
          <div class="panel-body tight">${rowsHtml(scheduled)}</div>
        </div>
      `;

      const rerender = () => MM.renderRoute('tasks');

      // 倒计时逐秒刷新
      MM.addTimer(() => {
        const list = MM.state.campaigns.filter((c) => c.nextRunAt);
        view.querySelectorAll('tr[data-id]').forEach((tr) => {
          const c = list.find((x) => x.id === tr.dataset.id);
          const cdEl = tr.querySelector('[data-role="cd"]');
          if (c && cdEl) cdEl.textContent = MM.fmtCountdown(c.nextRunAt).text;
        });
        const big = view.querySelector('#tasks-cd');
        if (big) {
          const n = MM.state.campaigns
            .filter((c) => c.status === 'active' && c.nextRunAt)
            .sort((a, b) => new Date(a.nextRunAt) - new Date(b.nextRunAt))[0];
          big.textContent = n ? MM.fmtCountdown(n.nextRunAt).text : '--:--:--';
        }
      }, 1000);

      view.querySelector('[data-act="recalc"]').onclick = async (e) => {
        const restore = MM.spinBtn(e.target, '计算中');
        await MM.api.recalcSchedule();
        restore();
        MM.toast('已按当前计划重新计算所有任务的下次执行时间', 'success');
        rerender();
      };
      view.querySelector('[data-act="goto-campaigns"]').onclick = () => MM.navigate('campaigns');

      view.querySelectorAll('tr[data-id]').forEach((tr) => {
        const id = tr.dataset.id;
        const campaign = () => MM.state.campaigns.find((c) => c.id === id);
        tr.querySelectorAll('[data-act]').forEach((btn) => {
          btn.onclick = async (e) => {
            const c = campaign();
            const act = btn.dataset.act;

            if (act === 'toggle') {
              const paused = c.status === 'active';
              const res = await MM.api.pauseCampaign({ id, paused });
              if (!res.ok) {
                MM.toast(res.error, 'error');
                return;
              }
              MM.toast(paused ? '已停用该定时任务' : '已启用该定时任务，将按计划自动执行', 'success');
              rerender();
            }

            if (act === 'run') {
              const dry = MM.effectiveDryRun(c);
              const okConfirm = await MM.confirm({
                title: '立即执行一次',
                message: `任务「<b>${MM.esc(c.name)}</b>」将立即按当前受众范围执行一次。<br/>发送模式：<b style="color:${dry ? 'var(--warn)' : 'var(--danger)'}">${dry ? '试运行（不会真正发出）' : '真实发送'}</b>。`,
                confirmText: '立即执行',
                danger: !dry,
              });
              if (!okConfirm) return;
              const restore = MM.spinBtn(btn, '启动中');
              const res = await MM.api.runCampaign({ id, activate: false });
              restore();
              if (!res.ok) {
                MM.toast(res.error, 'error', 6000);
                return;
              }
              MM.toast('任务已开始执行', 'success');
              setTimeout(rerender, 800);
            }

            if (act === 'schedule') {
              const res = await MM.api.campaignNextRuns(id);
              const times = res.ok ? res.data : [];
              MM.modal({
                title: `「${c.name}」未来执行计划`,
                size: 'narrow',
                body: `
                  <div class="field"><label class="field-label">当前规则</label><div>${MM.esc(c.scheduleText || '—')}</div></div>
                  <div class="field"><label class="field-label">预计接下来的执行时间</label>
                    <div class="list-plain">
                      ${times.length ? times.map((t) => `<div class="list-row"><div class="grow"><div class="title mono">${MM.esc(MM.fmtDate(t, true))}</div><div class="sub">${MM.esc(MM.fmtRelative(t).replace('前', '后'))}</div></div></div>`).join('') : '<div class="empty" style="padding:12px">该任务不会自动执行（仅手动触发）</div>'}
                    </div>
                  </div>`,
                footer: `<button class="btn" data-modal-close>关闭</button>`,
              });
            }

            if (act === 'remove') {
              const yes = await MM.confirm({
                title: '删除定时任务',
                message: `确定删除「<b>${MM.esc(c.name)}</b>」吗？删除后将不再自动执行。`,
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
      if (payload.type === 'campaign') MM.loadCampaigns();
      if (payload.type === 'overview-dirty' || payload.type === 'campaign') {
        if (MM.state.route === 'tasks' && payload.type === 'campaign' && !payload.campaign.running) {
          setTimeout(() => MM.renderRoute('tasks'), 500);
        }
      }
    },
  };
})();
